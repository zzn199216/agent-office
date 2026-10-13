'use strict';
const {RoomError,cleanText}=require('./util.cjs');
const MAX_IMAGE_BYTES=128*1024,MAX_DIMENSION=1024;
const PRESETS=new Set(['auto','person','robot','sprite']),FURNITURE=new Set(['desk','beanbag']);
function pngComplete(bytes){
  let offset=8,image=false,ended=false;while(offset+12<=bytes.length){const size=bytes.readUInt32BE(offset),tag=bytes.toString('ascii',offset+4,offset+8),next=offset+12+size;if(next>bytes.length||['acTL','fcTL','fdAT'].includes(tag))return false;if(tag==='IDAT'&&size>0)image=true;if(tag==='IEND'){if(size!==0||next!==bytes.length)return false;ended=true;}offset=next;}return offset===bytes.length&&image&&ended;
}
function imageDimensions(bytes,mime){
  if(mime==='image/png'){
    if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR'||!pngComplete(bytes))return null;
    return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  }
  if(mime==='image/jpeg'){
    if(bytes.length<10||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)return null;
    let position=2;
    while(position+4<=bytes.length){
      if(bytes[position++]!==255)return null;while(position<bytes.length&&bytes[position]===255)position++;
      const marker=bytes[position++];if(marker===0xda||marker===0xd9)return null;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(position+2>bytes.length)return null;const size=bytes.readUInt16BE(position);if(size<2||position+size>bytes.length)return null;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return size>=8?{width:bytes.readUInt16BE(position+5),height:bytes.readUInt16BE(position+3)}:null;
      position+=size;
    }return null;
  }
  if(mime==='image/webp'){
    if(bytes.length<26||bytes.toString('ascii',0,4)!=='RIFF'||bytes.readUInt32LE(4)+8!==bytes.length||bytes.toString('ascii',8,12)!=='WEBP')return null;
    let position=12,dimensions=null,image=false;
    while(position+8<=bytes.length){const tag=bytes.toString('ascii',position,position+4),size=bytes.readUInt32LE(position+4),offset=position+8,next=offset+size+(size&1);if(next>bytes.length)return null;
      if(tag==='ANIM'||tag==='ANMF')return null; // User imports are static; app owns motion.
      if(tag==='VP8X'){if(size!==10||(bytes[offset]&2))return null;dimensions={width:bytes.readUIntLE(offset+4,3)+1,height:bytes.readUIntLE(offset+7,3)+1};}
      if(tag==='VP8 '){if(size<10||!bytes.subarray(offset+3,offset+6).equals(Buffer.from([157,1,42])))return null;image=true;dimensions ||= {width:bytes.readUInt16LE(offset+6)&0x3fff,height:bytes.readUInt16LE(offset+8)&0x3fff};}
      if(tag==='VP8L'){if(size<5||bytes[offset]!==47)return null;const bits=bytes.readUInt32LE(offset+1);image=true;dimensions ||= {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
      position=next;
    }return position===bytes.length&&image?dimensions:null;
  }return null;
}
function rasterData(value){
  if(value==null||value==='')return null;
  if(typeof value!=='string'||value.length>Math.ceil(MAX_IMAGE_BYTES/3)*4+64)throw new RoomError('图片过大，请缩小到 128 KB 以内。',400,'appearance_image_too_large');
  const match=value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)throw new RoomError('请选择 PNG、JPEG 或 WebP 图片；不加载外部地址或 SVG。',400,'appearance_image_invalid');
  const bytes=Buffer.from(match[2],'base64');if(bytes.length>MAX_IMAGE_BYTES)throw new RoomError('图片过大，请缩小到 128 KB 以内。',400,'appearance_image_too_large');
  if(bytes.toString('base64')!==match[2])throw new RoomError('图片编码无效，请重新选择图片。',400,'appearance_image_invalid');
  const dimensions=imageDimensions(bytes,match[1]);if(!dimensions||dimensions.width<1||dimensions.height<1||dimensions.width>MAX_DIMENSION||dimensions.height>MAX_DIMENSION)throw new RoomError('图片格式或尺寸无效，请使用不超过 1024 × 1024 的静态图片。',400,'appearance_image_invalid');
  return `data:${match[1]};base64,${match[2]}`;
}
// Accessory colour for same-model colleagues: absent means automatic, 0 the original, 1-4 a variant.
const validAccent=value=>Number.isInteger(value)&&value>=0&&value<=4;
function defaultAppearance(member){
  const adapter=member.adapter==='mailbox'?(member.config?.launch_provider||member.adapter):member.adapter;
  const color=/codex/.test(adapter)?'#2e8067':/claude/.test(adapter)?'#c77955':/qwen/.test(adapter)?'#7259b8':/grok/.test(adapter)?'#34494d':'#557f9a';
  return {preset:'auto',color,furniture:'desk',scale:1};
}
function storedAppearance(store,member){
  const base=defaultAppearance(member);let stored;try{stored=store.setting('appearance.'+member.id);}catch{return base;}
  if(!stored||typeof stored!=='object'||Array.isArray(stored))return base;
  if(PRESETS.has(stored.preset))base.preset=stored.preset;if(/^#[0-9a-f]{6}$/i.test(stored.color||''))base.color=stored.color;
  if(FURNITURE.has(stored.furniture))base.furniture=stored.furniture;if(typeof stored.scale==='number'&&Number.isFinite(stored.scale)&&stored.scale>=0.65&&stored.scale<=1.35)base.scale=stored.scale;if(validAccent(stored.accent))base.accent=stored.accent;
  for(const key of ['avatar_data','character_data'])if(stored[key]){try{base[key]=rasterData(stored[key]);}catch{}}
  return base;
}
class AppearanceManager{
  constructor(service){this.service=service;}
  get(memberId){const member=this.service.chat.store.member(cleanText(memberId,200,'成员标识'));return storedAppearance(this.service.store,member);}
  set(input){
    const allowed=new Set(['member_id','preset','color','furniture','scale','accent','avatar_data','character_data','reset']);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key))||input.reset!==undefined&&typeof input.reset!=='boolean')throw new RoomError('外观设置包含不支持的字段。',400,'appearance_input_invalid');
    const member=this.service.chat.store.member(cleanText(input.member_id,200,'成员标识'));
    if(input.reset===true){this.service.store.db.prepare('DELETE FROM settings WHERE key=?').run('appearance.'+member.id);this.service.changed();return defaultAppearance(member);}
    if(input.preset!==undefined&&!PRESETS.has(input.preset)||input.color!==undefined&&(typeof input.color!=='string'||!/^#[0-9a-f]{6}$/i.test(input.color))||input.furniture!==undefined&&!FURNITURE.has(input.furniture)||input.scale!==undefined&&(typeof input.scale!=='number'||!Number.isFinite(input.scale)||input.scale<0.65||input.scale>1.35)||input.accent!==undefined&&input.accent!=='auto'&&!validAccent(input.accent))throw new RoomError('请选择有效的形象、颜色、家具和尺寸。',400,'appearance_input_invalid');
    const value=this.get(member.id);if(input.preset!==undefined)value.preset=input.preset;if(input.color!==undefined)value.color=input.color.toLowerCase();if(input.furniture!==undefined)value.furniture=input.furniture;if(input.scale!==undefined)value.scale=input.scale;if(input.accent==='auto')delete value.accent;else if(input.accent!==undefined)value.accent=input.accent;
    for(const key of ['avatar_data','character_data'])if(Object.hasOwn(input,key)){const image=rasterData(input[key]);if(image)value[key]=image;else delete value[key];}
    this.service.store.setting('appearance.'+member.id,value);this.service.changed();return value;
  }
}
module.exports={AppearanceManager,storedAppearance,defaultAppearance,rasterData,imageDimensions,MAX_IMAGE_BYTES};
