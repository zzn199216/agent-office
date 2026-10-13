'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers.cjs');
const { planClient, installClient } = require('../src/install-clients.cjs');

function setup(provider = 'codex') {
  const f = fixture(), home = path.join(f.root, 'user profile'), configHome = path.join(home, '.codex');
  fs.mkdirSync(configHome, { recursive: true });
  const executable = path.join(f.root, `${provider}.exe`), command = path.join(f.root, "AgentRoom $ & '中文.exe"), entry = path.join(f.root, "entry $ '中文.json");
  fs.writeFileSync(executable, 'fake CLI'); fs.writeFileSync(command, 'fake AgentRoom'); fs.writeFileSync(entry, '{"secret":"entry-secret-test-only"}');
  return { ...f, home, input: { provider, executable, command, args: [], entry_file: entry }, options: { homeDir: home, env: { CODEX_HOME: configHome, CLAUDE_CONFIG_DIR: '' } }, config: provider === 'codex' ? path.join(configHome, 'config.toml') : path.join(home, '.claude.json') };
}
function codexRunner(f, items = [], behavior = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.join(' ') === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(items) };
    assert.deepEqual(args.slice(0, 4), ['mcp', 'add', 'agentroom', '--']);
    if (behavior.fail) return { exitCode: 1, stderr: 'Bearer provider-secret-test-only' };
    if (!behavior.noWrite) {
      items.push({ name: 'agentroom', enabled: true, transport: { type: 'stdio', command: args[4], args: args.slice(5), env: {}, env_vars: [], cwd: null } });
      fs.appendFileSync(f.config, '\n[mcp_servers.agentroom]\n# fake CLI merged server\n');
    }
    return { exitCode: 0, stdout: 'provider-secret-test-only' };
  };
  return { runner, calls, items };
}
function claudeRunner(f, behavior = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.join(' ') === 'mcp add --help') return { exitCode: 0, stdout: behavior.old ? 'old help' : '--transport <stdio|http> --scope <user|project|local>' };
    assert.deepEqual(args.slice(0, 8), ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'agentroom', '--']);
    if (!behavior.noWrite) {
      const config = fs.existsSync(f.config) ? JSON.parse(fs.readFileSync(f.config, 'utf8')) : {};
      config.mcpServers ||= {};
      config.mcpServers.agentroom = { type: 'stdio', command: args[8], args: args.slice(9) };
      fs.writeFileSync(f.config, JSON.stringify(config));
    }
    return { exitCode: 0, stdout: 'Added AgentRoom. Bearer provider-secret-test-only' };
  };
  return { runner, calls };
}

test('user install plan uses literal argv, stable entry and no implicit model connection', () => {
  const f = setup(), plan = planClient(f.input, f.options);
  assert.equal(plan.status, 'planned'); assert.equal(plan.connected, false);
  assert.deepEqual(plan.args, ['mcp', '--entry', f.input.entry_file]);
  assert.deepEqual(plan.install_args, ['mcp', 'add', 'agentroom', '--', f.input.command, 'mcp', '--entry', f.input.entry_file]);
  assert.equal(plan.scope, 'user');
  assert.equal(fs.existsSync(f.config), false);
  assert.throws(() => planClient({ ...f.input, entry_file: 'relative.json' }, f.options), { code: 'client_install_input_invalid' });
});

test('Codex native CLI merges only AgentRoom and keeps an exact private backup', async () => {
  const f = setup(), original = 'model = "existing-model"\n[mcp_servers.other]\nkey = "provider-secret-test-only"\n';
  fs.writeFileSync(f.config, original);
  const other = { name: 'other', transport: { type: 'stdio', command: 'other.exe', env: { PRIVATE_KEY: 'provider-secret-test-only' } } };
  const fake = codexRunner(f, [other]), answer = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(answer.installed, true); assert.equal(answer.needs_reload, true); assert.equal(answer.connected, false);
  assert.equal(fs.readFileSync(answer.backup_file, 'utf8'), original);
  assert.equal(fs.readFileSync(f.config, 'utf8').startsWith(original), true);
  assert.deepEqual(fake.items[0], other);
  assert.equal(JSON.stringify(answer).includes('provider-secret-test-only'), false);
  assert.equal(JSON.stringify(answer).includes('entry-secret-test-only'), false);
  assert.equal(fake.calls.every(call => call.options.shell === false && call.options.windowsHide === true && call.options.cwd === f.home), true);
});

