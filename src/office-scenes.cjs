'use strict';
const {RoomError}=require('./util.cjs');const model=require('../web/office-scene.js');
class OfficeScenes{
  constructor(service){this.service=service;}
  get(roomId){this.service.chat.store.room(roomId);const ids=this.service.chat.store.participants(roomId).map(m=>m.id),saved=this.service.store.setting('office-scene.'+roomId);if(!saved)return model.defaultScene(ids);try{return model.completeScene(saved,ids);}catch{return model.defaultScene(ids);}}
  snapshot(){return Object.fromEntries(this.service.chat.store.rooms().filter(r=>this.service.features.get(r.id).canvas).map(r=>[r.id,this.get(r.id)]));}
  set(input){
    if(!this.service.features.get(input.room_id).scene_editor)throw new RoomError('先在房间选项中开启场景布置。',409,'scene_editor_disabled');
    const previous=this.get(input.room_id);if(input.expected_revision!==previous.revision)throw new RoomError('场景已在另一处更新，请重新打开后再保存。',409,'scene_revision_conflict');
    let value;try{value=model.validatePlacement({...input.scene,revision:previous.revision+1});}catch(error){throw new RoomError(error.message,400,'scene_input_invalid');}
    for(const member of Object.keys(value.stations))this.service.chat.store.requireParticipant(input.room_id,member);
    if(this.service.chat.store.participants(input.room_id).some(m=>!value.stations[m.id]))throw new RoomError('成员已变化，请重新打开场景后再保存。',409,'scene_members_changed');
    this.service.store.setting('office-scene.'+input.room_id,value);this.service.changed();return value;
  }
}
module.exports={OfficeScenes};
