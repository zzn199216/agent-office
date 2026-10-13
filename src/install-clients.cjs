'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { RoomError, atomicWrite } = require('./util.cjs');

// Only the user profile is changed. The provider CLI performs the merge so we
// do not reinterpret TOML or rewrite a project's settings. CLI output may hold
// private configuration: keep it internal and return bounded, fixed messages.
const pending = new Map();
const SOURCES = {
  codex: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
  'claude-code': 'https://code.claude.com/docs/en/mcp',
  'claude-desktop': 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
  doubao:'https://open.doubao.com/',
  opencode:'https://opencode.ai/docs/mcp-servers/',
  'cherry-studio':'https://docs.cherryai.com.cn/advanced-basic/extensions/mcp.md',
  cline:'https://docs.cline.bot/mcp/mcp-overview',
  'roo-code':'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/'
};
const MANUAL_IMPORT = new Set(['doubao','opencode','cherry-studio','cline','roo-code']);

function literal(value, field) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\0\r\n]/.test(value)) throw new RoomError(`${field} 无效。`, 400, 'client_install_input_invalid');
  return value;
}
function literalArgs(value, field) {
  if (!Array.isArray(value) || value.length > 32) throw new RoomError(`${field} 必须是参数数组。`, 400, 'client_install_input_invalid');
  return value.map(item => literal(item, field));
}
function absoluteFile(value, field) {
  literal(value, field);
  if (!path.isAbsolute(value)) throw new RoomError(`${field} 必须是绝对路径。`, 400, 'client_install_input_invalid');
  return path.normalize(value);
}
function regularFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
function desktopConfiguration(home, roaming, input, options) {
  const packages = path.join(home, 'AppData', 'Local', 'Packages'), standard = path.join(roaming, 'Claude', 'claude_desktop_config.json');
  const relative = file => path.relative(home, file).replace(/\\/g, '/');
  const knownProfile = file => {
    if (path.resolve(file).toLocaleLowerCase() === path.resolve(standard).toLocaleLowerCase()) return true;
    return /^AppData\/Local\/Packages\/Claude_[a-z0-9]+\/LocalCache\/Roaming\/Claude\/claude_desktop_config\.json$/i.test(relative(path.resolve(file)));
  };
  if (options.configuration_file !== undefined) {
    const explicit = options.configuration_file;
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit) || !knownProfile(explicit)) return { file: null, custom: true };
    return { file: path.normalize(explicit) };
  }
  // Claude's own Store package profile is distinct from the calling Codex
  // package profile. Use only known Claude family names and metadata paths.
  const family = String(input?.executable || '').match(/[/\\]WindowsApps[/\\]Claude_[^/\\]+__([a-z0-9]+)[/\\]/i)?.[1];
  if (family) {
    const packageHome = path.join(packages, 'Claude_' + family);
    if (!fs.existsSync(packageHome)) return { file: null, custom: true };
    return { file: path.join(packageHome, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json') };
  }
  const existing = [];
  if (regularFile(standard)) existing.push(standard);
  try {
    for (const name of fs.readdirSync(packages)) if (/^Claude_[a-z0-9]+$/i.test(name)) {
      const file = path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
      if (regularFile(file)) existing.push(file);
    }
  } catch (error) { if (error.code !== 'ENOENT') return { file: null, custom: true }; }
  // Two independent profiles cannot be silently reconciled from process name.
  // Selecting the actual WindowsApps family above resolves this ambiguity.
  if (existing.length > 1) return { file: null, custom: true };
  return { file: existing[0] || standard };
}
function userPaths(provider, options, input) {
  const env = { ...process.env, ...(options.env || {}) };
  const home = path.resolve(options.homeDir || env.USERPROFILE || os.homedir());
  if (provider === 'codex') return { home, env, file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml') };
  if (provider === 'claude-desktop') {
    // A supplied APPDATA supports a real redirected Windows roaming profile.
    // Tests with a supplied home must never fall through to the host profile.
    // The calling Codex Store package's LocalCache is not Claude's profile.
    const explicitAppData = options.env && Object.hasOwn(options.env, 'APPDATA');
    const virtualized = value => /[/\\]AppData[/\\]Local[/\\]Packages[/\\][^/\\]+[/\\]LocalCache[/\\]/i.test(value || '');
    const roaming = explicitAppData ? env.APPDATA : (options.homeDir || virtualized(env.APPDATA)) ? path.join(home, 'AppData', 'Roaming') : env.APPDATA || path.join(home, 'AppData', 'Roaming');
    if (typeof roaming !== 'string' || !path.isAbsolute(roaming) || virtualized(roaming)) return { home, env, file: null, custom: true };
    return { home, env, ...desktopConfiguration(home, roaming, input, options) };
  }
  // The published default user MCP file is ~/.claude.json. A custom config
  // directory can change the account/profile; do not guess a different file.
  if (env.CLAUDE_CONFIG_DIR) return { home, env, file: null, custom: true };
  return { home, env, file: path.join(home, '.claude.json') };
}
function result(plan, reason, detail, extra = {}) {
  return { provider: plan.provider, server_name: plan.server_name || 'agentroom', scope: 'user', status: 'needs_setup', installed: false, needs_reload: false, connected: false, reason, detail, configuration_file: plan.configuration_file || null, ...extra };
}

// `executable` is the discovered provider CLI; `command` / `args` are our own
// AgentRoom launcher prefix. Optional executable_args supports a known Node
// CLI entrypoint without invoking a .cmd shim or interpolating shell strings.
function planClient(input, options = {}) {
  const provider = input?.provider === 'claude' ? 'claude-code' : input?.provider;
  const plan = { provider, server_name: 'agentroom', scope: 'user', connected: false, installed: false };
  if(MANUAL_IMPORT.has(provider))return result(plan,'manual_import_required','此客户端使用本人窗口的原生 MCP 接入，请先准备专属配置再手动导入。',{needs_import:true,import_kind:provider==='doubao'?'form':'json',source:SOURCES[provider],can_wake:false});
  if (!SOURCES[provider]) return result(plan, 'client_not_supported', '这个客户端尚无自动 MCP 安装适配器。');
  const command = absoluteFile(input.command, 'AgentRoom 程序');
  const entryFile = absoluteFile(input.entry_file, '成员入口文件');
  const cliArgs = literalArgs(input.executable_args || [], '客户端前置参数');
  const args = [...literalArgs(input.args || [], 'AgentRoom 前置参数'), 'mcp', '--entry', entryFile];
  const paths = userPaths(provider, options, input);
  plan.configuration_file = paths.file;
  if (paths.custom) return result(plan, 'custom_profile', '无法确认 Claude 的实际用户配置目录，未写入其他应用的配置。');
  if (!regularFile(command) || !regularFile(entryFile)) return result(plan, 'entry_missing', 'AgentRoom 程序或长期成员入口文件不存在。');
  if (provider === 'claude-desktop') return { ...plan, status: 'planned', needs_reload: true, source: SOURCES[provider], command, args, entry_file: entryFile, installation_method: 'desktop_json', configuration: { command, args } };
  const executable = absoluteFile(input.executable, '客户端 CLI');
  if (!regularFile(executable)) return result(plan, 'client_cli_missing', '没有找到可执行的客户端 CLI。');
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(executable)) return result(plan, 'native_cli_required', '需要客户端原生程序或已解析的 Node CLI，不能用 shell 脚本安装。');
  const addArgs = provider === 'codex'
    ? ['mcp', 'add', 'agentroom', '--', command, ...args]
    : ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'agentroom', '--', command, ...args];
  return { ...plan, status: 'planned', needs_reload: true, source: SOURCES[provider], executable, executable_args: cliArgs, command, args, entry_file: entryFile, install_args: [...cliArgs, ...addArgs] };
}

