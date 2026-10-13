'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{validateWebhook}=require('../src/vault.cjs');
test('webhook setup accepts raw/header keys but rejects navigation and wrong hosts',()=>{const v=validateWebhook('https://api2.cursor.sh/automations/webhook/example','Authorization: Bearer crsr_test_only');assert.equal(v.key,'crsr_test_only');assert.throws(()=>validateWebhook('grokbot://app/v1/sidebar','x'));assert.throws(()=>validateWebhook('https://api2.cursor.sh/','x'));assert.throws(()=>validateWebhook('https://evil.example/webhook/x','x'));});
