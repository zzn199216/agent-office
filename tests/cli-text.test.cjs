'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{fileText}=require('../src/main.cjs'),{fixture}=require('./helpers.cjs');
test('UTF-8 file channel preserves Chinese and refuses invalid bytes',()=>{const f=fixture(),file=path.join(f.root,'question.md');fs.writeFileSync(file,'第一轮：这个项目上线了吗？','utf8');assert.equal(fileText(file),'第一轮：这个项目上线了吗？');fs.writeFileSync(file,Buffer.from([0xff,0xfe,0x00]));assert.throws(()=>fileText(file),/不是有效 UTF-8/);assert.throws(()=>fileText('auth.json'),/请选择/);});
