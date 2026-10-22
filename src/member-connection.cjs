'use strict';
// One place that turns internal onboarding / connection-assist snapshots into
// what a person sees: one of five states, one headline, one primary action,
// at most one secondary action. Internal stages stay available for details and
// diagnostics but never drive the UI directly.
//
// This module is a pure projection: it never starts, retries or changes a
// connection. Callers keep their existing safety checks for every operation.

const STATES = Object.freeze(['not_connected', 'waiting', 'connected', 'auto', 'attention']);

const SHORT_NAMES = {
  codex: 'Codex', 'claude-code': 'Claude Code', 'qwen-code': 'Qwen Code', 'gemini-cli': 'Gemini CLI',
  'claude-desktop': 'Claude', 'qwen-desktop': 'Qwen', doubao: '豆包', 'grok-bot': 'Grok',
  opencode: 'OpenCode', 'cherry-studio': 'Cherry Studio', cline: 'Cline', 'roo-code': 'Roo Code'
};
const MANAGED = new Set(['codex', 'claude-code', 'qwen-code', 'gemini-cli']);
const WAKE_CAPABLE = new Set(['qwen-desktop', 'doubao']);

const BUSY_STAGES = new Set(['connecting', 'preparing_connection', 'installing_runtime', 'verifying_reply', 'restoring_native', 'waiting_other_setup', 'authentication']);
const CODEX_REPAIR_CODES = new Set(['codex_auth_ownership_required', 'codex_personal_auth_owner_conflict']);
const FAILED = new Set(['error', 'interrupted', 'failed', 'cancelled']);
const INCOMPATIBLE = /UNSUPPORTED_SOURCE|adapter_unverified|contract|desktop_version|不兼容/i;

function shortName(provider, fallback) { return SHORT_NAMES[provider] || fallback || provider || '这位成员'; }

function operationsOf(snapshot) {
  const list = Array.isArray(snapshot?.next_actions) ? snapshot.next_actions : [];
  return list.map(value => ({ ...value, operation: value?.operation || value?.kind || value?.type })).filter(value => typeof value.operation === 'string');
}

function offered(snapshot, operation) {
  return operationsOf(snapshot).find(value => value.operation === operation) || null;
}

function button(operation, label, extra = {}) { return { operation, label, ...extra }; }

// Prefer the exact action the backend offered (it carries scope such as
// target_member_id); otherwise describe the action without extra scope.
function pick(snapshot, operation, label) {
  const found = offered(snapshot, operation);
  if (!found) return button(operation, label);
  const out = button(operation, label);
  for (const key of ['target_member_id', 'room_id', 'provider']) if (found[key] !== undefined) out[key] = found[key];
  return out;
}