test('same Codex server is idempotent without another add or backup', async () => {
  const f = setup(), plan = planClient(f.input, f.options), original = '# untouched'; fs.writeFileSync(f.config, original);
  const fake = codexRunner(f, [{ name: 'agentroom', enabled: true, transport: { type: 'stdio', command: plan.command, args: plan.args, env: {}, env_vars: [] } }]);
  const answer = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(answer.installed, true); assert.equal(answer.unchanged, true); assert.equal(fake.calls.length, 1);
  assert.equal(fs.readFileSync(f.config, 'utf8'), original); assert.equal(fs.readdirSync(path.dirname(f.config)).length, 1);
});

test('different, disabled or secret-bearing AgentRoom configurations remain preserved', async () => {
  for (const update of [{ command: 'other.exe' }, { disabled: true }, { env: { SECRET: 'provider-secret-test-only' } }]) {
    const f = setup(), plan = planClient(f.input, f.options), item = { name: 'agentroom', enabled: true, transport: { type: 'stdio', command: plan.command, args: plan.args, ...update } };
    if (update.disabled) item.enabled = false;
    fs.writeFileSync(f.config, '# original'); const fake = codexRunner(f, [item]);
    const answer = await installClient(f.input, { ...f.options, runner: fake.runner });
    assert.equal(answer.reason, 'existing_agentroom'); assert.equal(answer.installed, false); assert.equal(fake.calls.length, 1);
    assert.equal(JSON.stringify(answer).includes('provider-secret-test-only'), false); assert.equal(fs.readFileSync(f.config, 'utf8'), '# original');
  }
});

test('a successful exit is not accepted without a matching stored configuration', async () => {
  const f = setup(), fake = codexRunner(f, [], { noWrite: true });
  const answer = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(answer.reason, 'client_install_unverified'); assert.equal(answer.installed, false); assert.equal(answer.connected, false);
});

test('Codex read/install failures suppress provider stdout and stderr', async () => {
  const f = setup(), failRead = await installClient(f.input, { ...f.options, runner: async () => ({ exitCode: 1, stdout: 'Bearer provider-secret-test-only', stderr: 'entry-secret-test-only' }) });
  assert.equal(failRead.reason, 'client_config_unreadable'); assert.equal(JSON.stringify(failRead).includes('secret-test-only'), false);
  fs.writeFileSync(f.config, '# original'); const fake = codexRunner(f, [], { fail: true });
  const failAdd = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(failAdd.reason, 'client_install_failed'); assert.equal(JSON.stringify(failAdd).includes('secret-test-only'), false);
  assert.equal(fs.readFileSync(failAdd.backup_file, 'utf8'), '# original');
});

test('Claude user scope keeps projects, unrelated MCPs and account configuration', async () => {
  const f = setup('claude-code'), original = { account: { private: 'provider-secret-test-only' }, projects: { project: { mcpServers: { legacy: { command: 'old' } } } }, mcpServers: { unrelated: { type: 'http', url: 'https://example.test/private' } } };
  const originalText = JSON.stringify(original, null, 2); fs.writeFileSync(f.config, originalText);
  const fake = claudeRunner(f), answer = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(answer.installed, true); assert.equal(answer.connected, false); assert.equal(answer.needs_reload, true);
  assert.equal(fs.readFileSync(answer.backup_file, 'utf8'), originalText);
  const after = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  assert.deepEqual(after.projects, original.projects); assert.deepEqual(after.account, original.account); assert.deepEqual(after.mcpServers.unrelated, original.mcpServers.unrelated);
  assert.equal(JSON.stringify(answer).includes('provider-secret-test-only'), false);
  assert.equal(fake.calls.every(call => call.options.shell === false && call.options.windowsHide === true), true);
  const repeated = await installClient(f.input, { ...f.options, runner: async () => { throw new Error('must not execute'); } });
  assert.equal(repeated.unchanged, true); assert.equal(repeated.installed, true);
});

