'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
const start=source.indexOf('function renderVersion() {'),end=source.indexOf('function renderService() {',start);
assert.ok(start>=0&&end>start);
function fixture(values={}){
  const label={textContent:'',title:'',dataset:{}},context=vm.createContext({$:id=>id==='app-version'?label:null,state:null,desktopState:null,webConnected:false,...values});
  vm.runInContext(source.slice(start,end),context);
  return {label,context,render:()=>context.renderVersion()};
}
test('the visible version follows the actual backend across refreshes, without a compiled fallback',()=>{
  const f=fixture({webConnected:true,state:{version:'0.15.0-preview.5'}});f.render();
  assert.equal(f.label.textContent,'服务 v0.15.0-preview.5');assert.equal(f.label.dataset.mismatch,'false');
  f.context.state.version='0.15.0-preview.6';f.render();assert.equal(f.label.textContent,'服务 v0.15.0-preview.6');
  delete f.context.state.version;f.render();assert.equal(f.label.textContent,'服务版本未知');assert.doesNotMatch(f.label.textContent,/preview/);
});
test('client and backend mismatches are explicit in either direction and disappear after the backend catches up',()=>{
  const f=fixture({webConnected:true,state:{version:'0.14.13'},desktopState:{client_version:'0.15.0-preview.6'}});f.render();
  assert.equal(f.label.textContent,'服务 v0.14.13 · 软件 v0.15.0-preview.6');assert.match(f.label.title,/服务与软件版本不同/);assert.equal(f.label.dataset.mismatch,'true');
  f.context.state.version='0.16.0';f.render();assert.equal(f.label.textContent,'服务 v0.16.0 · 软件 v0.15.0-preview.6');assert.equal(f.label.dataset.mismatch,'true');
  f.context.state.version='0.15.0-preview.6';f.render();assert.equal(f.label.textContent,'服务 v0.15.0-preview.6');assert.equal(f.label.dataset.mismatch,'false');assert.doesNotMatch(f.label.title,/不同/);
});
test('a disconnected service never presents the local offline snapshot or last live state as its running version',()=>{
  const f=fixture({state:{version:'0.14.13'},desktopState:{running:false,client_version:'0.15.0-preview.6',snapshot:{version:'0.15.0-preview.6'}}});f.render();
  assert.equal(f.label.textContent,'服务未连接 · 软件 v0.15.0-preview.6');assert.equal(f.label.dataset.mismatch,'false');assert.doesNotMatch(f.label.textContent,/服务 v/);
  f.context.desktopState={snapshot:{version:'0.15.0-preview.6'}};f.render();assert.equal(f.label.textContent,'服务未连接');
});
test('incomplete or malformed version metadata cannot fall back to an unrelated source or enter HTML',()=>{
  const f=fixture({webConnected:true,state:{version:{version:'wrong'}},desktopState:{client_version:' ',snapshot:{version:'wrong-backend'}}});f.render();assert.equal(f.label.textContent,'服务版本未知');
  f.context.state.version='<img src=x onerror=alert(1)>';f.render();assert.equal(f.label.textContent,'服务 v<img src=x onerror=alert(1)>');assert.equal('innerHTML' in f.label,false);
  f.context.$=()=>null;assert.doesNotThrow(f.render);
});
