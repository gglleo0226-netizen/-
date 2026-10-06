import test from 'node:test';
import assert from 'node:assert/strict';
import { GameStore } from '../lib/game.mjs';
let sequence = 0;
function fixture(n = 2, options = {}) {
  let clock = 100000;
  const game = new GameStore({ now: () => clock, ...options.store });
  const host = game.create({ name: '방장', maxPlayers: n, ...options });
  const users = [host];
  function state(user = host) { const a = game.auth(user.token); return game.view(a.room, a.player); }
  function act(user, action, extra = {}) {
    const s = state(user);
    return game.action(user.token, { action, requestId: `request_${++sequence}`, handId: s.handId, phase: s.phase, ...extra });
  }
  for (let i = 1; i < n; i++) {
    const guest = game.join({ room: host.state.roomId, invite: host.state.invite, name: `친구${i}` });
    users.push(guest); act(host, 'approve', { playerId: guest.state.me.id });
  }
  function start() { users.forEach(user => act(user, 'ready', { ready: true })); act(host, 'start'); }
  return { game, host, users, act, state, start,
    room: game.rooms.get(host.state.roomId),
    setTime(value) { clock = value; }, step(ms) { clock += ms; },
    refresh() { for (const user of users) { try { const a = game.auth(user.token); game.markSeen(a.room, a.player); } catch {} } }
  };
}

