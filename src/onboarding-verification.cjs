'use strict';
const {id,now,redact}=require('./util.cjs');

// One controller-owned check belongs to the person, not to a room or a process.
// Reopening progress, retrying setup and restarting AO only inspect this same
// durable message. Delivery/recovery remains the ordinary adapter's job.
class OnboardingVerification {
  constructor(service,options={}){
    this.service=service;this.db=service.store.db;this.options=options;
    this.db.exec(`CREATE TABLE IF NOT EXISTS onboarding_reply_verifications(
      member_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,room_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,nonce TEXT NOT NULL,status TEXT NOT NULL,
      reply_id TEXT,error TEXT,deadline TEXT NOT NULL,verified_at TEXT,
      created TEXT NOT NULL,updated TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS onboarding_verification_history(message_id TEXT PRIMARY KEY,member_id TEXT NOT NULL,record TEXT NOT NULL,created TEXT NOT NULL)');
  }
  row(memberId){return this.db.prepare('SELECT * FROM onboarding_reply_verifications WHERE member_id=?').get(memberId)||null;}
  hasTable(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  evidence(memberId,messageId){
    if(!this.hasTable('connection_session_evidence'))return null;
    return this.db.prepare(`SELECT native_session_id,model_message_id,model_reply_verified_at FROM connection_session_evidence
      WHERE member_id=? AND model_message_id=? AND model_reply_verified_at IS NOT NULL
      AND native_session_id IS NOT NULL AND executor_kind IN ('managed_cli','desktop') LIMIT 1`).get(memberId,messageId)||null;
  }
  existingProof(memberId){
    if(!this.hasTable('connection_session_evidence'))return null;
    const state=this.service.runtime.connectionState?.(memberId),current=new Set((state?.sessions||[]).filter(session=>session.automatic_reply_verified===true).map(session=>session.model?.message_id));
    if(!state?.automatic_reply_verified||!current.size)return null;
    return this.db.prepare(`SELECT e.model_message_id AS message_id,r.id AS reply_id FROM connection_session_evidence e
      JOIN chat_messages m ON m.id=e.model_message_id AND m.to_member_id=e.member_id AND m.status='answered'
      JOIN chat_messages r ON r.reply_to=m.id AND r.room_id=m.room_id AND r.sender_id=e.member_id AND r.kind='reply' AND length(trim(r.text))>0
      WHERE e.member_id=? AND e.model_reply_verified_at IS NOT NULL AND e.native_session_id IS NOT NULL
      AND e.executor_kind IN ('managed_cli','desktop') AND NOT EXISTS(SELECT 1 FROM onboarding_verification_history h WHERE h.message_id=e.model_message_id)
      ORDER BY e.updated DESC`).all(memberId).find(proof=>current.has(proof.message_id))||null;
  }
  view(row){
    return row?{status:row.status,message_id:row.message_id,reply_id:row.reply_id,verified_at:row.verified_at,
      error:row.error?redact(row.error).slice(0,1000):null,deadline:row.deadline}:null;
  }
  dispatchState(row,message){
    const native=this.hasTable('desktop_message_runs')?this.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(row.message_id):null;
    if(native)return ['completed','failed','cancelled'].includes(native.status)?'terminal':'uncertain';
    if(this.service.chat.active?.get(row.member_id)?.messageId===row.message_id)return 'uncertain';
    if(message?.status==='queued'&&!message.request_id)return 'unsent';
    if(this.service.chat.roomDeleted?.(row.room_id)&&message?.status==='cancelled'&&message.request_id)return 'uncertain';
    return ['failed','cancelled','answered','completed'].includes(message?.status)?'terminal':'uncertain';
  }
  retryFailed(memberId,allowVerified=false){
    const row=this.row(memberId);if(row?.status!=='failed'&&!(allowVerified&&row?.status==='verified'))return false;
    const message=this.db.prepare('SELECT status FROM chat_messages WHERE id=?').get(row.message_id);
    // Only an explicit retry of a confirmed terminal check can spend a new
    // model turn. Timeouts, interrupted work and unknown results stay owned by
    // the original request, including across a restart.
    const fullMessage=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.message_id);
    if(!['failed','cancelled','answered','completed'].includes(message?.status)||this.dispatchState(row,fullMessage)!=='terminal')return false;
    this.service.chat.store.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO onboarding_verification_history VALUES(?,?,?,?)').run(row.message_id,row.member_id,JSON.stringify(row),now());
      this.db.prepare('DELETE FROM onboarding_reply_verifications WHERE member_id=? AND message_id=?').run(memberId,row.message_id);
    });return true;
  }
  begin(run,member){
    let previous=this.row(member.id);
    if(previous&&previous.room_id!==run.room_id&&(this.service.chat.roomDeleted?.(previous.room_id)||!this.service.chat.store.joined(previous.room_id,member.id))){
      const original=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(previous.message_id);
      if(previous.status!=='verified'&&this.dispatchState(previous,original)==='unsent'){
        this.db.prepare("UPDATE chat_messages SET status='cancelled',error='尚未派发的连接验证已随原房间退出而结束。',updated=? WHERE id=? AND status='queued'").run(now(),original.id);
        this.db.prepare("UPDATE onboarding_reply_verifications SET status='failed',error='原房间的未派发验证已结束。',updated=? WHERE member_id=?").run(now(),member.id);
        this.retryFailed(member.id);previous=this.row(member.id);
      }else if(previous.status==='failed'&&this.retryFailed(member.id))previous=null;
    }
    if(previous)return this.view(previous);
    const stamp=now(),proof=this.existingProof(member.id),nonce=`AO-CONNECT-${id()}`;
    const row={member_id:member.id,run_id:run.id,room_id:run.room_id,message_id:proof?.message_id||'',nonce,
      status:proof?'verified':'waiting',reply_id:proof?.reply_id||null,error:null,
      deadline:new Date(Date.now()+(this.options.timeoutMs||45000)).toISOString(),verified_at:proof?stamp:null,created:stamp,updated:stamp};
    this.service.chat.store.transaction(()=>{
      // A second controller/run for the same person cannot create another turn.
      if(this.row(member.id))return;
      if(!proof){
        const message=this.service.chat.store.post({room_id:run.room_id,sender_id:'user',to_member_id:member.id,
          kind:'message',idempotency_key:`onboarding-verification:${member.id}:${nonce}`,
          text:`这是 Agent Office 的一次自动连接验证，不是业务任务。不读取文件，不调用其他工具，不执行其他操作。请只回复这一行：${nonce}`});
        row.message_id=message.id;
      }
      this.db.prepare(`INSERT INTO onboarding_reply_verifications(member_id,run_id,room_id,message_id,nonce,status,reply_id,error,deadline,verified_at,created,updated)
        VALUES(:member_id,:run_id,:room_id,:message_id,:nonce,:status,:reply_id,:error,:deadline,:verified_at,:created,:updated)`).run(row);
    });
    const saved=this.row(member.id);
    if(saved?.run_id!==row.run_id||saved.message_id!==row.message_id||proof)return this.view(saved);
    try{
      // Persist first, then use the same native executor as a normal message.
      // No human-setup flag is supplied, so this check cannot install agents.
      const pending=this.service.chat.adapter(member).message(this.service.chat.store.message(saved.message_id));
      pending?.catch?.(error=>this.dispatchFailed(saved,error));
    }catch(error){this.dispatchFailed(saved,error);}
    return this.view(this.row(member.id));
  }
  dispatchFailed(row,error){
    const message=this.db.prepare('SELECT status FROM chat_messages WHERE id=?').get(row.message_id);
    if(message?.status==='queued')this.service.chat.store.updateMessage(row.message_id,{status:'failed',error:'自动连接验证未能派发；没有重新提交。'});
    this.db.prepare("UPDATE onboarding_reply_verifications SET status='uncertain',error=?,updated=? WHERE member_id=? AND status<>'verified'")
      .run(redact(error?.message||'自动连接验证结果待核对；没有重新提交。').slice(0,1000),now(),row.member_id);
    this.service.changed();
  }
  refresh(){
    for(const row of this.db.prepare("SELECT * FROM onboarding_reply_verifications WHERE status<>'verified'").all()){
      const message=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.message_id);
      if(!message)continue;
      const replies=this.db.prepare("SELECT id,text FROM chat_messages WHERE room_id=? AND reply_to=? AND sender_id=? AND kind='reply' ORDER BY seq")
        .all(row.room_id,row.message_id,row.member_id);
      const correct=replies.find(reply=>reply.text.trim().replace(/^`+|`+$/g,'')===row.nonce);
      let status=row.status,error=row.error,replyId=row.reply_id,verifiedAt=null;
      if(message.to_member_id===row.member_id&&message.status==='answered'&&correct&&this.evidence(row.member_id,row.message_id)){
        status='verified';error=null;replyId=correct.id;verifiedAt=now();
      }else if(message.status==='answered'&&replies.length&&!correct){status='failed';error='已收到回复，但自动验证标识不匹配；没有重复提问。';}
      else if(message.status==='answered'&&correct&&Date.now()>=Date.parse(row.deadline)){status='waiting_result';error='收到了回复，但尚无这次原生执行的关联证据；保留原请求，没有重发。';}
      else if(['failed','cancelled','completed'].includes(message.status)){
        status=this.dispatchState(row,message)==='uncertain'?'uncertain':'failed';
        error=status==='uncertain'?'原验证已停止等待，原生结果仍需核对；保留人物连接，没有重发。':message.error||'自动连接验证未完成；保留原请求，没有重发。';
      }
      else if(message.status==='uncertain'){status='uncertain';error=message.error||'正在核对原生验证结果，没有重新提交。';}
      else if(Date.now()>=Date.parse(row.deadline)){status='waiting_result';error='自动连接验证仍在等待原回答；已有连接保留，没有重新提交。';}
      if(status!==row.status||error!==row.error||replyId!==row.reply_id){
        this.db.prepare('UPDATE onboarding_reply_verifications SET status=?,reply_id=?,error=?,verified_at=COALESCE(?,verified_at),updated=? WHERE member_id=?')
          .run(status,replyId,error,verifiedAt,now(),row.member_id);
        this.service.changed();
      }
    }
  }
}
module.exports={OnboardingVerification};
