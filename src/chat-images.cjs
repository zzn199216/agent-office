'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {RoomError,id,atomicWrite}=require('./util.cjs');
const MAX_IMAGE=4*1024*1024,MAX_TOTAL=8*1024*1024;
function validateImages(input){
  if(input===undefined)return [];if(!Array.isArray(input)||input.length>4)throw new RoomError('每条消息最多附带 4 张图片。',400,'chat_image_invalid');let total=0;
  return input.map(value=>{
    const match=typeof value?.data_url==='string'&&value.data_url.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if(!match||match[2].length>Math.ceil(MAX_IMAGE/3)*4)throw new RoomError('请使用 PNG、JPEG、WebP 或 GIF 图片，每张不超过 4 MB。',400,'chat_image_invalid');
    const bytes=Buffer.from(match[2],'base64');total+=bytes.length;
    const mime=match[1],valid=mime==='image/png'?bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):mime==='image/jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217:mime==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')):bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length;
    if(!valid||!bytes.length||bytes.length>MAX_IMAGE||total>MAX_TOTAL||bytes.toString('base64')!==match[2])throw new RoomError('图片内容无效或总大小超过 8 MB。',400,'chat_image_invalid');
    return {name:String(value.name||'图片').replace(/[\0\r\n]/g,'').slice(0,100),mime,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes};
  });
}
class ChatImages{
  constructor(store){this.store=store;this.db=store.db;this.root=path.join(store.dir,'chat-images');}
  initialize(){this.db.exec('CREATE TABLE IF NOT EXISTS chat_images(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,message_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL);CREATE INDEX IF NOT EXISTS chat_images_message ON chat_images(message_id)');}
  hasTable(){return this.present??=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_images'").get();}
  file(row,create=false){
    if(!/^[a-f0-9-]{36}$/i.test(row.room_id)||!/^[a-f0-9]{64}$/.test(row.sha256))throw new RoomError('图片记录无效。',409,'chat_image_invalid');
    const folder=path.join(this.root,row.room_id);for(const directory of [this.root,folder])if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw new RoomError('图片目录不能使用未知链接。',403,'chat_image_invalid');
    if(create)fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,row.sha256);
    if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw new RoomError('图片文件不能使用未知链接。',403,'chat_image_invalid');return file;
  }
  save(roomId,messageId,images){for(const image of images){const row={id:id(),room_id:roomId,message_id:messageId,name:image.name,mime:image.mime,size:image.size,sha256:image.sha256},file=this.file(row,true);if(!fs.existsSync(file))atomicWrite(file,image.bytes);else if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==row.sha256)throw new RoomError('图片存储冲突。',409,'chat_image_invalid');this.db.prepare('INSERT INTO chat_images VALUES(:id,:room_id,:message_id,:name,:mime,:size,:sha256)').run(row);}}
  list(messageId){return this.hasTable()?this.db.prepare('SELECT id,name,mime,size,sha256 FROM chat_images WHERE message_id=? ORDER BY rowid').all(messageId).map(row=>({...row,url:'/api/chat/images/'+row.id})):[];}
  metadata(imageId){const row=this.hasTable()&&this.db.prepare('SELECT * FROM chat_images WHERE id=?').get(imageId);if(!row)throw new RoomError('图片不存在。',404,'chat_image_missing');return row;}
  read(imageId){const row=this.metadata(imageId);let bytes;try{bytes=fs.readFileSync(this.file(row));}catch(error){if(error instanceof RoomError)throw error;throw new RoomError('已保存的图片暂时无法读取。',404,'chat_image_missing');}if(bytes.length!==row.size||crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new RoomError('已保存图片的内容发生变化。',409,'chat_image_invalid');return {row,bytes};}
  input(messageId){return this.list(messageId).map(image=>{const {row,bytes}=this.read(image.id);return {mime:row.mime,data:bytes.toString('base64')};});}
}
module.exports={ChatImages,validateImages,MAX_IMAGE,MAX_TOTAL};
