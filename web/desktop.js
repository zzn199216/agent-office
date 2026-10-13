'use strict';
// The host accepts this protocol only from its trusted local origins.
(() => {
  const bridge = window.chrome?.webview;
  if (!bridge || typeof bridge.postMessage !== 'function' || typeof bridge.addEventListener !== 'function') return;
  if (location.hostname !== 'agentroom.local' && !['127.0.0.1','localhost'].includes(location.hostname)) return;
  const pending = new Map(); let sequence = 0;
  bridge.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.source !== 'agentroom-desktop' || message.type !== 'desktop-result' || typeof message.id !== 'string') return;
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(typeof message.error === 'string' ? message.error : message.error.message || '桌面操作未完成。'));
    else request.resolve(message.result);
  });
  const command = (operation, values = {}) => new Promise((resolve,reject) => {
    if (!['state','start_service','stop_service','select_room'].includes(operation)) return reject(new Error('不支持这个桌面操作。'));
    const id = `desktop-${Date.now()}-${++sequence}`;
    const timeout = setTimeout(() => {pending.delete(id);reject(new Error('桌面操作仍未确认。请检查服务状态，避免重复操作。'));},60000);
    pending.set(id,{resolve,reject,timeout});
    bridge.postMessage({source:'agentroom-ui',type:'desktop-command',id,operation,...typeof values.room_id === 'string' ? {room_id:values.room_id} : {}});
  });
  Object.defineProperty(window,'AgentRoomDesktop',{value:Object.freeze({command,offline:location.hostname === 'agentroom.local'}),writable:false});
  document.body.classList.add('desktop-app');
})();