test('Claude malformed configuration and unsupported CLI do not mutate files', async () => {
  const f = setup('claude-code'); fs.writeFileSync(f.config, '{broken');
  const malformed = await installClient(f.input, { ...f.options, runner: async () => { throw new Error('must not execute'); } });
  assert.equal(malformed.reason, 'client_config_invalid'); assert.equal(fs.readFileSync(f.config, 'utf8'), '{broken');
  fs.writeFileSync(f.config, '{}'); const fake = claudeRunner(f, { old: true });
  const old = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(old.reason, 'client_cli_incompatible'); assert.equal(fake.calls.length, 1); assert.equal(fs.readFileSync(f.config, 'utf8'), '{}');
});

test('Claude claims Added without storage and custom profiles are needs_setup', async () => {
  const f = setup('claude-code'), fake = claudeRunner(f, { noWrite: true });
  const unsaved = await installClient(f.input, { ...f.options, runner: fake.runner });
  assert.equal(unsaved.reason, 'client_install_unverified');
  const custom = planClient(f.input, { ...f.options, env: { CLAUDE_CONFIG_DIR: path.join(f.home, 'another-profile') } });
  assert.equal(custom.status, 'needs_setup'); assert.equal(custom.reason, 'custom_profile');
  assert.equal(planClient({ provider: 'doubao' }).reason, 'manual_import_required');
});

test('parallel requests serialize and add the same user server only once', async () => {
  const f = setup(), fake = codexRunner(f), answers = await Promise.all([installClient(f.input, { ...f.options, runner: fake.runner }), installClient(f.input, { ...f.options, runner: fake.runner })]);
  assert.equal(answers.every(answer => answer.installed), true);
  assert.equal(fake.calls.filter(call => call.args[1] === 'add').length, 1);
  assert.equal(answers.filter(answer => answer.unchanged).length, 1);
});

test('resolved Node CLI prefixes are argv while Windows shell shims are refused', () => {
  const f = setup(), prefix = path.join(f.root, 'known cli.js'), plan = planClient({ ...f.input, executable_args: [prefix] }, f.options);
  assert.equal(plan.install_args[0], prefix); assert.deepEqual(plan.install_args.slice(1, 5), ['mcp', 'add', 'agentroom', '--']);
  if (process.platform === 'win32') {
    const shim = path.join(f.root, 'codex.cmd'); fs.writeFileSync(shim, 'echo fake');
    assert.equal(planClient({ ...f.input, executable: shim }, f.options).reason, 'native_cli_required');
  }
});

