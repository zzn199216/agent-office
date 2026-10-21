'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SDK_VERSION,SDK_SHA256,requestSdkPackage,downloadSdkPackage}=require('../scripts/build-desktop.cjs');
const initial=`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${SDK_VERSION}/microsoft.web.webview2.${SDK_VERSION}.nupkg`;
const regional=initial.replace('api.nuget.org','nuget.azure.cn');
function fixture(responses){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{calls.push({url,options});const next=responses.shift();assert.ok(next,'unexpected network request');return typeof next==='function'?next(url,options):next;}};
}
function redirect(location,status=302){return new Response(null,{status,headers:location===undefined?{}:{location}});}

test('WebView2 SDK manually follows only the explicit official hosts using one total deadline',async()=>{
  const f=fixture([redirect(regional),redirect('/packages/webview2.nupkg',307),redirect('https://globalcdn.nuget.org/packages/webview2.nupkg',308),new Response('fixture package')]);
  const response=await requestSdkPackage(f);assert.equal(await response.text(),'fixture package');
  assert.deepEqual(f.calls.map(call=>call.url),[initial,regional,'https://nuget.azure.cn/packages/webview2.nupkg','https://globalcdn.nuget.org/packages/webview2.nupkg']);
  const signal=f.calls[0].options.signal;assert.ok(signal instanceof AbortSignal);
  assert.ok(f.calls.every(call=>call.options.redirect==='manual'&&call.options.credentials==='omit'&&call.options.signal===signal));
});

test('WebView2 SDK refuses unrelated hosts, non-HTTPS URLs, credentials and custom ports before requesting them',async t=>{
  for(const location of ['https://evil.invalid/package','https://api.nuget.org.evil.invalid/package','https://subdomain.nuget.azure.cn/package','http://api.nuget.org/package','https://user:secret@api.nuget.org/package','https://api.nuget.org:444/package','https://api.nuget.org/package#fragment','//evil.invalid/package','https://[invalid'])await t.test(location,async()=>{
    const f=fixture([redirect(location)]);await assert.rejects(requestSdkPackage(f),/Official WebView2 SDK (?:refused an untrusted download URL|source URL is invalid)/);assert.equal(f.calls.length,1);
  });
  const f=fixture([redirect(regional),redirect('http://nuget.azure.cn/package')]);await assert.rejects(requestSdkPackage(f),/untrusted download URL/);assert.equal(f.calls.length,2);
});

test('WebView2 SDK detects redirect loops and caps a chain of distinct trusted URLs',async()=>{
  const loop=fixture([redirect(regional),redirect(initial)]);await assert.rejects(requestSdkPackage(loop),/redirect loop/);assert.equal(loop.calls.length,2);
  const long=fixture(Array.from({length:6},(_,index)=>redirect('https://api.nuget.org/redirect/'+index)));
  await assert.rejects(requestSdkPackage(long),/exceeded 5 redirects/);assert.equal(long.calls.length,6);
});

test('WebView2 SDK download errors distinguish malformed redirects, HTTP status and network causes',async()=>{
  await assert.rejects(requestSdkPackage(fixture([redirect()])),/redirect has no Location/);
  await assert.rejects(requestSdkPackage(fixture([new Response(null,{status:404})])),/HTTP 404/);
  const error=new TypeError('fetch failed',{cause:Object.assign(new Error('DNS unavailable'),{code:'ENOTFOUND'})});
  await assert.rejects(requestSdkPackage(fixture([()=>{throw error;}])),/request failed at api.nuget.org: ENOTFOUND/);
  const followed=new Response('unexpected');Object.defineProperty(followed,'redirected',{value:true});
  await assert.rejects(requestSdkPackage(fixture([followed])),/unexpectedly followed a redirect/);
});

test('WebView2 SDK fixed hash is still enforced after an allowed official redirect',async()=>{
  assert.equal(SDK_SHA256,'56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9');
  const f=fixture([redirect(regional),new Response('altered package bytes')]);await assert.rejects(downloadSdkPackage(f),/SHA256 mismatch/);assert.equal(f.calls.length,2);
});

test('WebView2 SDK rejects oversized declarations and stops oversized chunked bodies without caching them',async t=>{
  for(const length of [String(16*1024*1024+1),'-1','invalid'])await t.test('Content-Length '+length,async()=>{
    const f=fixture([new Response('small body',{headers:{'content-length':length}})]);await assert.rejects(downloadSdkPackage(f),/Unexpected WebView2 SDK package size/);
  });
  let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16*1024*1024+1));},cancel(){cancelled=true;}});
  await assert.rejects(downloadSdkPackage(fixture([new Response(stream)])),/Unexpected WebView2 SDK package size/);assert.equal(cancelled,true);
});