function run(command, args, options) {
  return new Promise(resolve => {
    let settled = false, stdout = '', stderr = '', bytes = 0;
    let child;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let timer;
    try { child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish({ exitCode: -1, error: 'spawn_failed' }); return; }
    timer = setTimeout(() => { child.kill(); finish({ exitCode: -1, error: 'timeout' }); }, options.timeout || 15000);
    const receive = field => chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); finish({ exitCode: -1, error: 'output_limit' }); return; }
      if (field === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', receive('stdout')); child.stderr.on('data', receive('stderr'));
    child.once('error', () => finish({ exitCode: -1, error: 'spawn_failed' }));
    child.once('close', exitCode => finish({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}
function sameConfig(config, plan) {
  if (!config || typeof config !== 'object' || config.enabled === false || config.disabled === true) return false;
  const transport = config.transport || config;
  if (transport.type && transport.type !== 'stdio') return false;
  if (transport.command !== plan.command || JSON.stringify(transport.args || []) !== JSON.stringify(plan.args)) return false;
  if (Object.keys(transport.env || {}).length || (transport.env_vars || []).length || transport.cwd) return false;
  return true;
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new RoomError('客户端配置不是可备份的普通文件。', 409, 'client_config_invalid');
  const destination = `${file}.agentroom-backup-${Date.now()}-${crypto.randomUUID()}`;
  fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(destination, 0o600); } catch {}
  return destination;
}
function readClaude(file) {
  if (!fs.existsSync(file)) return null;
  if (!regularFile(file) || fs.statSync(file).size > 8 * 1024 * 1024) throw new RoomError('Claude 用户配置无效。', 409, 'client_config_invalid');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new RoomError('Claude 用户配置不是有效 JSON。', 409, 'client_config_invalid'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || (parsed.mcpServers && (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) throw new RoomError('Claude 用户配置结构无效。', 409, 'client_config_invalid');
  return parsed.mcpServers?.agentroom || null;
}
function readDesktop(file) {
  if (!fs.existsSync(file)) return { original: null, document: {} };
  if (!regularFile(file) || fs.statSync(file).size > 8 * 1024 * 1024) throw new RoomError('Claude 桌面配置无效。', 409, 'client_config_invalid');
  const original = fs.readFileSync(file, 'utf8'); let document;
  try { document = JSON.parse(original.replace(/^\uFEFF/, '')); } catch { throw new RoomError('Claude 桌面配置不是有效 JSON。', 409, 'client_config_invalid'); }
  if (!document || Array.isArray(document) || typeof document !== 'object' || (document.mcpServers !== undefined && (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers)))) throw new RoomError('Claude 桌面配置结构无效。', 409, 'client_config_invalid');
  return { original, document };
}
async function installDesktop(plan) {
  let before;
  try { before = readDesktop(plan.configuration_file); } catch (error) { return result(plan, error.code || 'client_config_unreadable', '无法安全读取实际 Claude 桌面配置，未更改它。'); }
  if (Object.hasOwn(before.document.mcpServers || {}, 'agentroom')) {
    if (!sameConfig(before.document.mcpServers.agentroom, plan)) return result(plan, 'existing_agentroom', '实际 Claude 桌面档案已有不同的 AgentRoom 配置，已保留。');
    return { ...result(plan, null, '同一 AgentRoom MCP 已配置；请在 Claude 本人窗口实际调用工具完成接入。'), status: 'configured', installed: true, needs_reload: true, unchanged: true, can_wake: false };
  }
  let backupFile;
  try { backupFile = backup(plan.configuration_file); } catch { return result(plan, 'client_backup_failed', '实际 Claude 桌面配置无法备份，未更改它。'); }
  try {
    // Preserve every unrelated server and unknown JSON field. Neither existing
    // credentials nor the entry secret are included in returned plan/results.
    const current = readDesktop(plan.configuration_file);
    if (current.original !== before.original) return result(plan, 'client_config_changed', 'Claude 桌面配置刚刚发生变化，未覆盖它，请重新尝试。', { backup_file: backupFile });
    const document = { ...before.document, mcpServers: { ...(before.document.mcpServers || {}), agentroom: plan.configuration } };
    atomicWrite(plan.configuration_file, JSON.stringify(document, null, 2) + '\n');
    if (!sameConfig(readDesktop(plan.configuration_file).document.mcpServers.agentroom, plan)) return result(plan, 'client_install_unverified', '已写入配置，但尚未确认对应成员入口。', { backup_file: backupFile });
  } catch { return result(plan, 'client_install_failed', 'Claude 桌面配置未确认写入成功；已有备份保留，未关闭或重启窗口。', { backup_file: backupFile }); }
  return { ...result(plan, null, 'AgentRoom MCP 已配置到实际 Claude 桌面档案；重新加载工具后，在 Claude 本人窗口完成接入。'), status: 'configured', installed: true, needs_reload: true, unchanged: false, can_wake: false, backup_file: backupFile };
}
async function installPlanned(plan, options) {
  if (plan.provider === 'claude-desktop') return installDesktop(plan);
  const paths = userPaths(plan.provider, options);
  const runner = options.runner || run;
  const exec = async args => {
    try {
      const output = await runner(plan.executable, [...plan.executable_args, ...args], { cwd: paths.home, env: paths.env, windowsHide: true, shell: false, timeout: 15000 });
      return { exitCode: output?.exitCode ?? output?.code ?? output?.status ?? -1, stdout: output?.stdout || '', stderr: output?.stderr || '' };
    } catch { return { exitCode: -1 }; }
  };
  const read = async () => {
    if (plan.provider === 'claude-code') return readClaude(plan.configuration_file);
    const output = await exec(['mcp', 'list', '--json']);
    if (output.exitCode !== 0) throw new RoomError('无法读取 Codex MCP 配置。', 503, 'client_config_unreadable');
    let items; try { items = JSON.parse(output.stdout); } catch { throw new RoomError('Codex CLI 未返回可识别的 MCP 配置。', 409, 'client_cli_incompatible'); }
    if (!Array.isArray(items)) throw new RoomError('Codex CLI 未返回可识别的 MCP 配置。', 409, 'client_cli_incompatible');
    return items.find(item => item.name === 'agentroom') || null;
  };
  let existing;
  try { existing = await read(); } catch (error) { return result(plan, error.code || 'client_config_unreadable', '无法安全读取当前客户端配置，未更改它。'); }
  if (existing) {
    if (!sameConfig(existing, plan)) return result(plan, 'existing_agentroom', '已有不同的 AgentRoom 配置，已保留；请从当前客户端核对入口。');
    return { ...result(plan, null, '同一 AgentRoom MCP 配置已存在。'), status: 'installed', installed: true, needs_reload: true, unchanged: true };
  }
  if (plan.provider === 'claude-code') {
    const help = await exec(['mcp', 'add', '--help']);
    if (help.exitCode !== 0 || !help.stdout.includes('--scope') || !help.stdout.includes('--transport')) return result(plan, 'client_cli_incompatible', '当前 Claude CLI 未确认支持用户范围的 stdio MCP 安装。');
  }
  let backupFile;
  try { backupFile = backup(plan.configuration_file); } catch { return result(plan, 'client_backup_failed', '客户端配置无法备份，未执行安装。'); }
  // This is the sole mutation. Every value remains a separate argv element.
  const output = await exec(plan.install_args.slice(plan.executable_args.length));
  if (output.exitCode !== 0) return result(plan, 'client_install_failed', '客户端 CLI 没有确认安装成功；原配置备份已保留。', { backup_file: backupFile });
  let installed;
  try { installed = await read(); } catch { return result(plan, 'client_install_unverified', '客户端已返回成功，但配置尚未核验。', { backup_file: backupFile }); }
  if (!sameConfig(installed, plan)) return result(plan, 'client_install_unverified', '客户端返回成功后未发现对应的 MCP 配置。', { backup_file: backupFile });
  return { ...result(plan, null, 'AgentRoom MCP 已安装到用户配置；已有窗口需重新加载工具。'), status: 'installed', installed: true, needs_reload: true, unchanged: false, backup_file: backupFile };
}
async function installClient(input, options = {}) {
  const plan = planClient(input, options);
  if (plan.status !== 'planned') return plan;
  const key = `${plan.provider}:${plan.configuration_file}`;
  const before = pending.get(key) || Promise.resolve();
  const operation = before.catch(() => {}).then(() => installPlanned(plan, options));
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}

// Writes only an Agent Office owned import file. It never guesses or mutates a
// native client's config path, imports a plugin, or starts a model process.
function prepareManualClient(input = {}) {
  const provider=input.provider,plan={provider,server_name:'agentroom',scope:'user',connected:false,installed:false};
  if(!MANUAL_IMPORT.has(provider))return result(plan,'client_not_supported','没有此客户端的原生导入材料。');
  const data=absoluteFile(input.data_dir,'Agent Office 数据目录'),entry=absoluteFile(input.entry_file,'成员入口文件');
  const command=absoluteFile(input.command,'Agent Office 程序'),prefix=literalArgs(input.args||[],'Agent Office 前置参数');
  if(path.resolve(path.dirname(entry))!==path.resolve(path.join(data,'entries'))||!/^([a-f0-9-]{36})-([a-f0-9-]{36})\.json$/i.test(path.basename(entry)))throw new RoomError('导入配置不属于当前本机成员入口。',403,'client_config_scope_mismatch');
  if(!regularFile(command)||!regularFile(entry))return result(plan,'entry_missing','Agent Office 程序或长期成员入口文件不存在。',{source:SOURCES[provider],can_wake:false});
  const canonicalData=fs.realpathSync.native(data),canonicalEntry=fs.realpathSync.native(entry),relative=path.relative(canonicalData,canonicalEntry);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new RoomError('成员入口超出 Agent Office 数据目录。',403,'client_config_scope_mismatch');
  if(fs.statSync(entry).size>64000)throw new RoomError('成员入口文件无效。',400,'invalid_resume_card');
  let card;try{card=JSON.parse(fs.readFileSync(entry,'utf8'));}catch{throw new RoomError('成员入口文件无效。',400,'invalid_resume_card');}
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const {CARD_SCHEMA,CARD_VERSION}=require('./resume.cjs');
  if(card?.schema!==CARD_SCHEMA||card.version!==CARD_VERSION||!uuid.test(card?.room_id||'')||!uuid.test(card?.member_id||'')||!uuid.test(card?.credential_id||'')||!/^[A-Za-z0-9_-]{43}$/.test(card?.secret||''))throw new RoomError('成员入口身份无效。',400,'invalid_resume_card');
  const expected=path.join(data,'entries',`${card.member_id}-${card.room_id}.json`);
  if(path.resolve(entry)!==path.resolve(expected))throw new RoomError('导入配置不属于当前本机成员入口。',403,'client_config_scope_mismatch');
  const source=SOURCES[provider],args=[...prefix,'mcp','--entry',entry];let material,detail;
  if(provider==='doubao'){
    if(!input.local_url)return result(plan,'local_transport_not_started','请启动本机 Agent Office 后，再准备豆包个人连接器字段。',{source,can_wake:false});
    const {createQwenMcpConfig}=require('./mcp-http.cjs'),url=createQwenMcpConfig(input.local_url,card).mcpServers.agentroom.url;
    detail='个人连接器字段已准备；在豆包本地电脑模式手动填写，再从本人窗口实际调用接入工具。';
    material={manual_fields:{name:'Agent Office',transport:'HTTP',url,headers:{}},source,instructions:'在豆包原生技能/连接器管理中选择新建自定义连接器。名称、HTTP 传输和服务器 URL 按字段填写，自定义 Headers 留空；只在本地电脑模式使用。若本人表单没有 HTTP 或拒绝本机地址，报告这一具体阻碍。此材料不是豆包 JSON 导入合同。HTTP 需要 Agent Office 服务运行；服务停止后先启动软件，再重试。保存并启用后，在豆包本人对话中实际调用 agentroom_room_ensure 与 agentroom_heartbeat。',conditional_stdio:{condition:'仅在本人原生表单确实提供 STDIO 传输时使用，工具真实调用后才能验收；不会唤醒豆包模型。',command,args,env:{}}};
  }else{
    let configuration={command,args,env:{}};
    if(provider==='cline')configuration={...configuration,disabled:false,autoApprove:[]};
    if(provider==='roo-code')configuration={...configuration,disabled:false,alwaysAllow:[]};
    const config=provider==='opencode'?{$schema:'https://opencode.ai/config.json',mcp:{agentroom:{type:'local',command:[command,...args],enabled:true}}}:{mcpServers:{agentroom:configuration}};
    const instructions={opencode:'在 OpenCode 的实际 opencode.json / opencode.jsonc 中合并本机 mcp.agentroom 条目，保留其他配置和同名现有入口；本轮不启动 OpenCode 模型服务。重新加载后在本人会话实际调用 agentroom_room_ensure 与 agentroom_heartbeat。',
      'cherry-studio':'在 Cherry Studio 设置 → MCP → 添加中导入此 JSON，启用并检查工具列表，再将这个服务器绑定给你选定的 Agent。在该 Agent 本人会话实际调用 agentroom_room_ensure 与 agentroom_heartbeat。',
      cline:'在 Cline 扩展面板 MCP Servers → Configure → Configure MCP Servers 打开的实际 JSON 中合并 mcpServers.agentroom，保留其他服务器和同名已有配置。autoApprove 初始为空；重新加载后在本人会话实际调用 agentroom_room_ensure 与 agentroom_heartbeat。',
      'roo-code':'在 Roo Code MCP 面板 Edit Global MCP 或用户明确选定项目的 Edit Project MCP 打开的实际 JSON 中合并 mcpServers.agentroom。项目同名条目覆盖全局，保留其他条目。alwaysAllow 初始为空；重新加载后在本人会话实际调用 agentroom_room_ensure 与 agentroom_heartbeat。'}[provider];
    material={config,instructions,source};detail='专属本机 MCP 配置已准备；在所选客户端手动导入、启用，再从本人会话完成真实握手。';
  }
  let directory=data;
  for(const segment of ['client-config',provider]){
    directory=path.join(directory,segment);
    if(!fs.existsSync(directory))fs.mkdirSync(directory);
    const canonicalDirectory=fs.realpathSync.native(directory),directoryRelative=path.relative(canonicalData,canonicalDirectory);
    if(directoryRelative==='..'||directoryRelative.startsWith('..'+path.sep)||path.isAbsolute(directoryRelative))throw new RoomError('导入目录超出 Agent Office 数据目录。',403,'client_config_scope_mismatch');
  }
  const file=path.join(directory,`${card.room_id}-${card.member_id}.json`),text=JSON.stringify(material,null,2)+'\n';
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new RoomError('导入材料不能是另一个文件的链接。',403,'client_config_scope_mismatch');
  // Atomic write replaces only this owned material. Repeated preparation leaves
  // the original identity, credential and client's unrelated config unchanged.
  if(!regularFile(file)||fs.readFileSync(file,'utf8')!==text)atomicWrite(file,text);
  try{fs.chmodSync(file,0o600);}catch{}
  return {...result({...plan,configuration_file:file},null,detail),status:'awaiting_import',needs_import:true,needs_reload:false,import_kind:provider==='doubao'?'form':'json',source,can_wake:false};
}
module.exports = { planClient, installClient, prepareManualClient };
