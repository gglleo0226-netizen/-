import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
let count = 0;
async function setup(t) {
  const app = await createApp({ rateLimit: false, pollWaitMs: 250 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function request(path, data, token, headers = {}) {
    const res = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, data: await res.json(), headers: res.headers };
  }
  async function act(user, action, more = {}) {
    const state = (await request('/api/state', undefined, user.token)).data;
    return request('/api/action', { action, requestId: `http_req_${++count}`, handId: state.handId, phase: state.phase, turnSeq:state.poker?.turnSeq, ...more }, user.token);
  }
  return { ...app, origin, request, act };
}
test('HTTP serving and headers: no source exposure and no caching', async t => {
  const f = await setup(t);
  const home = await fetch(f.origin + '/');
  assert.equal(home.status, 200); assert.ok((await home.text()).includes('친구들의 카드룸'));
  assert.ok(home.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(f.origin + '/lib/game.mjs')).status, 404);
  assert.equal((await f.request('/healthz')).data.ok, true);
});
test('authentication, content type and cross-origin checks', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/rooms', { name: 'A' }, undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(f.origin + '/api/rooms', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(f.origin + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});
test('two HTTP clients join, approve, privately deal, finish, and reconnect', async t => {
  const f = await setup(t);
  const host = (await f.request('/api/rooms', { name: '주인', maxPlayers: 2 })).data;
  const guest = (await f.request('/api/join', { room: host.state.roomId, invite: host.state.invite, name: '손님' })).data;
  assert.equal(guest.state.me.status, 'pending');
  assert.equal((await f.act(guest, 'start')).status, 403);
  await f.act(host, 'approve', { playerId: guest.state.me.id });
  await f.act(host, 'ready', { ready: true }); await f.act(guest, 'ready', { ready: true });
  assert.equal((await f.act(host, 'start')).status, 200);
  const a = (await f.request('/api/state', undefined, host.token)).data;
  const b = (await f.request('/api/state', undefined, guest.token)).data;
  assert.deepEqual(a.players.find(p => p.id === guest.state.me.id).cards, [null, null]);
  assert.ok(b.players.find(p => p.id === guest.state.me.id).cards.every(Number.isInteger));
  assert.deepEqual(a.board, []); assert.deepEqual(b.board, []);
  for (let i = 0; i < 4; i++) { await f.act(host, 'ack'); await f.act(guest, 'ack'); }
  const end = (await f.request('/api/state', undefined, guest.token)).data;
  assert.equal(end.phase, 'showdown'); assert.equal(end.results.length, 2);
  assert.deepEqual(new Set(end.results.map(r => r.name)), new Set(['주인', '손님']));
  assert.equal(end.players.find(p => p.id === guest.state.me.id).stats.played, 1);
  const reconnect = await f.request('/api/state', undefined, guest.token);
  assert.equal(reconnect.data.me.id, guest.state.me.id);
});
test('long polling releases immediately on a state change and times out safely', async t => {
  const f = await setup(t); const host = (await f.request('/api/rooms', { name: '방장' })).data;
  const pending = f.request(`/api/state?since=${host.state.revision}&wait=1`, undefined, host.token);
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.request('/api/join', { room: host.state.roomId, invite: host.state.invite, name: '친구' });
  const changed = await pending; assert.equal(changed.status, 200); assert.equal(changed.data.pending.length, 1);
  const timeout = await f.request(`/api/state?since=${changed.data.revision}&wait=1`, undefined, host.token);
  assert.equal(timeout.status, 200); assert.equal(timeout.data.roomId, host.state.roomId);
});
test('duplicate browser tabs can each wait without creating a busy loop', async t => {
  const f = await setup(t); const host = (await f.request('/api/rooms', { name: '방장' })).data;
  const queries = Array.from({ length: 3 }, () => f.request(`/api/state?since=${host.state.revision}&wait=1`, undefined, host.token));
  const results = await Promise.all(queries); assert.ok(results.every(r => r.status === 200));
});
test('nine clients synchronize through every phase', async t => {
  const f = await setup(t); const host = (await f.request('/api/rooms', { name: 'H', maxPlayers: 9 })).data;
  const guests = await Promise.all(Array.from({ length: 8 }, (_, i) => f.request('/api/join', { room: host.state.roomId, invite: host.state.invite, name: `P${i}` }).then(r => r.data)));
  for (const g of guests) await f.act(host, 'approve', { playerId: g.state.me.id });
  const users = [host, ...guests];
  await Promise.all(users.map(u => f.act(u, 'ready', { ready: true })));
  await f.act(host, 'start');
  for (const phase of ['flop', 'turn', 'river', 'showdown']) {
    const results = await Promise.all(users.map(u => f.act(u, 'ack')));
    assert.ok(results.every(r => r.status === 200));
    const states = await Promise.all(users.map(u => f.request('/api/state', undefined, u.token)));
    assert.ok(states.every(r => r.data.phase === phase));
  }
});
test('revoked pending sessions receive no further private state', async t => {
  const f = await setup(t); const host = (await f.request('/api/rooms', { name: 'H' })).data;
  const guest = (await f.request('/api/join', { room: host.state.roomId, invite: host.state.invite, name: 'G' })).data;
  const poll = f.request(`/api/state?since=${guest.state.revision}&wait=1`, undefined, guest.token);
  await f.act(host, 'reject', { playerId: guest.state.me.id });
  assert.equal((await poll).status, 401);
  assert.equal((await f.request('/api/state', undefined, guest.token)).status, 401);
});

test('v2 HTTP: 9 independent sessions bet, fold, settle, and receive private views', async t => {
  const f=await setup(t);
  const host=(await f.request('/api/rooms',{name:'H',gameType:'holdem',maxPlayers:9})).data;
  const users=[host];
  for(let i=1;i<9;i++) {const u=(await f.request('/api/join',{room:host.state.roomId,invite:host.state.invite,name:`P${i}`})).data;users.push(u);assert.equal((await f.act(host,'approve',{playerId:u.state.me.id})).status,200);}
  await Promise.all(users.map(u=>f.act(u,'ready',{ready:true})));
  assert.equal((await f.act(host,'start')).status,200);
  let s=(await f.request('/api/state',undefined,host.token)).data;
  const foldId=s.poker.actorId;
  const folded=users.find(u=>u.state.me.id===foldId);
  assert.equal((await f.act(folded,'fold')).status,200);
  for(let i=0;i<100;i++) {
    s=(await f.request('/api/state',undefined,host.token)).data;
    if(s.phase==='showdown') break;
    const actor=users.find(u=>u.state.me.id===s.poker.actorId);
    const v=(await f.request('/api/state',undefined,actor.token)).data;
    assert.equal((await f.act(actor,v.poker.legal.check?'check':'call')).status,200);
  }
  const end=await Promise.all(users.map(u=>f.request('/api/state',undefined,u.token)));
  assert.ok(end.every(r=>r.data.phase==='showdown'));
  for(const r of end) {
    assert.equal(r.data.players.reduce((a,p)=>a+p.stack,0),18000);
    assert.deepEqual(r.data.results.find(p=>p.id===foldId).cards,[]);
    if(r.data.me.id!==foldId)assert.deepEqual(r.data.players.find(p=>p.id===foldId).cards,[null,null]);
  }
});
test('v2 HTTP: invalid bets return useful 400 without mutation, stale turn returns 409', async t=>{
  const f=await setup(t),h=(await f.request('/api/rooms',{name:'H',gameType:'holdem',maxPlayers:2})).data;
  const u=(await f.request('/api/join',{room:h.state.roomId,invite:h.state.invite,name:'U'})).data;
  await f.act(h,'approve',{playerId:u.state.me.id});await f.act(h,'ready',{ready:true});await f.act(u,'ready',{ready:true});await f.act(h,'start');
  const s=(await f.request('/api/state',undefined,h.token)).data,actor=[h,u].find(u=>u.state.me.id===s.poker.actorId);
  const bad=await f.act(actor,'raise',{amount:21});assert.equal(bad.status,400);assert.match(bad.data.error,/최소/);
  assert.equal((await f.act(actor,'fold',{turnSeq:-1})).status,409);
  assert.equal((await f.request('/api/state',undefined,h.token)).data.poker.pot,30);
});
