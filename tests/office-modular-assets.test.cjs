'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PUBLIC_FILES}=require('../src/desktop-launch.cjs');
const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../web/assets/office/AVATAR_SOURCES.json'),'utf8'));
test('replaceable original office art is transparent, offline and included in the desktop public allowlist',()=>{
  assert.equal(manifest.office_art.runtime_network_required,false);
  assert.equal(manifest.office_art.assets.length,4);
  for(const item of manifest.office_art.assets){
    const file=path.resolve(__dirname,'../web',item.asset.slice(1)),bytes=fs.readFileSync(file);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes[25],6,'module has RGBA rather than a baked opaque scene');
    assert.equal(bytes.length,item.bytes);assert.equal(bytes.readUInt32BE(16),item.width);assert.equal(bytes.readUInt32BE(20),item.height);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);
    assert.ok(PUBLIC_FILES.has('desktop-web/'+item.asset.slice(1)),'offline desktop module is distributed and verified');
  }
  assert.equal(manifest.mascots,undefined,'no adapted official mascots are distributed');
  for(const record of [...Object.values(manifest.characters),...Object.values(manifest.avatars),manifest.desk]){
    const bytes=fs.readFileSync(path.resolve(__dirname,'../web',record.asset.slice(1)));assert.equal(bytes[25],6,'pixel sprites keep transparency');
    assert.ok(PUBLIC_FILES.has('desktop-web/'+record.asset.slice(1)),record.asset);
  }
});