test('validates player count, names and room creator password', () => {
  const g = new GameStore({ createPassword: 'secret' });
  assert.throws(() => g.create({ name: 'A' }), /비밀번호/);
  for (const maxPlayers of [1, 10, 2.5, '3']) assert.throws(() => g.create({ name: 'A', password: 'secret', maxPlayers }));
  assert.throws(() => g.create({ name: '', password: 'secret' }));
  assert.equal(g.create({ name: 'A', password: 'secret' }).state.me.name, 'A');
});
test('pending join has no roster, cards, board, history or invite', () => {
  const f = fixture(2); f.start();
  f.room.maxPlayers = 3;
  const pending = f.game.join({ room: f.room.id, invite: f.room.invite, name: '대기자' });
  for (const field of ['players', 'board', 'history', 'invite', 'handId', 'results']) assert.equal(pending.state[field], undefined);
  assert.throws(() => f.act(pending, 'start'), /승인/);
});
test('wrong invite and reused nicknames rejected', () => {
  const g = new GameStore(); const h = g.create({ name: 'A', maxPlayers: 3 });
  assert.throws(() => g.join({ room: h.state.roomId, invite: 'wrong', name: 'B' }));
  assert.throws(() => g.join({ room: h.state.roomId, invite: h.state.invite, name: 'a' }), /닉네임/);
});
test('unapproved and nonhost users cannot administer the room', () => {
  const f = fixture();
  for (const action of ['start', 'lock', 'pause', 'close', 'rotateInvite']) assert.throws(() => f.act(f.users[1], action), /방장/);
});
test('room capacity enforced on joining and approval', () => {
  const f = fixture(2);
  assert.throws(() => f.game.join({ room: f.room.id, invite: f.room.invite, name: 'C' }), /정원/);
});
test('all 2–9-player starts deal distinct cards and keep the board secret', () => {
  for (let n = 2; n <= 9; n++) {
    const f = fixture(n); f.start();
    const all = [...f.room.hand.participants.flatMap(p => p.cards), ...f.room.hand.board];
    assert.equal(new Set(all).size, 2 * n + 5);
    for (const user of f.users) {
      const s = f.state(user); assert.equal(s.board.length, 0);
      assert.equal(s.players.find(p => p.id === s.me.id).cards.length, 2);
      for (const other of s.players.filter(p => p.id !== s.me.id)) assert.deepEqual(other.cards, [null, null]);
      if (user !== f.host) assert.equal(s.invite, undefined);
    }
  }
});
test('readiness is required and one acknowledgement per round phase', () => {
  const f = fixture(); assert.throws(() => f.act(f.host, 'start'), /준비/); f.start();
  const old = { phase: f.state().phase, handId: f.state().handId };
  f.users.forEach(u => f.act(u, 'ack')); assert.equal(f.state().phase, 'flop');
  assert.throws(() => f.act(f.users[0], 'ack', old), /갱신/);
  assert.equal(f.room.hand.acknowledged.size, 0);
});
test('duplicate request id is idempotent even after phase advances', () => {
  const f = fixture(); f.start();
  const input = { requestId: 'duplicate_123', phase: 'private', handId: f.state().handId };
  f.act(f.host, 'ack', input); f.act(f.users[1], 'ack');
  f.act(f.host, 'ack', input);
  assert.equal(f.state().phase, 'flop'); assert.equal(f.room.hand.acknowledged.size, 0);
});
test('board reveals 0, 3, 4, 5 cards and then exposes all hands', () => {
  const f = fixture(3); f.start();
  for (const count of [3, 4, 5, 5]) {
    f.users.forEach(u => f.act(u, 'ack'));
    assert.equal(f.state().board.length, count);
  }
  assert.equal(f.state().phase, 'showdown');
  assert.ok(f.state().players.every(p => p.cards.every(Number.isInteger)));
  assert.equal(f.state().history.length, 1);
  assert.equal(f.state().results[0].name.includes('플러시'), false);
  assert.equal(f.state().players[0].stats.played, 1);
});
test('board-only tie gives joint wins, not suit-ranked winners', () => {
  const f = fixture(); f.start();
  f.room.hand.board = [8, 9, 10, 11, 12];
  f.room.hand.participants[0].cards = [13, 14];
  f.room.hand.participants[1].cards = [26, 27];
  for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
  const s = f.state();
  assert.equal(s.results.filter(r => r.winner).length, 2);
  assert.equal(s.results[0].handName, '로열 스트레이트 플러시');
  assert.deepEqual(s.players.map(p => p.stats.ties), [1, 1]);
  assert.deepEqual(new Set(s.results.map(r => r.name)), new Set(['방장', '친구1']));
});
test('next round rotates dealer for heads-up and larger tables', () => {
  for (const n of [2, 9]) {
    const f = fixture(n); f.start(); const before = f.room.dealerSeat;
    for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
    f.users.forEach(u => f.act(u, 'ready', { ready: true })); f.act(f.host, 'start');
    assert.equal(f.room.dealerSeat, (before + 1) % n); assert.equal(f.room.round, 2);
  }
});
test('timed mode progresses and pause preserves remaining time', () => {
  const f = fixture(2, { mode: 'timed', seconds: 10 }); f.start();
  f.step(3000); f.act(f.host, 'pause', { paused: true });
  f.step(20000); f.refresh(); f.game.tick(); assert.equal(f.state().phase, 'private');
  f.act(f.host, 'pause', { paused: false }); f.step(6999); f.game.tick(); assert.equal(f.state().phase, 'private');
  f.step(1); f.game.tick(); assert.equal(f.state().phase, 'flop');
});
test('disconnected participant does not permanently block a reveal', () => {
  const f = fixture(2); f.start(); f.act(f.host, 'ack');
  f.step(36000); const host = f.game.auth(f.host.token); f.game.markSeen(host.room, host.player); f.game.tick();
  assert.equal(f.state().phase, 'flop'); assert.equal(f.state().players[1].online, false);
});
test('no unattended advancing when everyone is offline', () => {
  const f = fixture(2, { mode: 'timed', seconds: 5 }); f.start();
  f.step(36000); f.game.tick(); assert.equal(f.state().phase, 'private');
});
test('takeover requires ninety seconds without the host', () => {
  const f = fixture();
  assert.throws(() => f.act(f.users[1], 'claimHost'), /90초/);
  f.step(91000); f.game.tick(); f.act(f.users[1], 'claimHost');
  assert.equal(f.state(f.users[1]).hostId, f.users[1].state.me.id);
});
test('late-approved player observes current hand and has no private cards', () => {
  const f = fixture(2); f.start(); f.room.maxPlayers = 3;
  const guest = f.game.join({ room: f.room.id, invite: f.room.invite, name: '늦게 온 친구' });
  f.act(f.host, 'approve', { playerId: guest.state.me.id });
  const s = f.state(guest); assert.deepEqual(s.players.find(p => p.id === s.me.id).cards, []);
  assert.throws(() => f.act(guest, 'ack'), /다음 라운드/);
});
test('auto-next ready mode waits for everyone and starts a new hand', () => {
  const f = fixture(2, { autoNext: true }); f.start();
  for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
  f.act(f.host, 'ready', { ready: true }); assert.equal(f.state().phase, 'showdown');
  f.act(f.users[1], 'ready', { ready: true }); assert.equal(f.state().phase, 'private'); assert.equal(f.state().round, 2);
});
test('auto-next timed mode starts after twelve seconds', () => {
  const f = fixture(2, { autoNext: true, mode: 'timed' }); f.start();
  for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
  f.step(12000); f.refresh(); f.game.tick(); assert.equal(f.state().round, 2);
});
test('locked rooms reject joins and invite rotation invalidates the old link', () => {
  const f = fixture(2); f.room.maxPlayers = 3; const old = f.room.invite;
  f.act(f.host, 'lock', { locked: true });
  assert.throws(() => f.game.join({ room: f.room.id, invite: old, name: 'C' }), /잠겨/);
  f.act(f.host, 'lock', { locked: false }); f.act(f.host, 'rotateInvite');
  assert.throws(() => f.game.join({ room: f.room.id, invite: old, name: 'C' }), /초대/);
  assert.ok(f.game.join({ room: f.room.id, invite: f.room.invite, name: 'C' }));
});
test('host leaves mid-round: next member inherits management', () => {
  const f = fixture(); f.start(); f.act(f.host, 'leave');
  assert.throws(() => f.game.auth(f.host.token), /방이/);
  assert.equal(f.state(f.users[1]).hostId, f.users[1].state.me.id);
  assert.equal(f.state(f.users[1]).players.find(p => p.id === f.host.state.me.id).left, true);
});
test('sit-out affects next round, not current hand', () => {
  const f = fixture(3); f.start(); f.act(f.users[2], 'sitOut', { sitOut: true });
  assert.equal(f.room.hand.participants.length, 3);
  for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
  f.act(f.host, 'ready', { ready: true }); f.act(f.users[1], 'ready', { ready: true }); f.act(f.host, 'start');
  assert.equal(f.room.hand.participants.length, 2);
});
test('response arrays cannot mutate live game state', () => {
  const f = fixture(); f.start(); const s = f.state();
  s.players[0].cards[0] = 99; assert.notEqual(f.room.hand.participants[0].cards[0], 99);
});
test('closing room revokes all sessions including pending members', () => {
  const f = fixture(); f.room.maxPlayers = 3;
  const pending = f.game.join({ room: f.room.id, invite: f.room.invite, name: 'C' });
  f.act(f.host, 'close');
  for (const u of [...f.users, pending]) assert.throws(() => f.game.auth(u.token));
  assert.equal(f.game.rooms.size, 0);
});
test('empty and six-hour inactive rooms are cleaned up', () => {
  const f = fixture(); f.step(6 * 60 * 60 * 1000 + 1); f.game.tick();
  assert.equal(f.game.rooms.size, 0); assert.equal(f.game.sessions.size, 0);
});
test('auto-next ready mode also reacts when an unready participant disconnects', () => {
  const f = fixture(3, { autoNext: true }); f.start();
  for (let i = 0; i < 4; i++) f.act(f.host, 'advance');
  f.act(f.host, 'ready', { ready: true }); f.act(f.users[1], 'ready', { ready: true });
  f.step(36000);
  for (const user of [f.host, f.users[1]]) { const a = f.game.auth(user.token); f.game.markSeen(a.room, a.player); }
  f.game.tick(); assert.equal(f.state().round, 2); assert.equal(f.room.hand.participants.length, 2);
});
test('rejected pending requests do not accumulate membership records', () => {
  const f = fixture(2); f.room.maxPlayers = 3;
  for (let i = 0; i < 30; i++) {
    const g = f.game.join({ room: f.room.id, invite: f.room.invite, name: `요청${i}` });
    f.act(f.host, 'reject', { playerId: g.state.me.id });
  }
  assert.equal(f.room.players.length, 2); assert.equal(f.game.sessions.size, 2);
});
