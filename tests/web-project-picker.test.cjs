'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/app.js'),'utf8');
function fixture(desktop,pick){
  const nodes={};for(const id of ['browse-folder','cancel-folder','project-picker-status','project-path','project-name','project-dialog'])nodes[id]={value:'',textContent:'',open:true,classList:{toggle(){},add(){}}};
  const context=vm.createContext({AbortController,desktop,$:id=>nodes[id],api:pick});
  vm.runInContext(source.slice(source.indexOf('let projectPicker ='),source.indexOf('function showProject()')),context);
  return {nodes,run:()=>vm.runInContext('browseProjectFolder()',context),cancel:()=>vm.runInContext('projectPicker.abort()',context)};
}
test('desktop project browsing uses its window bridge and fills a blank project name',async()=>{
  const calls=[],f=fixture({command:async operation=>{calls.push(operation);return {path:'C:\\项目\\测试'};}},()=>{throw Error('Native picker must not call the background HTTP picker');});
  await f.run();assert.deepEqual(calls,['pick_folder']);assert.equal(f.nodes['project-path'].value,'C:\\项目\\测试');assert.equal(f.nodes['project-name'].value,'测试');assert.equal(f.nodes['browse-folder'].disabled,false);
});
test('browser cancel restores the form and never replaces its entered path',async()=>{
  let calls=0;const f=fixture(null,(_,input,method,signal)=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('abort'))));});
  f.nodes['project-path'].value='C:\\keep';const work=f.run();await f.run();assert.equal(calls,1);f.cancel();await work;
  assert.equal(f.nodes['project-path'].value,'C:\\keep');assert.equal(f.nodes['browse-folder'].disabled,false);assert.match(f.nodes['project-picker-status'].textContent,/已取消/);
});
test('closed dialog ignores late folder results and reports picker failures inline',async()=>{
  let finish;const f=fixture(null,()=>new Promise(resolve=>finish=resolve));const work=f.run();f.nodes['project-dialog'].open=false;finish({path:'C:\\late'});await work;assert.equal(f.nodes['project-path'].value,'');
  const failure=fixture(null,async()=>{throw Error('文件夹选择超时，请填写路径');});await failure.run();assert.equal(failure.nodes['browse-folder'].disabled,false);assert.match(failure.nodes['project-picker-status'].textContent,/超时/);
});
