'use strict';
// Opt-in live validation with the user's configured Claude API. Uses a fresh
// local room and project, never the user's existing rooms or MCP configuration.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { serve, apiCall } = require('../src/main.cjs');
const { detectClaude } = require('../src/claude.cjs');
const {userSettingsFile}=require('../src/claude.cjs'),crypto=require('node:crypto');
const { id, sleep } = require('../src/util.cjs');
async function main() {
  const executable = detectClaude();
  const configFile=userSettingsFile(),configHash=crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  if (!executable) throw new Error('Claude native CLI is missing.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-claude-gateway-'));
  const projectPath = path.join(root, 'project'), dataDir = path.join(root, 'data');
  fs.mkdirSync(projectPath); fs.writeFileSync(path.join(projectPath, 'README.md'), 'Isolated Claude gateway validation.\n');
  const packaged = process.argv[2];
  const run = args => {
    const result = spawnSync(packaged, [...args, '--data-dir', dataDir], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Packaged service command failed.');
    return result.stdout;
  };
  if (packaged) run(['start']);
  const host = packaged ? { stop: async () => { run(['stop']); } } : await serve(dataDir, { port: 0 });
  const api = (route, input) => apiCall(dataDir, route, input);
  try {
    const project = await api('/api/projects', { name: 'Claude gateway validation', path: projectPath });
    const room = await api('/api/chat/rooms', { project_id: project.id, title: 'Isolated API handshake' });
    const member = await api('/api/chat/members', { name: 'Claude gateway validation', adapter: 'claude-code', executable });
    await api(`/api/chat/members/${member.id}/connect`, { room_id: room.id });
    const deadline = Date.now() + 120000;
    let connected;
    do { await sleep(500); connected = await api(`/api/chat/members/${member.id}`); } while (connected.status === 'connecting' && Date.now() < deadline);
    if (connected.status !== 'ready' || !connected.verified_at) throw new Error('Real Claude MCP handshake did not complete.');
    const before = await api(`/api/chat/rooms/${room.id}`);
    const native = before.participants.find(item => item.id === member.id)?.native_thread_id;
    if (!native) throw new Error('Native session binding is missing.');
    const imagePath=path.resolve('output/validation/claude-vision-fixture.png'),vision=fs.existsSync(imagePath);
    const expected=vision?JSON.parse(fs.readFileSync(path.resolve('output/validation/claude-vision-fixture.json'),'utf8')).label:'ARKLUMI_AGENTOFFICE_OK';
    const request = await api('/api/chat/messages', { room_id: room.id, sender_id: 'user', to_member_id: member.id, text: vision?'Reply only with the large text in the attached image. Do not call tools or read files.':'Reply with exactly ARKLUMI_AGENTOFFICE_OK. Do not call tools or read files.',attachments:vision?[{name:'vision.png',data_url:'data:image/png;base64,'+fs.readFileSync(imagePath).toString('base64')}]:undefined, idempotency_key: id() });
    let result;
    do { result = await api(`/api/chat/messages/${request.id}/wait?seconds=10`); } while (!result.responses.length && !['failed', 'uncertain', 'cancelled'].includes(result.message.status) && Date.now() < deadline);
    const reply = result.responses.find(message => message.sender_id === member.id && message.text.trim()===expected);
    if (!reply) throw new Error('Real Claude reply was not recorded in the isolated room.');
    const after = await api(`/api/chat/rooms/${room.id}`);
    assertUnchanged();const evidence = { tested_at: new Date().toISOString(), packaged_runtime: !!packaged, restricted_mode: true, real_model_called: true, real_mcp_join_verified: true, resumed_session_verified: after.participants.find(item => item.id === member.id)?.native_thread_id === native, room_reply_verified: true, image_input_verified:vision,result: reply.text, existing_rooms_changed: false, user_configuration_changed: false, isolated_directory: root };
    const output = path.resolve(__dirname, `../output/validation/claude-gateway-${packaged ? 'packaged' : 'runtime'}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  } finally { await host.stop();assertUnchanged(); }
  function assertUnchanged(){if(crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex')!==configHash)throw new Error('User configuration changed during validation.');}
}
if (require.main === module) main().catch(() => { console.error('Claude gateway validation failed; no provider output or credentials printed.'); process.exitCode = 1; });
