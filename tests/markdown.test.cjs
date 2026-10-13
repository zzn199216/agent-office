'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Exercise the exact browser formatter without starting the app or a model.
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),context=vm.createContext({});
const escapeLine=source.split('\n').find(line=>line.startsWith('const escape ='));
const start=source.indexOf('function inlineMarkdown('),end=source.indexOf('function messageContent(',start);
assert.ok(escapeLine&&start>=0&&end>start);
vm.runInContext(escapeLine+'\n'+source.slice(start,end)+'\nthis.format=renderMarkdown;',context);
const format=value=>context.format(value);

test('inline commands and regexes preserve literal emphasis, links and deletion syntax',()=>{
  for(const code of ['**literal**','rg "**needle**" file.txt','~~literal~~','[label](https://example.com)','*literal*'])assert.equal(format('`'+code+'`'),'<p><code>'+code.replaceAll('"','&quot;')+'</code></p>');
});
test('outer emphasis still surrounds protected inline code and multiple spans',()=>{
  assert.equal(format('**run `**literal**` now**'),'<p><strong>run <code>**literal**</code> now</strong></p>');
  assert.equal(format('`first` then `~~second~~`'),'<p><code>first</code> then <code>~~second~~</code></p>');
});
test('multi-backtick spans preserve literal backticks and unmatched delimiters remain text',()=>{
  assert.equal(format('``a `b` **c**``'),'<p><code>a `b` **c**</code></p>');
  assert.equal(format('before `unclosed'),'<p>before `unclosed</p>');
});
test('HTML stays escaped inside both inline code and fenced blocks',()=>{
  assert.equal(format('`<img src=x onerror="alert(1)">`'),'<p><code>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</code></p>');
  const fenced=format('```html\n<script>**literal**</script>\n```');
  assert.equal(fenced,'<pre class="md-code" data-lang="html"><code>&lt;script&gt;**literal**&lt;/script&gt;</code></pre>');
  assert.doesNotMatch(format('<script>alert(1)</script> [bad](javascript:alert(1))'),/<script>|href=|onclick=/);
});
test('author text cannot collide with protected code tokens',()=>{
  const text='\u00000\u0000 before `**literal**`';
  assert.equal(format(text),'<p>\u00000\u0000 before <code>**literal**</code></p>');
});
