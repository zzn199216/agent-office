'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {desktopManifest,installDesktop,PUBLIC_FILES}=require('../src/desktop-launch.cjs');const {VERSION}=require('../src/util.cjs');
test('desktop package output and runtime verification accept the same complete file set',()=>{
  const {REQUIRED_FILES,ASSETS}=require('../scripts/build-desktop.cjs');
  assert.deepEqual([...PUBLIC_FILES].sort(),[...REQUIRED_FILES,...ASSETS].sort());
});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-desktop-bundle-')),source=path.join(root,'public'),data=path.join(root,'private');fs.mkdirSync(source);
  const files=[...PUBLIC_FILES].map((relative,index)=>{const file=path.join(source,...relative.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});const bytes=Buffer.from('fixture '+index);fs.writeFileSync(file,bytes);return {path:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
  const manifest={version:VERSION,files},write=()=>fs.writeFileSync(path.join(source,'desktop-manifest.json'),JSON.stringify(manifest));write();
  t.after(()=>{const absolute=path.resolve(root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-desktop-bundle-/);fs.rmSync(absolute,{recursive:true,force:true});});return {root,source,data,manifest,write};
}
test('desktop install copies only explicit verified public files and repeats without changing them',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.source,'private-entry.json'),'not copied');
  const target=installDesktop(f.source,f.data);assert.equal(fs.existsSync(path.join(target,'private-entry.json')),false);assert.equal(fs.existsSync(path.join(f.data,'room.sqlite')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'installed.json'))).app,'AgentRoom.desktop');
  const first=fs.statSync(path.join(target,'AgentRoom.Desktop.exe')).mtimeMs;assert.equal(installDesktop(f.source,f.data),target);assert.equal(fs.statSync(path.join(target,'AgentRoom.Desktop.exe')).mtimeMs,first);
  assert.equal(desktopManifest(target).version,VERSION);
});
test('manifest path changes, tampered bytes and wrong versions fail before any installation',t=>{
  const f=fixture(t),original=f.manifest.files[0].path;f.manifest.files[0].path='../unknown.exe';f.write();assert.throws(()=>installDesktop(f.source,f.data),e=>e.code==='desktop_bundle_invalid');assert.equal(fs.existsSync(f.data),false);
  f.manifest.files[0].path=original;f.manifest.version='0.0.0';f.write();assert.throws(()=>desktopManifest(f.source),e=>e.code==='desktop_bundle_invalid');f.manifest.version=VERSION;f.write();
  fs.writeFileSync(path.join(f.source,original),'changed bytes');assert.throws(()=>desktopManifest(f.source),e=>e.code==='desktop_bundle_invalid');assert.equal(fs.existsSync(f.data),false);
});
test('unknown existing desktop directory is preserved',t=>{
  const f=fixture(t),target=path.join(f.data,'bin','desktop');fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'AgentRoom.Desktop.exe'),'user-owned');
  assert.throws(()=>installDesktop(f.source,f.data),e=>e.code==='desktop_install_collision');assert.equal(fs.readFileSync(path.join(target,'AgentRoom.Desktop.exe'),'utf8'),'user-owned');
});
test('a versioned executable gets its own complete desktop bundle and preserves the previous bundle',t=>{
  const f=fixture(t),previous=path.join(f.data,'bin','desktop');fs.mkdirSync(previous,{recursive:true});fs.writeFileSync(path.join(previous,'keep.txt'),'old host in use');
  const executable=path.join(f.data,'bin','versions','version-fixture','AgentRoom.exe'),target=installDesktop(f.source,f.data,{executable});
  assert.equal(target,path.join(path.dirname(executable),'desktop'));assert.equal(desktopManifest(target).version,VERSION);assert.equal(fs.readFileSync(path.join(previous,'keep.txt'),'utf8'),'old host in use');
  assert.throws(()=>installDesktop(f.source,f.data,{executable:path.join(f.root,'outside.exe')}),{code:'desktop_install_collision'});
});
