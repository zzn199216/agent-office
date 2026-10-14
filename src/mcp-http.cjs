'use strict';
const crypto = require('node:crypto');
const { tools, toolCall, toolResult } = require('./mcp.cjs');
const { memberTools } = require('./member-policy.cjs');
const { assertEntryScope } = require('./entry.cjs');
const { CARD_SCHEMA, CARD_VERSION } = require('./resume.cjs');
const { VERSION, RoomError, ownCommand, readableError } = require('./util.cjs');

const PROTOCOLS = ['2025-03-26', '2025-06-18'];
const MAX_BODY = 64 * 1024;
const SESSION_LEASE = 30 * 60 * 1000;
const UUID = '[a-f0-9-]{36}';

// This URL is a local member credential. Keep the generated config in a local
// file; never include it in public room state, logs, or an external chat prompt.
function createQwenMcpConfig(baseUrl, card) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new RoomError('Qwen MCP 必须连接本机 AgentRoom 地址。', 400, 'invalid_mcp_address');
  if (card?.schema !== CARD_SCHEMA || card.version !== CARD_VERSION || !new RegExp(`^${UUID}$`, 'i').test(card.credential_id || '') || !/^[A-Za-z0-9_-]{43}$/.test(card.secret || '')) throw new RoomError('本机 MCP 入口凭据无效。', 400, 'invalid_resume_card');
  return { mcpServers: { agentroom: { type: 'streamable-http', url: `${base.origin}/mcp/${card.credential_id}/${card.secret}` } } };
}

