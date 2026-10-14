'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{providerDirectory}=require('../src/claude.cjs');
test('UNC Claude projects use an existing mapped drive only after exact directory verification',()=>{
  const project={path:'\\\\server\\share\\git\\项目',canonical:'\\\\server\\share\\git\\项目'},seen=[];
  const realpath=file=>{seen.push(file);if(file==='Y:\\')return '\\\\server\\share';if(file==='Y:\\git\\项目')return '\\\\?\\UNC\\server\\share\\git\\项目';throw Error('missing');};
  assert.equal(providerDirectory(project,{platform:'win32',drives:['X','Y'],realpath}),'Y:\\git\\项目');assert.ok(seen.includes('Y:\\git\\项目'));
});
test('unmapped shares and mapped paths redirected to another directory remain blocked',()=>{
  const project={path:'\\\\server\\share\\git\\project',canonical:'\\\\server\\share\\git\\project'};
  for(const remote of ['\\\\other-server\\share','\\\\server\\share'])assert.throws(()=>providerDirectory(project,{platform:'win32',drives:['Y'],realpath:file=>file==='Y:\\'?remote:'\\\\server\\share\\different'}),{code:'claude_local_path_required'});
});
test('registered drive and local paths keep their original working directory without enumeration',()=>{
  const project={path:'Y:\\git\\project',canonical:'\\\\server\\share\\git\\project'};assert.equal(providerDirectory(project,{platform:'win32',realpath:()=>{throw Error('must not enumerate');}}),project.path);
});
