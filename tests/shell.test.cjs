'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{shellCommand}=require('../src/util.cjs');
test('PowerShell helper uses the call operator and literal quotes for paths',()=>{assert.equal(shellCommand("C:\\A $user\\AgentRoom.exe",['delivery',"x'&y"],'win32'),"& 'C:\\A $user\\AgentRoom.exe' 'delivery' 'x''&y'");});