function json(res, value, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function rpcError(res, id, code, message, status = 400) { json(res, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status); }
async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RoomError('MCP 请求过大。', 413, 'mcp_body_too_large');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RoomError('MCP 请求过大。', 413, 'mcp_body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RoomError('MCP JSON 格式无效。', 400, 'mcp_parse_error'); }
}

function createMcpHttp(service, options = {}) {
  const sessions = new Map();
  const call = options.api || ((route, input) => require('./main.cjs').apiCall(service.store.dir, route, input));
  const disk = { store: service.store, chat: service.chat.store };
  function cardFor(credentialId, secret) {
    const row = service.resume.credential(credentialId), own = ownCommand();
    const card = { schema: CARD_SCHEMA, version: CARD_VERSION, credential_id: row.id, instance_id: row.instance_id, room_id: row.room_id, member_id: row.member_id, data_directory: service.resume.dataDirectory, launch_command: own.command, launch_args: own.args, secret };
    service.resume.inspect(card);
    return card;
  }
  function isProxy(card) { return !!service.launch.lookup(card.member_id, card.room_id); }
  function contextFor(card) { return { env: { AGENTROOM_MEMBER_ID: card.member_id, AGENTROOM_ROOM_ID: card.room_id, AGENTROOM_SETUP_MODE: '0', AGENTROOM_CALLER: service.chat.store.member(card.member_id).name }, proxy: isProxy(card), allowJoin: false, secretary: service.secretary.get(card.room_id).member_id === card.member_id }; }
  function allowedTools(card) { return memberTools(tools, contextFor(card)); }
  function assertRoute(card, route, input) {
    service.resume.inspect(card);
    assertEntryScope(disk, card, route, input);
  }
  function boundApi(card) {
    return async (route, input) => {
      assertRoute(card, route, input);
      // Initialization and tool discovery are not a native identity handshake.
      // An authenticated, permitted tool invocation establishes communication.
      // A seat lookup is an authorization read, not evidence of communication.
      if (!/^\/api\/chat\/members\/[a-f0-9-]{36}\/rooms$/i.test(route)) service.entry.accept(card);
      return call(route, input, card);
    };
  }
  function sessionFor(req, card) {
    const key = req.headers['mcp-session-id'], session = typeof key === 'string' ? sessions.get(key) : null;
    if (!session || session.expires <= Date.now()) {
      if (typeof key === 'string') sessions.delete(key);
      throw new RoomError('MCP 会话不存在或已结束，请重新初始化。', key ? 404 : 400, 'mcp_session_missing');
    }
    if (session.credentialId !== card.credential_id || session.memberId !== card.member_id || session.roomId !== card.room_id || session.instanceId !== card.instance_id) throw new RoomError('MCP 会话与成员入口不匹配。', 403, 'mcp_session_mismatch');
    const protocol = req.headers['mcp-protocol-version'];
    if (protocol && protocol !== session.protocol) throw new RoomError('MCP 协议版本与会话不匹配。', 400, 'mcp_protocol_mismatch');
    session.expires = Date.now() + SESSION_LEASE;
    return session;
  }
  async function handle(req, res, givenUrl) {
    const url = givenUrl instanceof URL ? givenUrl : new URL(givenUrl || req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) return false;
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const match = url.pathname.match(new RegExp(`^/mcp/(${UUID})/([A-Za-z0-9_-]{43})$`, 'i'));
    let card;
    try {
      if (!match || url.search || url.hash) throw new RoomError('MCP 入口无效。', 401, 'invalid_mcp_entry');
      const local = new URL(`http://${req.headers.host}`);
      if (!['127.0.0.1', 'localhost'].includes(local.hostname) || req.headers.origin && req.headers.origin !== local.origin) throw new RoomError('不接受跨站 MCP 请求。', 403, 'invalid_mcp_origin');
      card = cardFor(match[1], match[2]);
    } catch (error) {
      const status = error.status === 410 ? 410 : error.status === 403 ? 403 : 401;
      rpcError(res, null, -32001, status === 410 ? 'MCP 入口已撤销。' : 'MCP 入口认证失败。', status); return true;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); rpcError(res, null, -32600, '此 MCP 入口只提供 POST JSON，不提供服务器事件流。', 405); return true; }
    const protocol = req.headers['mcp-protocol-version'];
    if (protocol && !PROTOCOLS.includes(protocol)) { rpcError(res, null, -32600, '不支持这个 MCP 协议版本。'); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { rpcError(res, null, -32600, 'MCP 请求需要 application/json。', 415); return true; }
    let request;
    try { request = await readBody(req); }
    catch (error) { rpcError(res, null, error.code === 'mcp_parse_error' ? -32700 : -32600, readableError(error), error.status || 400); return true; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.id !== undefined && request.id !== null && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id))) { rpcError(res, null, -32600, '无效 MCP 请求；不支持批量请求。'); return true; }
    try {
      if (request.method === 'initialize') {
        if (request.id === undefined || req.headers['mcp-session-id']) throw new RoomError('MCP 初始化需要请求标识且不能复用会话头。');
        for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
        if (sessions.size >= 512) throw new RoomError('MCP 会话数量已达上限，请稍后再试。', 503, 'mcp_sessions_full');
        const selected = PROTOCOLS.includes(request.params?.protocolVersion) ? request.params.protocolVersion : PROTOCOLS.at(-1);
        const key = crypto.randomBytes(24).toString('base64url');
        sessions.set(key, { credentialId: card.credential_id, instanceId: card.instance_id, memberId: card.member_id, roomId: card.room_id, protocol: selected, initialized: false, expires: Date.now() + SESSION_LEASE });
        json(res, { jsonrpc: '2.0', id: request.id, result: { protocolVersion: selected, capabilities: { tools: {} }, serverInfo: { name: 'agentroom-local', version: VERSION } } }, 200, { 'Mcp-Session-Id': key });
        return true;
      }
      const session = sessionFor(req, card);
      if (request.id === undefined) {
        if (request.method === 'notifications/initialized') session.initialized = true;
        res.writeHead(202, { 'Cache-Control': 'no-store' }); res.end(); return true;
      }
      let result;
      if (request.method === 'ping') result = {};
      else if (!session.initialized) throw new RoomError('请先完成 MCP initialized 通知。');
      else if (request.method === 'tools/list') result = { tools: allowedTools(card) };
      else if (request.method === 'tools/call') {
        try {
          const name = request.params?.name, args = request.params?.arguments ?? {};
          if (!allowedTools(card).some(tool => tool.name === name)) throw new RoomError('这个成员入口不提供该工具。', 403, 'mcp_tool_forbidden');
          // A room other than the card's home room is allowed when the user has seated
          // this member there; the route policy checks that seat on every call.
          const value = await toolCall(name, args, boundApi(card), contextFor(card));
          result = await toolResult(name,value,boundApi(card),contextFor(card));
        } catch (error) {
          const message = readableError(error).replaceAll(card.secret, '[credential]');
          result = { isError: true, content: [{ type: 'text', text: message }] };
        }
      } else { rpcError(res, request.id, -32601, 'Method not found', 200); return true; }
      json(res, { jsonrpc: '2.0', id: request.id, result });
    } catch (error) { rpcError(res, request.id, -32600, readableError(error).replaceAll(card.secret, '[credential]'), error.status || 400); }
    return true;
  }
  return { handle, close: () => sessions.clear() };
}
module.exports = { createMcpHttp, createQwenMcpConfig };
