'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{publicAssetCache}=require('../src/http.cjs');
test('public asset validators reuse identical bytes and serve changed release bytes on first revalidation',()=>{
  const response=()=>({headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status){this.status=status;},end(){this.ended=true;}}),initial=response();assert.equal(publicAssetCache({headers:{}},initial,Buffer.from('preview old pixels')),false);assert.match(initial.headers['Cache-Control'],/must-revalidate/);assert.ok(initial.headers.ETag);
  const same=response();assert.equal(publicAssetCache({headers:{'if-none-match':initial.headers.ETag}},same,Buffer.from('preview old pixels')),true);assert.equal(same.status,304);
  const upgraded=response();assert.equal(publicAssetCache({headers:{'if-none-match':initial.headers.ETag}},upgraded,Buffer.from('preview new pixels')),false);assert.notEqual(upgraded.headers.ETag,initial.headers.ETag);
});
