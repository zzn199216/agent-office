'use strict';
const { RoomError, VERSION } = require('./util.cjs');
const { COMMON_OPERATION_INSTRUCTIONS } = require('./operation-policy.cjs');
const MEMBER_CONNECTION_INSTRUCTIONS = 'This MCP authenticates one member in one persistent Agent Office instance. Its credential is reused in all rooms the user has seated that member in; the entry card room_id is a default, not a permanent room restriction. After room changes call agentroom_chat_rooms for current seats. Call agentroom_chat_inbox without room_id to read addressed messages across all current seats. Do not ask for another entry card or MCP configuration merely because a room changed. Claim connection, room identity or an empty inbox only from an actual successful tool result, never from conversation memory. ' + COMMON_OPERATION_INSTRUCTIONS;

const MEMBER_TOOLS = new Set([
  'agentroom_room_state', 'agentroom_room_ensure', 'agentroom_member_wake', 'agentroom_heartbeat',
  'agentroom_chat_rooms', 'agentroom_chat_history', 'agentroom_chat_post', 'agentroom_chat_wait',
  'agentroom_chat_inbox', 'agentroom_chat_image', 'agentroom_chat_reply', 'agentroom_chat_ack',
  'agentroom_bridge_request', 'agentroom_bridge_result', 'agentroom_bridge_wait', 'agentroom_bridge_report'
]);
const PROXY_TOOLS = new Set(['agentroom_delegate', 'agentroom_delegate_wait']);
const TEAM_MEMBER_TOOLS = ['agentroom_team_state','agentroom_member_card','agentroom_task_update','agentroom_meeting_report','agentroom_brief_ack'];
const TEAM_SECRETARY_TOOLS = ['agentroom_task_create','agentroom_goal_complete','agentroom_meeting_start','agentroom_meeting_discuss','agentroom_meeting_close'];
const TEAM_TOOLS = Object.freeze([...TEAM_MEMBER_TOOLS,...TEAM_SECRETARY_TOOLS]);
const TEAM_INSTRUCTIONS = 'For an automatic Agent Office connection verification, respond only with the requested confirmation line: do not call tools, read files, publish a member card or start work. This verifies the connection only. For ordinary business work, read agentroom_team_state when joining or resuming. Publish your own role, skills and information with agentroom_member_card; sources are self-reported, not verified facts. Acknowledge the current brief. Accept assigned tasks, report progress or blockers, and submit a result with evidence; submission is not approval. Answer only meetings that name you. Only the current secretary may assign work, hold meetings, approve results or complete goals. For a user request to connect an agent, use AO controller connection-assist progress and the existing guided handoff to help finish the connection. If an automatic route is unavailable, give the concrete next step, the exact target client conversation, and the provided copy sentence or guide; do not stop after saying a tool is unsupported, permission is missing, or a raw error occurred. Keep the original person, configuration and progress. Do not repeat scans, create replacement identities or issue credentials from a business message. Confirm success briefly only from actual connection evidence; explain developer details only when the user requests diagnostics. Team records do not expand filesystem, network, installation, publishing or payment permissions.';
for(const name of TEAM_MEMBER_TOOLS)MEMBER_TOOLS.add(name);
const SETUP_TOOLS = new Set(['agentroom_group_prepare','agentroom_group_report','agentroom_group_state','agentroom_group_sync','agentroom_sync_report','agentroom_discover_agents','agentroom_connect','agentroom_connect_state','agentroom_connect_retry']);
const UUID = '[a-f0-9-]{36}';
function proxyFor(disk, scope) {
  const exists = disk.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='launch_proxies'").get();
  // An identity credential may be rehomed after leaving/deleting its room.
  // That must not erase a proxy's persisted room and backend restrictions.
  return exists ? disk.store.db.prepare('SELECT room_id,backend_member_id FROM launch_proxies WHERE proxy_member_id=? ORDER BY (room_id=?) DESC,created,id LIMIT 1').get(scope.member_id, scope.room_id) || null : null;
}
function memberConnection(disk, scope) {
  const proxy = proxyFor(disk, scope), home = proxy?.room_id || scope.room_id;
  if (proxy && !disk.chat.joined(home, scope.member_id)) throw new RoomError('固定代理已经离开原房间，未切换到其他房间。', 403, 'proxy_not_bound');
  const rooms = disk.chat.rooms().filter(room => disk.chat.joined(room.id, scope.member_id) && (!proxy || room.id === home)).map(room => ({ id: room.id, title: room.title }));
  return { server_version: VERSION, instance_id: scope.instance_id || disk.runtime?.instanceId, member_id: scope.member_id, default_room_id: rooms.some(room=>room.id===home)?home:null, room_scope: proxy ? 'fixed_proxy' : 'joined_rooms', rooms };
}
function memberTools(tools, { env = process.env, proxy = false, allowJoin = true } = {}) {
  const member = env.AGENTROOM_MEMBER_ID, room = env.AGENTROOM_ROOM_ID;
  if (member || room) {
    if (!member || !room) return [];
    // Native MCP clients can cache discovery for the lifetime of a session.
    // Keep team capabilities stable across secretary changes; execution checks
    // the current persisted role on every request at both transport and service.
    return tools.filter(tool => MEMBER_TOOLS.has(tool.name) || TEAM_SECRETARY_TOOLS.includes(tool.name) || proxy && PROXY_TOOLS.has(tool.name) || allowJoin && tool.name === 'agentroom_join');
  }
  return tools.filter(tool => (!MEMBER_TOOLS.has(tool.name)||['agentroom_chat_rooms','agentroom_chat_history'].includes(tool.name)) && !TEAM_TOOLS.includes(tool.name) && !PROXY_TOOLS.has(tool.name) && tool.name !== 'agentroom_join' && (!SETUP_TOOLS.has(tool.name) || env.AGENTROOM_SETUP_MODE === '1'));
}
// A member credential is an identity, not a room ticket. Its card names the
// room it was issued in ("home"), but a request may act in any room the user
// has seated this member in. The request's room is derived from the route
// (query, body, or the message/image/invitation/bridge it addresses); then
// every existing per-room rule below is applied to that room unchanged.
// Fixed group proxies stay pinned to their home room.
function requestRoom(disk, scope, p, q, input) {
  const found = new Set(), add = value => { if (typeof value === 'string' && value) found.add(value); };
  add(q.get('room_id')); add(input?.room_id);
  const roomPath = p.match(new RegExp(`^/api/chat/rooms/(${UUID})$`, 'i')); if (roomPath) add(roomPath[1]);
  const messagePath = p.match(new RegExp(`^/api/chat/messages/(${UUID})`, 'i')); if (messagePath) { try { add(disk.chat.message(messagePath[1]).room_id); } catch {} }
  const imagePath = p.match(new RegExp(`^/api/chat/images/(${UUID})$`, 'i')); if (imagePath) { try { add(disk.chat.images.metadata(imagePath[1]).room_id); } catch {} }
  const invitationPath = p.match(new RegExp(`^/api/chat/invitations/(${UUID})$`, 'i'));
  if (invitationPath || p === '/api/chat/join') { try { add(disk.chat.invite(invitationPath?.[1] || input?.invite_id).room_id); } catch {} }
  const bridgePath = p.match(new RegExp(`^/api/bridge/entries/(${UUID})`, 'i'));
  if (bridgePath) { const row = disk.store.db.prepare('SELECT b.room_id FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id WHERE e.id=?').get(bridgePath[1]); if (row) add(row.room_id); }
  if (found.size > 1) throw new RoomError('一次请求只能作用于一个房间。', 403, 'resume_scope_mismatch');
  return found.size ? [...found][0] : scope.room_id;
}
function assertMemberRoute(disk, home, route, input, { allowJoin = false } = {}) {
  const member = home.member_id, url = new URL(route, 'http://127.0.0.1'), p = url.pathname, q = url.searchParams;
  disk.chat.member(member);
  const denied = () => { throw new RoomError('请求超出了当前成员的房间授权；管理操作请使用本机控制界面。', 403, 'resume_scope_mismatch'); };
  const fixedProxy = proxyFor(disk, home);
  if (fixedProxy && !disk.chat.joined(fixedProxy.room_id, member)) denied();
  // A member's own inbox across all of its rooms needs no room at all.
  if (input === undefined && p === '/api/chat/inbox' && q.get('member_id') === member && !q.has('room_id')) { if (fixedProxy) denied(); return; }
  if (input === undefined && p === `/api/chat/members/${member}/rooms`) return;
  if (p === `/api/chat/members/${member}/heartbeat` && input && Object.keys(input).length===0) return;
  if (p === '/api/resume/accept' && input?.card?.member_id===member && input.card.instance_id===home.instance_id && input.card.credential_id===home.credential_id) return;
  const room = requestRoom(disk, home, p, q, input);
  if (fixedProxy && room !== fixedProxy.room_id) denied();
  const joining = (p === '/api/chat/join' || /^\/api\/chat\/invitations\//.test(p)) && allowJoin;
  if (!joining) { try { disk.chat.requireParticipant(room, member); } catch { denied(); } }
  const scope = { ...home, room_id: room };
  if (q.has('room_id') && q.get('room_id') !== room || q.has('member_id') && q.get('member_id') !== member || input?.room_id && input.room_id !== room || input?.sender_id && input.sender_id !== member || input?.caller_member_id && input.caller_member_id !== member) denied();
  const messageRoute = p.match(new RegExp(`^/api/chat/messages/(${UUID})(?:/(wait|reply|ack|cancel))?$`, 'i'));
  const imageRoute = p.match(new RegExp(`^/api/chat/images/(${UUID})$`, 'i'));
  const invitationRoute = p.match(new RegExp(`^/api/chat/invitations/(${UUID})$`, 'i'));
  const bridgeRoute = p.match(new RegExp(`^/api/bridge/entries/(${UUID})(?:/(wait|report))?$`, 'i'));
  const proxy = fixedProxy || proxyFor(disk, scope);
  let message;
  if(imageRoute){
    const image=disk.chat.images.metadata(imageRoute[1]);
    if(image.room_id!==room)denied();
    const owner=disk.chat.message(image.message_id);
    if(proxy&&owner.sender_id!==member&&owner.to_member_id!==member)denied();
  }
  if (messageRoute) {
    message = disk.chat.message(messageRoute[1]);
    if (message.room_id !== room) denied();
    if (proxy && message.sender_id !== member && message.to_member_id !== member) throw new RoomError('这条消息不属于当前代理。', 403, 'proxy_target_mismatch');
  }
  if (bridgeRoute) {
    const binding = disk.store.db.prepare('SELECT b.room_id,b.member_id FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id WHERE e.id=?').get(bridgeRoute[1]);
    if (!binding || binding.room_id !== room || binding.member_id !== member) denied();
  }
  if (invitationRoute || p === '/api/chat/join') {
    if (!allowJoin) denied();
    const invitation = disk.chat.invite(invitationRoute?.[1] || input?.invite_id);
    if (invitation.room_id !== room || invitation.member_id !== member) denied();
  }
  let permitted = false;
  if (input === undefined) {
    permitted = p === '/api/runtime' && q.get('room_id') === room ||
      p === '/api/launch/proxy' && q.get('room_id') === room && q.get('member_id') === member ||
      p === `/api/chat/rooms/${room}` ||
      p === '/api/chat/inbox' && q.get('room_id') === room && q.get('member_id') === member ||
      !!imageRoute && q.get('room_id') === room && q.get('member_id') === member && q.get('format') === 'base64' ||
      !!messageRoute && (!messageRoute[2] || messageRoute[2] === 'wait') ||
      !!invitationRoute && allowJoin ||
      !!bridgeRoute && (!bridgeRoute[2] || bridgeRoute[2] === 'wait') ||
      p === '/api/team' && q.get('room_id') === room;
  } else {
    const ownIdentity = input.member_id === member;
    permitted = p === `/api/chat/members/${member}/heartbeat` ||
      p === '/api/runtime/wake' && input.room_id === room && input.caller_member_id === member ||
      p === '/api/chat/messages' && input.room_id === room && input.sender_id === member ||
      !!messageRoute && ['reply','ack','cancel'].includes(messageRoute[2]) && (ownIdentity || messageRoute[2] === 'cancel' && input.member_id === undefined) ||
      p === '/api/bridge/request' && input.room_id === room && ownIdentity ||
      !!bridgeRoute && bridgeRoute[2] === 'report' && input.room_id === room && ownIdentity ||
      ['/api/launch/delegate','/api/launch/wait'].includes(p) && !!proxy && input.room_id === room && ownIdentity ||
      p === '/api/chat/join' && allowJoin && ownIdentity ||
      p === '/api/resume/accept' && input.card?.instance_id === scope.instance_id && input.card?.room_id === home.room_id && input.card?.member_id === member;
    if (messageRoute && message.sender_id !== member && message.to_member_id !== member) denied();
    if (p === '/api/runtime/wake') disk.chat.requireParticipant(room, input.member_id);
    if (input.to_member_id || input.target_member_id) {
      const target = input.to_member_id || input.target_member_id;
      disk.chat.requireParticipant(room, target);
      if (proxy && target !== proxy.backend_member_id) throw new RoomError('群内代理只连接其绑定的本机成员。', 403, 'proxy_target_mismatch');
    }
    if(p.startsWith('/api/team/')) {
      const secretary=disk.store.setting('secretary.'+room)?.member_id===member;
      const ownTeamIdentity=input.room_id===room&&input.caller_member_id===member;
      const ownRecord=['/api/team/cards','/api/team/brief/ack'].includes(p)||new RegExp(`^/api/team/meetings/${UUID}/report$`,'i').test(p);
      const taskUpdate=new RegExp(`^/api/team/tasks/${UUID}/update$`,'i').test(p);
      const secretaryAction=['/api/team/tasks','/api/team/meetings'].includes(p)||new RegExp(`^/api/team/(?:goals/${UUID}/complete|meetings/${UUID}/(?:discuss|close))$`,'i').test(p);
      permitted=ownTeamIdentity&&(ownRecord&&input.member_id===member||taskUpdate&&['accept','progress','block','submit',...(secretary?['approve','request_changes','cancel']:[])].includes(input.action)||secretaryAction&&secretary);
    }
  }
  if (!permitted) denied();
}
module.exports = { MEMBER_TOOLS, PROXY_TOOLS, SETUP_TOOLS, TEAM_TOOLS, TEAM_SECRETARY_TOOLS, TEAM_INSTRUCTIONS, MEMBER_CONNECTION_INSTRUCTIONS, memberConnection, memberTools, proxyFor, assertMemberRoute };
