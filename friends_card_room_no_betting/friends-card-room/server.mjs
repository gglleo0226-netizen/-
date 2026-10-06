import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GameStore, GameError } from './lib/game.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store'
};
function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new GameError('JSON 요청만 허용됩니다.', 415);
  let size = 0, data = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new GameError('요청이 너무 큽니다.', 413);
    data += chunk;
  }
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new GameError('요청 형식이 올바르지 않습니다.'); }
}

export async function createApp({ rateLimit = true, createPassword = process.env.CREATE_ROOM_PASSWORD || '', pollWaitMs = 20_000 } = {}) {
  const assets = new Map();
  for (const [route, [name, type]] of FILES) assets.set(route, { body: await readFile(new URL(name, PUBLIC)), type });
  const waiters = new Map();
  const limits = new Map();
  const store = new GameStore({
    createPassword,
    onChange(room, closed) {
      const waiting = waiters.get(room.id);
      if (!waiting) return;
      for (const item of [...waiting]) {
        try {
          if (closed) throw new GameError('방이 종료되었습니다. 새 초대 링크로 입장해 주세요.', 401);
          const { player } = store.auth(item.token);
          item.finish(200, store.view(room, player));
        } catch (err) { item.finish(err.status || 500, { error: err.message }); }
      }
    }
  });
  function throttle(req, kind) {
    if (!rateLimit) return;
    // A conservative per-connection-IP guard. Membership/room limits remain enforced separately.
    const ip = req.socket.remoteAddress || 'unknown';
    const k = `${ip}:${kind}`;
    const now = Date.now(), max = kind === 'create' ? 12 : 1800;
    const duration = kind === 'create' ? 600_000 : 60_000;
    let entry = limits.get(k);
    if (!entry || now > entry.until) { entry = { count: 0, until: now + duration }; limits.set(k, entry); }
    if (++entry.count > max) throw new GameError('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
  }
  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('다른 사이트에서 보낸 요청은 허용하지 않습니다.', 403);
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.headers.host || !['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch { throw new GameError('접속 출처가 올바르지 않습니다.', 403); }
  }
  function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer /, ''); }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/robots.txt') {
        res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        res.writeHead(200, { ...SECURITY, 'Content-Type': asset.type });
        return res.end(req.method === 'HEAD' ? undefined : asset.body);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: '페이지를 찾을 수 없습니다.' });
      throttle(req, 'general'); checkOrigin(req);
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        throttle(req, 'create'); return send(res, 201, store.create(await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/join') return send(res, 201, store.join(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/action') return send(res, 200, store.action(bearer(req), await readJson(req)));
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const token = bearer(req);
        const { room, player } = store.auth(token);
        store.markSeen(room, player);
        if (url.searchParams.get('wait') !== '1' || Number(url.searchParams.get('since')) !== room.revision) {
          return send(res, 200, store.view(room, player));
        }
        const waiting = waiters.get(room.id) || new Set();
        waiters.set(room.id, waiting);
        // Permit a few duplicate tabs without causing a reconnect ping-pong loop.
        if ([...waiting].filter(item => item.token === token).length >= 4) {
          return send(res, 429, { error: '같은 자리로 너무 많은 탭을 열었습니다. 다른 탭을 닫아 주세요.' });
        }
        let timer;
        const item = {
          token,
          finish(status, data) { clearTimeout(timer); waiting.delete(item); send(res, status, data); }
        };
        waiting.add(item);
        timer = setTimeout(() => {
          try {
            const auth = store.auth(token);
            store.markSeen(auth.room, auth.player);
            item.finish(200, store.view(auth.room, auth.player));
          } catch (err) { item.finish(err.status || 500, { error: err.message }); }
        }, pollWaitMs);
        res.on('close', () => { clearTimeout(timer); waiting.delete(item); if (!waiting.size && waiters.get(room.id) === waiting) waiters.delete(room.id); });
        return;
      }
      return send(res, 404, { error: '지원하지 않는 API 경로입니다.' });
    } catch (err) {
      if (!(err instanceof GameError)) console.error('[request error]', err);
      return send(res, err.status || 500, { error: err instanceof GameError ? err.message : '서버에서 오류가 발생했습니다. 다시 시도해 주세요.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const clock = setInterval(() => {
    store.tick();
    for (const [k, v] of limits) if (Date.now() > v.until) limits.delete(k);
  }, 500);
  clock.unref();
  return {
    server, store,
    async close() {
      clearInterval(clock);
      for (const waiting of waiters.values()) for (const item of [...waiting]) item.finish(503, { error: '서버를 종료합니다.' });
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT가 올바르지 않습니다.');
  app.server.listen(port, '0.0.0.0', () => console.log(`Friends Card Room listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
