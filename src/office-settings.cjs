'use strict';
const {RoomError,cleanText}=require('./util.cjs');
const {rasterData}=require('./appearance.cjs');

const DEFAULT_OFFICE=Object.freeze({version:1,time_zone:'auto',time_mode:'auto',lights_on:true,auto_layout:true,columns:3,spacing:1,wall_color:'#f8f7f3',floor_color:'#faf7ef',show_window:true,show_clock:true,show_plant:true,motion:true});
const IMAGE_FIELDS=Object.freeze(['background_data','desk_data','beanbag_data','plant_data','door_data']);
const FIELDS=new Set([...Object.keys(DEFAULT_OFFICE),...IMAGE_FIELDS]);
const TIME_MODES=new Set(['auto','day','night']);
const BOOLEAN_FIELDS=new Set(['auto_layout','show_window','show_clock','show_plant','motion','lights_on']);

function invalid(){return new RoomError('办公室设置包含无效或不支持的内容。',400,'office_input_invalid');}
function validTimeZone(value){
  if(value==='auto')return true;
  if(typeof value!=='string'||value.length>100||!value||! /^[A-Za-z][A-Za-z0-9_+./-]*$/.test(value))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
}
function validatedValue(key,value){
  if(IMAGE_FIELDS.includes(key))return rasterData(value);
  if(key==='version'){if(value!==1)throw invalid();return value;}
  if(key==='time_zone'){if(!validTimeZone(value))throw invalid();return value;}
  if(key==='time_mode'){if(!TIME_MODES.has(value))throw invalid();return value;}
  if(key==='columns'){if(!Number.isInteger(value)||value<1||value>3)throw invalid();return value;}
  if(key==='spacing'){if(typeof value!=='number'||!Number.isFinite(value)||value<0.8||value>1.3)throw invalid();return value;}
  if(key==='wall_color'||key==='floor_color'){if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw invalid();return value.toLowerCase();}
  if(BOOLEAN_FIELDS.has(key)){if(typeof value!=='boolean')throw invalid();return value;}
  throw invalid();
}
function sanitizedConfig(stored){
  const config={...DEFAULT_OFFICE};
  if(!stored||typeof stored!=='object'||Array.isArray(stored))return config;
  // A damaged or obsolete presentation preference must not prevent room recovery.
  for(const key of FIELDS)if(Object.hasOwn(stored,key)){try{const value=validatedValue(key,stored[key]);if(value!==null)config[key]=value;}catch{}}
  return config;
}
function storedOffice(store,roomId){let value;try{value=store.setting('office.'+roomId);}catch{}return sanitizedConfig(value);}
function officeSnapshot(store,rooms){return Object.fromEntries(rooms.map(room=>[room.id,storedOffice(store,room.id)]));}

class OfficeSettingsManager{
  constructor(service){this.service=service;}
  room(roomId){return this.service.chat.store.room(cleanText(roomId,200,'聊天室标识'));}
  get(roomId){return storedOffice(this.service.store,this.room(roomId).id);}
  snapshot(){return officeSnapshot(this.service.store,this.service.chat.store.rooms());}
  set(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='room_id'&&key!=='reset'&&!FIELDS.has(key))||input.reset!==undefined&&typeof input.reset!=='boolean')throw invalid();
    const room=this.room(input.room_id),key='office.'+room.id;
    if(input.reset===true){this.service.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);this.service.changed();return {...DEFAULT_OFFICE};}
    const config=this.get(room.id);
    for(const field of FIELDS)if(Object.hasOwn(input,field)){const value=validatedValue(field,input[field]);if(value===null)delete config[field];else config[field]=value;}
    this.service.store.setting(key,config);this.service.changed();return config;
  }
}
module.exports={OfficeSettingsManager,DEFAULT_OFFICE,IMAGE_FIELDS,validTimeZone,sanitizedConfig,storedOffice,officeSnapshot};
