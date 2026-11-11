'use strict';
const {RoomError}=require('./util.cjs');
const DEFAULTS=Object.freeze({discussion:false,claims:false,trial:false,work_layout:false,canvas:false,walking:false,ambient:false,interactions:false,scene_editor:false,reduced_motion:false,daily_limit:null});
class RoomFeatures{
  constructor(service){this.service=service;}
  get(roomId){this.service.chat.store.room(roomId);const old=this.service.store.setting('features.'+roomId)||{};return {...DEFAULTS,...Object.fromEntries(Object.entries(old).filter(([k])=>Object.hasOwn(DEFAULTS,k)))};}
  set(input){
    if(!input||Object.keys(input).some(k=>k!=='room_id'&&!Object.hasOwn(DEFAULTS,k)))throw new RoomError('房间选项无效。');
    const value=this.get(input.room_id);
    for(const [key,v]of Object.entries(input)){if(key==='room_id')continue;if(key==='daily_limit'){if(v!==null&&(!Number.isInteger(v)||v<1||v>100000))throw new RoomError('每日上限请填正整数，留空为不限。');}else if(typeof v!=='boolean')throw new RoomError('房间开关应为开或关。');value[key]=v;}
    this.service.store.setting('features.'+input.room_id,value);this.service.changed();return value;
  }
  snapshot(){return Object.fromEntries(this.service.chat.store.rooms().map(r=>[r.id,this.get(r.id)]));}
}
module.exports={RoomFeatures,DEFAULTS};
