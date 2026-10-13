'use strict';
const { RoomError } = require('./util.cjs');

const MEMBER_TOOLS = new Set([
  'agentroom_room_state', 'agentroom_room_ensure', 'agentroom_member_wake', 'agentroom_heartbeat',
  'agentroom_chat_rooms', 'agentroom_chat_history', 'agentroom_chat_post', 'agentroom_chat_wait',
  'agentroom_chat_inbox', 'agentroom_chat_reply', 'agentroom_chat_ack',
  'agentroom_bridge_request', 'agentroom_bridge_result', 'agentroom_bridge_wait', 'agentroom_bridge_report'
]);
const PROXY_TOOLS = new Set(['agentroom_delegate', 'agentroom_delegate_wait']);
const TEAM_MEMBER_TOOLS = ['agentroom_team_state','agentroom_member_card','agentroom_task_update','agentroom_meeting_report','agentroom_brief_ack'];
const TEAM_SECRETARY_TOOLS = ['agentroom_task_create','agentroom_goal_complete','agentroom_meeting_start','agentroom_meeting_discuss','agentroom_meeting_close'];
const TEAM_TOOLS = Object.freeze([...TEAM_MEMBER_TOOLS,...TEAM_SECRETARY_TOOLS]);
const TEAM_INSTRUCTIONS = 'Read agentroom_team_state when joining or resuming. Publish your own role, skills and information with agentroom_member_card; sources are self-reported, not verified facts. Acknowledge the current brief. Accept assigned tasks, report progress or blockers, and submit a result with evidence; submission is not approval. Answer only meetings that name you. Only the current secretary may assign work, hold meetings, approve results or complete goals. Team records do not expand filesystem, network, installation, publishing or payment permissions.';
for(const name of TEAM_MEMBER_TOOLS)MEMBER_TOOLS.add(name);
const SETUP_TOOLS = new Set(['agentroom_group_prepare','agentroom_group_report','agentroom_group_state','agentroom_group_sync','agentroom_sync_report','agentroom_discover_agents','agentroom_connect','agentroom_connect_state','agentroom_connect_retry']);
const UUID = '[a-f0-9-]{36}';
function proxyFor(disk, scope) {
  const exists = disk.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='launch_proxies'").get();
  return exists ? disk.store.db.prepare('SELECT backend_member_id FROM launch_proxies WHERE room_id=? AND proxy_member_id=?').get(scope.room_id, scope.member_id) : null;
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
function assertMemberRoute(disk, scope, route, input, { allowJoin = false } = {}) {
  const room = scope.room_id, member = scope.member_id;
  disk.chat.requireParticipant(room, member);
  const url = new URL(route, 'http://127.0.0.1'), p = url.pathname, q = url.searchParams;
  const denied = () => { throw new RoomError('请求超出了当前成员的房间授权；管理操作请使用本机控制界面。', 403, 'resume_scope_mismatch'); };
  if (q.has('room_id') && q.get('room_id') !== room || q.has('member_id') && q.get('member_id') !== member || input?.room_id && input.room_id !== room || input?.sender_id && input.sender_id !== member || input?.caller_member_id && input.caller_member_id !== member) denied();
  const messageRoute = p.match(new RegExp(`^/api/chat/messages/(${UUID})(?:/(wait|reply|ack|cancel))?$`, 'i'));
  const invitationRoute = p.match(new RegExp(`^/api/chat/invitations/(${UUID})$`, 'i'));
  const bridgeRoute = p.match(new RegExp(`^/api/bridge/entries/(${UUID})(?:/(wait|report))?$`, 'i'));
  const proxy = proxyFor(disk, scope);
  let message;
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
      p === '/api/resume/accept' && input.card?.instance_id === scope.instance_id && input.card?.room_id === room && input.card?.member_id === member;
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
module.exports = { MEMBER_TOOLS, PROXY_TOOLS, SETUP_TOOLS, TEAM_TOOLS, TEAM_SECRETARY_TOOLS, TEAM_INSTRUCTIONS, memberTools, proxyFor, assertMemberRoute };