test('Claude Desktop plans a bound stdio MCP config without executing or requiring a provider CLI', () => {
  const f = setup('claude-desktop'), plan = planClient({ ...f.input, executable: undefined }, f.options);
  assert.equal(plan.status, 'planned'); assert.equal(plan.installation_method, 'desktop_json'); assert.equal(plan.connected, false);
  assert.equal(plan.configuration_file, path.join(f.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.deepEqual(plan.configuration, { command: f.input.command, args: ['mcp', '--entry', f.input.entry_file] });
  assert.equal(plan.configuration.args.includes('--setup'), false); assert.equal(fs.existsSync(plan.configuration_file), false);
});

test('Claude Desktop merges the real JSON profile and keeps unknown settings, other MCPs and a private backup', async () => {
  const f = setup('claude-desktop'), config = planClient(f.input, f.options).configuration_file;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = { preferences: { theme: 'dark' }, customUnknown: { private: 'provider-secret-test-only' }, mcpServers: { other: { command: 'unrelated.exe', args: ['--keep'], env: { KEY: 'provider-secret-test-only' } } } };
  const originalText = '\uFEFF' + JSON.stringify(original, null, 4); fs.writeFileSync(config, originalText);
  let executed = false;
  const answer = await installClient(f.input, { ...f.options, runner: async () => { executed = true; throw new Error('must not execute GUI/CLI'); } });
  assert.equal(answer.status, 'configured'); assert.equal(answer.installed, true); assert.equal(answer.connected, false); assert.equal(answer.can_wake, false); assert.equal(answer.needs_reload, true);
  assert.equal(executed, false); assert.equal(fs.readFileSync(answer.backup_file, 'utf8'), originalText);
  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.deepEqual(after.preferences, original.preferences); assert.deepEqual(after.customUnknown, original.customUnknown); assert.deepEqual(after.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(after.mcpServers.agentroom.args, ['mcp', '--entry', f.input.entry_file]);
  assert.equal(JSON.stringify(answer).includes('provider-secret-test-only'), false); assert.equal(JSON.stringify(answer).includes('entry-secret-test-only'), false);
  const repeated = await installClient(f.input, f.options);
  assert.equal(repeated.status, 'configured'); assert.equal(repeated.unchanged, true); assert.equal(repeated.connected, false);
  assert.equal(fs.readdirSync(path.dirname(config)).filter(name => name.includes('agentroom-backup')).length, 1);
});

test('Claude Desktop existing mismatched, disabled, malformed or unknown AgentRoom server remains untouched', async () => {
  for (const server of [{ command: 'different.exe' }, { command: 'different.exe', disabled: true }, null]) {
    const f = setup('claude-desktop'), config = planClient(f.input, f.options).configuration_file;
    fs.mkdirSync(path.dirname(config), { recursive: true }); const original = JSON.stringify({ mcpServers: { agentroom: server }, unknown: 'keep' }); fs.writeFileSync(config, original);
    const answer = await installClient(f.input, f.options);
    assert.equal(answer.reason, 'existing_agentroom'); assert.equal(answer.installed, false); assert.equal(fs.readFileSync(config, 'utf8'), original);
    assert.equal(fs.readdirSync(path.dirname(config)).length, 1);
  }
  const f = setup('claude-desktop'), config = planClient(f.input, f.options).configuration_file;
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, '{broken');
  const malformed = await installClient(f.input, f.options);
  assert.equal(malformed.reason, 'client_config_invalid'); assert.equal(fs.readFileSync(config, 'utf8'), '{broken');
});

test('Claude Desktop selects the actual existing Store profile and does not create a ghost standard config', async () => {
  const f = setup('claude-desktop'), store = path.join(f.home, 'AppData', 'Local', 'Packages', 'Claude_fixturefamily', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, '{"mcpServers":{"old":{"command":"keep"}},"preferences":{"keep":true}}');
  const plan = planClient(f.input, f.options); assert.equal(plan.configuration_file, store);
  const answer = await installClient(f.input, f.options);
  assert.equal(answer.status, 'configured'); assert.equal(answer.configuration_file, store);
  assert.equal(fs.existsSync(path.join(f.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).preferences.keep, true);
});

test('Claude Desktop refuses ambiguous profiles unless the actual WindowsApps executable identifies its family', async () => {
  const f = setup('claude-desktop'), standard = path.join(f.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), store = path.join(f.home, 'AppData', 'Local', 'Packages', 'Claude_fixturefamily', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
  for (const file of [standard, store]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); }
  const ambiguous = await installClient(f.input, f.options);
  assert.equal(ambiguous.reason, 'custom_profile'); assert.equal(fs.readFileSync(standard, 'utf8'), '{}'); assert.equal(fs.readFileSync(store, 'utf8'), '{}');
  const input = { ...f.input, executable: path.join(f.root, 'Program Files', 'WindowsApps', 'Claude_2.0.0_x64__fixturefamily', 'app', 'Claude.exe') };
  const plan = planClient(input, f.options); assert.equal(plan.configuration_file, store);
  const selected = await installClient(input, f.options);
  assert.equal(selected.status, 'configured'); assert.equal(fs.readFileSync(standard, 'utf8'), '{}');
});

test('Claude Desktop keeps redirected roaming paths and refuses the calling app Store cache or arbitrary helper paths', () => {
  const f = setup('claude-desktop'), redirected = path.join(f.root, 'real redirected roaming');
  const explicit = planClient(f.input, { ...f.options, env: { APPDATA: redirected } });
  assert.equal(explicit.configuration_file, path.join(redirected, 'Claude', 'claude_desktop_config.json'));
  const virtual = path.join(f.home, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_fixture', 'LocalCache', 'Roaming');
  assert.equal(planClient(f.input, { ...f.options, env: { APPDATA: virtual } }).reason, 'custom_profile');
  assert.equal(planClient(f.input, { ...f.options, configuration_file: path.join(f.root, 'other.json') }).reason, 'custom_profile');
});

test('Claude Desktop parallel preparations serialize the profile merge and preserve one server', async () => {
  const f = setup('claude-desktop'), results = await Promise.all([installClient(f.input, f.options), installClient(f.input, f.options)]);
  assert.equal(results.every(result => result.installed && result.connected === false), true);
  assert.equal(results.filter(result => result.unchanged === true).length, 1);
  assert.equal(results.every(result => result.status === 'configured'), true);
});
