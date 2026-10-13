'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DiscoveryCatalog,geminiVendorScript}=require('../src/discovery.cjs');
function fixture(options={}){
  const files=new Set(options.files||[]),manifests=options.manifests||{};
  return new DiscoveryCatalog({platform:'win32',env:{USERPROFILE:'C:\\Users\\Fixture',APPDATA:'C:\\Users\\Fixture\\Roaming',PATH:'C:\\Tools'},fileExists:file=>files.has(file),listFiles:folder=>options.folders?.[folder]||[],readManifest:file=>manifests[file]||null,processInventory:()=>options.processes||[],...options});
}
const get=(catalog,provider)=>catalog.scan().candidates.find(item=>item.provider===provider);

test('Gemini npm metadata resolves a vendor entry via Node without executing a shell shim',()=>{
  const shim='C:\\Users\\Fixture\\Roaming\\npm\\gemini.cmd',node='C:\\Tools\\node.exe';
  for(const suffix of ['bundle\\gemini.js','dist\\index.js']){
    const script='C:\\Users\\Fixture\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\'+suffix;
    const candidate=get(fixture({files:[shim,node,script]}),'gemini-cli');
    assert.equal(candidate.installed,true);assert.equal(candidate.running,false);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);
    assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.capabilities.attach_existing,false);assert.equal(candidate.identity.handshake_verified,false);assert.equal(candidate.minimum_version,require('../src/gemini.cjs').MIN_VERSION);
  }
  for(const files of [[shim],[shim,node]]){
    const candidate=get(fixture({files}),'gemini-cli');assert.equal(candidate.installed,true);assert.equal(candidate.executable,null);assert.equal(candidate.capabilities.automatic_launch,false);assert.equal(candidate.capabilities.runtime_install,true);
  }
});

test('Gemini process discovery rejects prompt/import impersonation and suppresses private arguments',()=>{
  const node='C:\\Tools\\node.exe',script='C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js',secret='fixture-private-argument';
  const processes=[{Name:'node.exe',ProcessId:1,ExecutablePath:node,CommandLine:`"${node}" "${script}" --prompt ${secret}`},
    {Name:'node.exe',ProcessId:2,ExecutablePath:node,CommandLine:`node --eval "${script}"`},
    {Name:'node.exe',ProcessId:3,ExecutablePath:node,CommandLine:`node unrelated.js --prompt "${script}"`},
    {Name:'node.exe',ProcessId:4,ExecutablePath:'C:\\Other\\node.exe',CommandLine:`node "${script}"`}];
  const candidate=get(fixture({files:[node,script],processes}),'gemini-cli');
  assert.deepEqual(candidate.pids,[1,4]);assert.equal(candidate.executable,node);assert.equal(JSON.stringify(candidate).includes(secret),false);assert.equal(candidate.capabilities.automatic_launch,true);
  const untrusted=get(fixture({files:[script],processes:[processes[3]]}),'gemini-cli');assert.equal(untrusted.capabilities.automatic_launch,false);assert.equal(untrusted.executable,null);
  for(const bad of ['relative\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js','C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\..\\bundle\\gemini.js',script.replace('gemini.js','other.js')])assert.equal(geminiVendorScript(bad),false);
});

test('explicit Gemini Node/vendor metadata works without changing PATH or treating other scripts as official',()=>{
  const node='D:\\Node\\node.exe',script='D:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
  const env={USERPROFILE:'C:\\Users\\Fixture',PATH:'',AGENTROOM_GEMINI_PATH:node,AGENTROOM_GEMINI_SCRIPT:script};
  const candidate=get(fixture({env,files:[node,script]}),'gemini-cli');assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(env.PATH,'');
  const bad=get(fixture({env:{...env,AGENTROOM_GEMINI_SCRIPT:'D:\\custom.js'},files:[node,'D:\\custom.js']}),'gemini-cli');assert.equal(bad.capabilities.automatic_launch,false);
});

test('manual MCP fallback candidates remain selectable while installation, running and handshake stay false',()=>{
  const snapshot=fixture().scan();
  for(const provider of ['doubao','opencode','cherry-studio','cline','roo-code']){
    const candidate=snapshot.candidates.find(item=>item.provider===provider);assert.equal(candidate.installed,false);assert.equal(candidate.running,false);assert.equal(candidate.can_connect,true);assert.equal(candidate.capabilities.automatic_launch,false);assert.equal(candidate.capabilities.mcp_install,false);assert.equal(candidate.capabilities.mcp_prepare,true);assert.equal(candidate.identity.handshake_verified,false);assert.deepEqual(candidate.pids,[]);
  }
});

test('Cline and Roo installation requires matching official extension manifest and never becomes VS Code online',()=>{
  const root='C:\\Users\\Fixture\\.vscode\\extensions',cline='saoudrizwan.claude-dev-4.1.23',roo='RooVeterinaryInc.roo-cline-3.53.0';
  const clineFile=root+'\\'+cline+'\\package.json',rooFile=root+'\\'+roo+'\\package.json';
  const options={files:[root,clineFile,rooFile],folders:{[root]:[cline,roo,'..\\saoudrizwan.claude-dev-1.0.0']},manifests:{[clineFile]:{publisher:'saoudrizwan',name:'claude-dev'},[rooFile]:{publisher:'RooVeterinaryInc',name:'roo-cline'}},processes:[{Name:'Code.exe',ProcessId:5,ExecutablePath:'C:\\VSCode\\Code.exe'}]};
  const catalog=fixture(options);
  for(const provider of ['cline','roo-code']){const candidate=get(catalog,provider);assert.equal(candidate.installed,true);assert.equal(candidate.running,false);assert.equal(candidate.identity.confidence,'extension_manifest');assert.equal(candidate.identity.handshake_verified,false);assert.deepEqual(candidate.pids,[]);}
  const impersonation=fixture({...options,manifests:{[clineFile]:{publisher:'unrelated',name:'claude-dev'},[rooFile]:{publisher:'RooVeterinaryInc',name:'another-extension'}}});
  assert.equal(get(impersonation,'cline').installed,false);assert.equal(get(impersonation,'roo-code').installed,false);
});

test('owned Gemini runtime validates the exact version namespace in a non-default data directory',()=>{
  const root='D:\\AgentOfficeData\\runtimes\\gemini-cli\\0.63.0-52791a63-0983-4879-a8c2-30fd6376984e';
  const node=root+'\\node\\node-v22.22.2-win-x64\\node.exe',script=root+'\\payload\\package\\bundle\\gemini.js';
  const env={USERPROFILE:'C:\\Users\\Fixture',PATH:'',AGENTROOM_GEMINI_PATH:node,AGENTROOM_GEMINI_SCRIPT:script};
  const candidate=get(fixture({env,files:[node,script]}),'gemini-cli');assert.equal(candidate.installed,true);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(geminiVendorScript(script),true);
  for(const invalid of [script.replace('0.63.0-52791a63-0983-4879-a8c2-30fd6376984e','0.63.0-unverified'),script.replace('package\\bundle','arbitrary'),script.replace('gemini.js','unknown.js'),root+'\\payload\\package\\bundle\\..\\bundle\\gemini.js'])assert.equal(geminiVendorScript(invalid),false,invalid);
});
