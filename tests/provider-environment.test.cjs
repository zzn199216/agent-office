'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {providerTestEnv}=require('./helpers.cjs');

test('provider fixtures discard inherited provider settings without mutating the host environment',()=>{
  const inherited={PATH:'fixture-path',USERPROFILE:'fixture-home',FAKE_PROVIDER_MODE:'success'};
  for(const prefix of ['ANTHROPIC_','CLAUDE_CODE_','OPENAI_','GEMINI_','GOOGLE_','QWEN_']){
    inherited[prefix+'BASE_URL']='https://example.invalid';
    inherited[(prefix+'API_KEY').toLowerCase()]='host-fixture-secret';
  }
  const before={...inherited};
  assert.deepEqual(providerTestEnv(inherited),{PATH:'fixture-path',USERPROFILE:'fixture-home',FAKE_PROVIDER_MODE:'success'});
  assert.deepEqual(inherited,before);
  assert.deepEqual({...providerTestEnv(inherited),ANTHROPIC_BASE_URL:'https://fixture.invalid'},{PATH:'fixture-path',USERPROFILE:'fixture-home',FAKE_PROVIDER_MODE:'success',ANTHROPIC_BASE_URL:'https://fixture.invalid'});
});
