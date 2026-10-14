'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function fixture(candidates = []) {
  const elements = new Map(), calls = [], notices = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], showModal() { this.open = true; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, launchScanning: false, launchBusy: false, launchCandidates: candidates,
    launchSelection: new Set(), launchScannedAt: null, launchError: '', lastLaunchCandidates: '', webConnected: true,
    projectId: 'project', roomId: 'room', onboardingStarting: new Set(), onboardingJobs: new Map(),
    secretaryConnectRoom: null, secretaryConnectJob: null, secretaryError: '',
    escape: value => String(value), avatar: () => '', renderSecretary: () => {}, renderLaunch: () => {},
    toast: value => notices.push(value), api: async (route, body) => { calls.push({route,body}); return {candidates,scanned_at:'fixture'}; }
  });
  vm.runInContext(section('function launchProvider(', 'const providerDocs') +
    section('function onboardingCanInstall(', 'function renderLaunch()') +
    section('async function scanLaunch(', 'async function prepareLaunch()') +
    section('function openSecretaryConnect()', 'function updateOfficeScene()'), context);
  return {context, $, calls, notices};
}
test('running desktop agents appear first while unopened runtimes remain collapsed', () => {
  const state = fixture([
    {id:'qwen-code',name:'Uninstalled CLI',installable:true,capabilities:{automatic_launch:true}},
    {id:'doubao',name:'Running Doubao',installed:true,running:true,capabilities:{mcp_prepare:true}},
    {id:'qwen-desktop',name:'Running Qwen',installed:true,running:true,capabilities:{mcp_prepare:true}},
    {id:'grok-bot',name:'Running Grok',installed:true,running:true,capabilities:{manual_connect:true}},
    {id:'claude-code',name:'Closed Claude',installed:true,running:false,capabilities:{automatic_launch:true}}
  ]);
  state.context.renderLaunchCandidates();
  const html = state.$('launch-candidates').innerHTML, boundary = html.indexOf('<details');
  assert.ok(boundary > 0);
  for (const name of ['Running Doubao','Running Qwen','Running Grok']) assert.ok(html.slice(0,boundary).includes(name));
  for (const name of ['Uninstalled CLI','Closed Claude']) {
    assert.equal(html.slice(0,boundary).includes(name), false);
    assert.ok(html.slice(boundary).includes(name));
  }
  assert.doesNotMatch(html.slice(boundary).split('>')[0], /\bopen\b/);
  assert.equal(state.calls.length, 0, 'rendering never installs or starts an agent');
});
test('opening the picker requests one quiet inventory scan and never onboards a member', async () => {
  const state = fixture();
  state.context.openSecretaryConnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.$('secretary-connect-dialog').open, true);
  assert.equal(state.context.secretaryConnectRoom, 'room');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].route, '/api/launch/scan');
  assert.equal(state.notices.length, 0);
  state.context.webConnected = false;
  state.context.openSecretaryConnect();
  assert.equal(state.calls.length, 1);
});