function present(snapshot = {}, context = {}) {
  const provider = snapshot.provider || context.provider || null;
  const name = shortName(provider, snapshot.name);
  const stage = snapshot.stage || null;
  const status = snapshot.status || null;
  const code = snapshot.error_code || snapshot.connection_evidence?.last_error?.code || null;
  const errorText = typeof snapshot.error === 'string' ? snapshot.error : '';
  const actionKind = context.action_kind || snapshot.action_kind || null;
  const ready = status === 'ready' && (snapshot.ready_for_office === true || snapshot.local_verified === true);
  const details = { stage, status, error_code: code, error: errorText || null, member_id: snapshot.member_id || snapshot.target_member_id || null };
  const result = (state, headline, primary = null, secondary = null, extra = {}) => ({ state, headline, primary, secondary, busy: false, provider, name, details, ...extra });

  // Protection and repair states come first: they override any readiness.
  if (stage === 'connection_repair_required' || CODEX_REPAIR_CODES.has(code) || actionKind === 'connection_repair')
    return result('attention', `${name} 后台连接已暂停，避免影响你的登录`, button('show_connection_repair', '查看处理办法'));
  if (stage === 'connection_recheck_available' || actionKind === 'connection_recheck')
    return result('waiting', `${name} 可以用已有登录重新连接`, pick(snapshot, 'retry', '重新验证连接'));

  if (ready) {
    const canWake = snapshot.can_wake === true;
    if (canWake) return result('auto', `${name} 已连接，有消息会自动处理`);
    const secondary = WAKE_CAPABLE.has(provider) ? button('enable_wake', '开启自动唤醒') : null;
    return result('connected', `${name} 已连接，有人找它时去 ${name} 里看一下`, null, secondary);
  }

  if (status === 'running' || BUSY_STAGES.has(stage) || actionKind === 'wait')
    return result('waiting', `正在连接 ${name}…`, null, null, { busy: true });

  if (stage === 'awaiting_credential' || actionKind === 'reauthorize' || /revoked|reauthoriz/i.test(code || ''))
    return result('attention', `${name} 的连接已被撤销`, pick(snapshot, 'reauthorize', '重新授权'));
  if (stage === 'fixed_proxy_scope')
    return result('attention', `这个 ${name} 已在另一个房间使用`, pick(snapshot, 'open_fixed_room', '去原房间'), button('new_member', '新建一个成员'));
  if (stage === 'awaiting_auth')
    return result('attention', `${name} 需要登录`, provider === 'codex' ? pick(snapshot, 'retry', '我已登录，重新检查') : offered(snapshot, 'login_client') ? pick(snapshot, 'login_client', `登录 ${name}`) : pick(snapshot, 'retry', '登录后重新检查'));
  if (stage === 'awaiting_quota')
    return result('attention', `${name} 的额度用完了`, pick(snapshot, 'retry', '处理后重新检查'));
  if (stage === 'awaiting_runtime_install')
    return result('attention', `需要先安装 ${name}`, pick(snapshot, 'install_runtime', `安装 ${name}`));
  if (stage === 'awaiting_provider_action')
    return result('attention', `${name} 需要你处理一下设置`, pick(snapshot, 'retry', '处理后重新检查'));
  if (stage === 'awaiting_previous_result' || code === 'desktop_request_uncertain')
    return result('attention', `${name} 上一条请求的结果还没确认`, pick(snapshot, 'retry', '确认后继续'));
  if (code === 'desktop_client_restart_required')
    return result('attention', `${name} 正在运行，需要重启后才能连接`, pick(snapshot, 'open_native_client', `重启 ${name} 并连接`), offered(snapshot, 'manual_mcp') ? pick(snapshot, 'manual_mcp', '改用 MCP 连接') : null);
  if (INCOMPATIBLE.test(code || '') || INCOMPATIBLE.test(errorText))
    return result('attention', `这个版本的 ${name} 暂不支持自动连接`, offered(snapshot, 'manual_mcp') ? pick(snapshot, 'manual_mcp', '改用 MCP 连接') : pick(snapshot, 'retry', '重新检查'));
  if (stage === 'requires_explicit_backend_selection')
    return result('attention', `请选择用哪个 ${name} 接入`, pick(snapshot, 'select_provider', '选择接入方式'));
  if (FAILED.has(status) || FAILED.has(stage) || stage === 'verification_failed')
    return result('attention', `${name} 没有连上`, pick(snapshot, 'retry', '重试'));

  // Steps that wait for the person.
  if (offered(snapshot, 'native_desktop_connect') || stage === 'awaiting_native_desktop' || actionKind === 'native_connect')
    return result('waiting', `${name} 还没连上`, button('native_connect', `连接 ${name}`), offered(snapshot, 'manual_mcp') ? pick(snapshot, 'manual_mcp', '改用 MCP 连接') : null);
  if (['import_client_config', 'import_mcp', 'desktop_import', 'configure_connector', 'import_connector'].some(op => offered(snapshot, op)) || stage === 'awaiting_import')
    return result('waiting', `在 ${name} 里加上 AO 配置`, button('copy_config', '复制配置'), button('copy_handshake_prompt', '复制那句话'));
  if (offered(snapshot, 'copy_handshake_prompt') || ['awaiting_handshake', 'awaiting_bridge_handshake', 'awaiting_reload'].includes(stage) || actionKind === 'manual_handoff')
    return result('waiting', `在 ${name} 里说一句话完成连接`, button('copy_handshake_prompt', '复制那句话'));
  if (stage === 'verification_pending')
    return result('waiting', `${name} 已接上，等待确认回复`, pick(snapshot, 'retry', '重新检查'));
  if (stage === 'awaiting_connection')
    return result('waiting', `${name} 还没连上`, pick(snapshot, 'retry', `连接 ${name}`));

  if (stage === 'unsupported' || actionKind === 'unsupported')
    return result('not_connected', `${name} 暂时不能接入`, offered(snapshot, 'retry') ? pick(snapshot, 'retry', '重新检查') : button('choose_connected_member', '看看可以接入的成员'));
  if (!status || status === 'not_started' || stage === 'not_started')
    return result('not_connected', `${name} 还没接入`, button('start', MANAGED.has(provider) ? `接入 ${name}` : `连接 ${name}`));

  // Anything else still gets one concrete way forward.
  const first = operationsOf(snapshot)[0];
  if (first) return result('waiting', `${name} 还差一步`, button(first.operation, typeof first.label === 'string' && first.label.length <= 12 ? first.label : '继续', first.target_member_id ? { target_member_id: first.target_member_id } : {}));
  return result('attention', `${name} 的连接状态需要检查`, button('retry', '重新检查'));
}

module.exports = { STATES, SHORT_NAMES, WAKE_CAPABLE, present, shortName };
