'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createFolderPicker}=require('../src/folder-picker.cjs');
function fixture(timeout=1000){
  const children=[];
  const picker=createFolderPicker({platform:'win32',timeout,launch:()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.kills=0;child.kill=()=>{child.kills++;};children.push(child);return child;
  }});
  return {...picker,children};
}
test('folder selection returns a path or a normal cancel and can reopen',async()=>{
  const f=fixture(),selected=f.pick();f.children[0].stdout.write('C:\\项目');f.children[0].emit('close',0);
  assert.deepEqual(await selected,{path:'C:\\项目'});
  const cancelled=f.pick();f.children[1].emit('close',0);assert.deepEqual(await cancelled,{path:''});
});
test('folder picker rejects duplicate windows and closes on request cancellation',async()=>{
  const f=fixture(),controller=new AbortController(),pending=f.pick({signal:controller.signal});
  await assert.rejects(f.pick(),error=>error.code==='folder_picker_busy');assert.equal(f.children.length,1);
  controller.abort();await assert.rejects(pending,error=>error.code==='folder_picker_cancelled');assert.equal(f.children[0].kills,1);
  f.children[0].emit('close',1);const next=f.pick();f.close();await assert.rejects(next,/已取消/);assert.equal(f.children[1].kills,1);
});
test('unresponsive picker times out and kills only its own child',async()=>{
  const f=fixture(10);await assert.rejects(f.pick(),error=>error.code==='folder_picker_timeout');assert.equal(f.children[0].kills,1);
  const next=f.pick();f.children[1].emit('close',0);assert.deepEqual(await next,{path:''});
});
test('picker launch failure and pre-aborted request release the busy state',async()=>{
  const f=fixture(),first=f.pick();f.children[0].emit('error',Error('spawn failed'));await assert.rejects(first,/填写/);
  const controller=new AbortController();controller.abort();await assert.rejects(f.pick({signal:controller.signal}),/已取消/);assert.equal(f.children.length,1);
  const next=f.pick();f.children[1].emit('close',1);await assert.rejects(next,/重试/);
});
