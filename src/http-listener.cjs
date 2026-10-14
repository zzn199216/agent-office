'use strict';
const fs = require('node:fs'), path = require('node:path');
const { RoomError } = require('./util.cjs');

function savedPort(service) {
  const stored = service.store.setting('local_http_port');
  if (Number.isInteger(stored) && stored > 0 && stored <= 65535) return stored;
  // Older releases already wrote the actual address to control.json. Adopt it
  // only for this instance, even when its previous process has exited.
  try {
    const control = JSON.parse(fs.readFileSync(path.join(service.store.dir, 'control.json'), 'utf8'));
    const url = new URL(control.url), port = Number(url.port);
    if (control.instance_id === service.runtime.instanceId && url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && port > 0 && port <= 65535) return port;
  } catch {}
  return null;
}

async function listenLocal(service, input, options = {}) {
  const create = options.createServer || require('./http.cjs').createServer;
  const previous = input.port === undefined ? savedPort(service) : null;
  const ports = input.port !== undefined ? [Number(input.port)] : previous ? [previous] : [...Array.from({ length: 9 }, (_, i) => 47831 + i), 0];
  for (const requested of ports) {
    const server = create(service, { ...input, port: requested });
    try {
      const port = await server.listen();
      service.store.setting('local_http_port', port);
      return { server, port };
    } catch (error) {
      await server.close();
      if (error.code !== 'EADDRINUSE') throw error;
      if (previous) throw new RoomError(`本机连接地址 127.0.0.1:${previous} 被其他程序占用。请释放该端口后重试；已有 MCP 配置保持原地址。`, 409, 'mcp_port_in_use');
      if (input.port !== undefined) throw error;
    }
  }
  throw new RoomError('本机服务地址不可用，请稍后重试。', 503, 'local_listener_unavailable');
}
module.exports = { savedPort, listenLocal };
