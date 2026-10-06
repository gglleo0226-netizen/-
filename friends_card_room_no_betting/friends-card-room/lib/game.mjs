import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { shuffledDeck, evaluate, compareScores } from './cards.mjs';

const PHASES = ['private', 'flop', 'turn', 'river', 'showdown'];
const LABELS = { private: '개인 카드', flop: '플롭', turn: '턴', river: '리버', showdown: '결과' };
export const ONLINE_MS = 35_000;
export const TAKEOVER_MS = 90_000;
export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (ok, message, status) => { if (!ok) throw new GameError(message, status); };
const key = () => randomBytes(24).toString('base64url');
const digest = text => createHash('sha256').update(String(text)).digest('hex');
const sameSecret = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
function text(value, max, label) {
  fail(typeof value === 'string', `${label}을(를) 입력해 주세요.`);
  const result = value.normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, '');
  fail(result.length > 0 && [...result].length <= max, `${label}은(는) 1~${max}자로 입력해 주세요.`);
  return result;
}
function integer(value, min, max, label) {
  fail(Number.isInteger(value) && value >= min && value <= max, `${label}: ${min}~${max} 범위의 정수가 필요합니다.`);
  return value;
}

/** In-memory, authoritative single-process game. Never return room objects to clients. */
export class GameStore {
  constructor({ now = Date.now, onChange = () => {}, createPassword = '', maxRooms = 50 } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.createPassword = createPassword;
    this.maxRooms = maxRooms;
    this.rooms = new Map();
    this.sessions = new Map();
  }
  notify(room) {
    room.revision++;
    room.updatedAt = this.now();
    this.onChange(room);
  }
  log(room, message) {
    room.log.unshift({ id: key().slice(0, 10), at: this.now(), message });
    room.log.length = Math.min(room.log.length, 45);
  }
  newPlayer(room, name, status = 'pending') {
    const token = key();
    const player = {
      id: key().slice(0, 16), name, status, seat: null, ready: false, sitOut: false,
      online: true, lastSeen: this.now(), joinedAt: this.now(),
      stats: { played: 0, wins: 0, ties: 0 }, tokenHash: digest(token), seenActions: new Map()
    };
    room.players.push(player);
    this.sessions.set(player.tokenHash, { roomId: room.id, playerId: player.id });
    return { player, token };
  }
  create(input = {}) {
    fail(!this.createPassword || sameSecret(input.password || '', this.createPassword), '방 생성 비밀번호가 올바르지 않습니다.', 403);
    fail(this.rooms.size < this.maxRooms, '서버의 방 개수 한도에 도달했습니다. 나중에 다시 시도해 주세요.', 503);
    const name = text(input.name, 16, '닉네임');
    const title = text(input.title || '친구들의 카드룸', 30, '방 이름');
    const maxPlayers = integer(input.maxPlayers ?? 6, 2, 9, '정원');
    fail(['ready', 'timed'].includes(input.mode ?? 'ready'), '진행 방식이 올바르지 않습니다.');
    const seconds = integer(input.seconds ?? 10, 5, 60, '공개 간격');
    let id;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { id = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (this.rooms.has(id));
    const room = {
      id, title, maxPlayers, mode: input.mode ?? 'ready', seconds, autoNext: Boolean(input.autoNext),
      invite: key(), players: [], hostId: null, hand: null, round: 0, dealerSeat: -1,
      phase: 'lobby', locked: false, paused: false, remaining: null,
      deadline: null, nextRoundAt: null, revision: 0, log: [], history: [], updatedAt: this.now()
    };
    const { player, token } = this.newPlayer(room, name, 'approved');
    player.seat = 0;
    room.hostId = player.id;
    this.rooms.set(id, room);
    this.log(room, `${name} 님이 방을 만들었습니다.`);
    this.notify(room);
    return { token, state: this.view(room, player) };
  }
  join(input = {}) {
    const room = this.rooms.get(String(input.room || '').trim().toUpperCase());
    fail(room && sameSecret(input.invite || '', room.invite), '초대 링크가 올바르지 않거나 방이 만료되었습니다.', 404);
    fail(!room.locked, '방이 잠겨 있습니다. 방장에게 잠금 해제를 요청해 주세요.', 403);
    fail(room.players.filter(p => p.status === 'approved').length < room.maxPlayers, '방의 정원이 가득 찼습니다.');
    fail(room.players.filter(p => p.status === 'pending').length < 18, '입장 대기자가 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    const name = text(input.name, 16, '닉네임');
    fail(!room.players.some(p => ['approved', 'pending'].includes(p.status) && p.name.toLocaleLowerCase() === name.toLocaleLowerCase()), '이미 사용 중인 닉네임입니다. 다른 이름을 입력해 주세요.');
    const { player, token } = this.newPlayer(room, name);
    this.log(room, `${name} 님이 입장을 요청했습니다.`);
    this.notify(room);
    return { token, state: this.view(room, player) };
  }
  auth(token) {
    fail(typeof token === 'string' && token.length >= 20 && token.length <= 100, '접속 정보가 만료되었습니다. 초대 링크로 다시 들어와 주세요.', 401);
    const session = this.sessions.get(digest(token));
    const room = session && this.rooms.get(session.roomId);
    const player = room?.players.find(p => p.id === session.playerId);
    fail(room && player && ['approved', 'pending'].includes(player.status), '방이 종료되었거나 서버가 재시작되었거나 입장이 취소되었습니다. 방장에게 새 초대 링크를 요청해 주세요.', 401);
    return { room, player };
  }
  markSeen(room, player) {
    player.lastSeen = this.now();
    if (!player.online) { player.online = true; this.notify(room); }
  }
  eligible(room) {
    return room.players.filter(p => p.status === 'approved' && !p.sitOut && p.online).sort((a, b) => a.seat - b.seat);
  }
  readyForNext(room) { const ps = this.eligible(room); return ps.length >= 2 && ps.every(p => p.ready); }
  host(room, player) { fail(player.id === room.hostId, '방장만 사용할 수 있는 기능입니다.', 403); }
  guardHand(room, input) {
    fail((room.hand?.id ?? null) === (input.handId ?? null) && room.phase === input.phase,
      '화면이 갱신되었습니다. 현재 단계를 확인하고 다시 눌러 주세요.', 409);
  }
  start(room, force = false) {
    const ps = this.eligible(room);
    fail(ps.length >= 2, '접속 중인 참가자가 2명 이상 필요합니다.');
    fail(force || ps.every(p => p.ready), '참가할 사람 모두 준비를 눌러야 합니다.');
    // Remove former members only when no current round refers to them anymore.
    room.players = room.players.filter(p => ['approved', 'pending'].includes(p.status));
    const dealer = room.dealerSeat < 0 ? ps[randomInt(ps.length)] : ps.find(p => p.seat > room.dealerSeat) || ps[0];
    room.dealerSeat = dealer.seat;
    const ordered = [...ps.filter(p => p.seat > dealer.seat), ...ps.filter(p => p.seat <= dealer.seat)];
    const deck = shuffledDeck();
    const participants = ps.map(p => ({ id: p.id, name: p.name, seat: p.seat, cards: [] }));
    for (let pass = 0; pass < 2; pass++) for (const p of ordered) participants.find(x => x.id === p.id).cards.push(deck.pop());
    deck.pop(); const board = [deck.pop(), deck.pop(), deck.pop()];
    deck.pop(); board.push(deck.pop()); deck.pop(); board.push(deck.pop());
    room.round++;
    room.phase = 'private';
    room.hand = { id: key().slice(0, 16), number: room.round, participants, board, acknowledged: new Set(), results: null };
    for (const p of room.players) p.ready = false;
    room.nextRoundAt = null;
    room.deadline = room.mode === 'timed' && !room.paused ? this.now() + room.seconds * 1000 : null;
    room.remaining = room.paused && room.mode === 'timed' ? room.seconds * 1000 : null;
    this.log(room, `${room.round}라운드 시작 · ${ps.length}명 · D ${dealer.name}`);
  }
  canAdvance(room) {
    return room.hand?.participants.every(h => {
      const p = room.players.find(p => p.id === h.id);
      return !p || p.status !== 'approved' || !p.online || room.hand.acknowledged.has(p.id);
    });
  }
  advance(room) {
    if (!['private', 'flop', 'turn', 'river'].includes(room.phase)) return;
    room.phase = PHASES[PHASES.indexOf(room.phase) + 1];
    room.hand.acknowledged.clear();
    room.deadline = room.mode === 'timed' && !room.paused ? this.now() + room.seconds * 1000 : null;
    this.log(room, `${room.round}라운드 · ${LABELS[room.phase]} 공개`);
    if (room.phase === 'showdown') {
      room.deadline = null;
      const results = room.hand.participants.map(p => {
        const evaluated = evaluate([...p.cards, ...room.hand.board]);
        return { id: p.id, name: p.name, cards: [...p.cards], handName: evaluated.name, score: evaluated.score, bestCards: evaluated.bestCards };
      });
      results.sort((a, b) => compareScores(b.score, a.score) || a.name.localeCompare(b.name, 'ko'));
      const top = results[0].score;
      const winners = results.filter(r => compareScores(r.score, top) === 0);
      for (const result of results) {
        result.winner = winners.some(w => w.id === result.id);
        const p = room.players.find(p => p.id === result.id);
        if (p) {
          p.stats.played++;
          if (result.winner) p.stats[winners.length > 1 ? 'ties' : 'wins']++;
        }
      }
      room.hand.results = results;
      room.history.unshift({ round: room.round, at: this.now(), board: [...room.hand.board], results: structuredClone(results) });
      room.history = room.history.slice(0, 30);
      for (const p of room.players) p.ready = false;
      room.nextRoundAt = room.autoNext && room.mode === 'timed' && !room.paused ? this.now() + 12_000 : null;
      this.log(room, `${winners.map(p => p.name).join(', ')} · ${winners.length > 1 ? '공동 승리' : '승리'}`);
    }
  }
  progress(room) {
    if (room.paused) return;
    if (['private', 'flop', 'turn', 'river'].includes(room.phase) && this.canAdvance(room)) this.advance(room);
    else if (room.phase === 'showdown' && room.autoNext && this.readyForNext(room)) this.start(room);
  }
  revoke(room, player, status) {
    player.status = status;
    this.sessions.delete(player.tokenHash);
    player.ready = false;
    player.online = false;
    if (!room.hand?.participants.some(p => p.id === player.id)) room.players = room.players.filter(p => p.id !== player.id);
    if (player.id === room.hostId) {
      const next = room.players.filter(p => p.status === 'approved').sort((a, b) => Number(b.online) - Number(a.online) || a.joinedAt - b.joinedAt)[0];
      if (next) { room.hostId = next.id; this.log(room, `${next.name} 님이 방장이 되었습니다.`); }
      else { this.close(room); return; }
    }
    this.progress(room);
  }
  close(room) {
    for (const p of room.players) this.sessions.delete(p.tokenHash);
    this.rooms.delete(room.id);
    this.onChange(room, true);
  }
  action(token, input = {}) {
    const { room, player } = this.auth(token);
    this.markSeen(room, player);
    fail(typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId), '요청 식별자가 올바르지 않습니다.');
    if (player.seenActions.has(input.requestId)) return { ok: true, state: this.view(room, player) };
    const action = input.action;
    if (action !== 'leave') fail(player.status === 'approved', '방장의 입장 승인을 기다려 주세요.', 403);
    const target = () => {
      const p = room.players.find(p => p.id === input.playerId);
      fail(p, '해당 참가자를 찾을 수 없습니다.', 404); return p;
    };
    switch (action) {
      case 'approve': {
        this.host(room, player);
        const p = target();
        fail(p.status === 'pending', '이미 처리된 입장 요청입니다.');
        fail(!room.locked, '방 잠금을 먼저 해제해 주세요.');
        const approved = room.players.filter(x => x.status === 'approved');
        fail(approved.length < room.maxPlayers, '정원이 가득 찼습니다.');
        const reserved = ['private', 'flop', 'turn', 'river'].includes(room.phase) ? room.hand.participants : [];
        const seat = Array.from({ length: 9 }, (_, i) => i).find(s => !approved.some(x => x.seat === s) && !reserved.some(x => x.seat === s));
        fail(seat !== undefined, '이번 라운드가 끝난 후 승인해 주세요.');
        p.status = 'approved'; p.seat = seat;
        this.log(room, `${p.name} 님의 입장이 승인되었습니다.`); break;
      }
      case 'reject': {
        this.host(room, player); const p = target();
        fail(p.status === 'pending', '입장 대기자만 거절할 수 있습니다.');
        this.revoke(room, p, 'rejected'); break;
      }
      case 'kick': {
        this.host(room, player); const p = target();
        fail(p.id !== player.id && p.status === 'approved', '다른 참가자를 선택해 주세요.');
        fail(!['private', 'flop', 'turn', 'river'].includes(room.phase), '라운드가 끝난 뒤 내보낼 수 있습니다.');
        this.log(room, `${p.name} 님을 내보냈습니다.`); this.revoke(room, p, 'removed'); break;
      }
      case 'ready': {
        this.guardHand(room, input);
        fail(['lobby', 'showdown'].includes(room.phase), '라운드가 진행 중입니다.');
        fail(!player.sitOut, '자리 비움을 해제해 주세요.');
        player.ready = Boolean(input.ready); this.progress(room); break;
      }
      case 'ack': {
        this.guardHand(room, input);
        fail(['private', 'flop', 'turn', 'river'].includes(room.phase), '현재는 확인 버튼을 누를 단계가 아닙니다.');
        fail(room.hand.participants.some(p => p.id === player.id), '다음 라운드부터 참가할 수 있습니다.');
        room.hand.acknowledged.add(player.id); this.progress(room); break;
      }
      case 'start': {
        this.host(room, player); this.guardHand(room, input);
        fail(['lobby', 'showdown'].includes(room.phase), '이미 라운드가 진행 중입니다.');
        fail(!room.paused, '일시정지를 해제해 주세요.'); this.start(room); break;
      }
      case 'advance': {
        this.host(room, player); this.guardHand(room, input);
        fail(!room.paused, '일시정지를 해제해 주세요.');
        fail(['private', 'flop', 'turn', 'river'].includes(room.phase), '공개할 다음 카드가 없습니다.');
        this.advance(room); break;
      }
      case 'lock': this.host(room, player); room.locked = Boolean(input.locked); break;
      case 'rotateInvite': this.host(room, player); room.invite = key(); this.log(room, '초대 링크를 변경했습니다. 이전 링크로는 새로 입장할 수 없습니다.'); break;
      case 'sitOut':
        player.sitOut = Boolean(input.sitOut); player.ready = false;
        this.log(room, `${player.name} · ${player.sitOut ? '다음 라운드부터 자리 비움' : '다음 라운드 참가'}`);
        break;
      case 'pause': {
        this.host(room, player);
        if (Boolean(input.paused) !== room.paused) {
          room.paused = Boolean(input.paused);
          if (room.paused) {
            room.remaining = (room.deadline ?? room.nextRoundAt) ? Math.max(0, (room.deadline ?? room.nextRoundAt) - this.now()) : null;
            room.deadline = room.nextRoundAt = null;
          } else {
            if (room.remaining !== null) {
              if (room.phase === 'showdown') room.nextRoundAt = this.now() + room.remaining;
              else room.deadline = this.now() + room.remaining;
            }
            room.remaining = null; this.progress(room);
          }
          this.log(room, room.paused ? '방장이 진행을 일시정지했습니다.' : '진행을 재개했습니다.');
        }
        break;
      }
      case 'transfer': {
        this.host(room, player); const p = target();
        fail(p.status === 'approved' && p.online && p.id !== player.id, '접속 중인 다른 참가자를 선택해 주세요.');
        room.hostId = p.id; this.log(room, `${p.name} 님에게 방장을 넘겼습니다.`); break;
      }
      case 'claimHost': {
        const host = room.players.find(p => p.id === room.hostId);
        fail(!host || this.now() - host.lastSeen >= TAKEOVER_MS, '방장 연결이 90초 이상 끊겼을 때 인계받을 수 있습니다.');
        room.hostId = player.id; this.log(room, `${player.name} 님이 연결 끊긴 방장을 대신합니다.`); break;
      }
      case 'settings': {
        this.host(room, player);
        fail(['lobby', 'showdown'].includes(room.phase), '설정은 라운드 사이에 변경해 주세요.');
        fail(!room.paused, '일시정지를 해제한 뒤 설정해 주세요.');
        fail(['ready', 'timed'].includes(input.mode), '진행 방식이 올바르지 않습니다.');
        const seconds = integer(input.seconds, 5, 60, '공개 간격');
        room.mode = input.mode; room.seconds = seconds; room.autoNext = Boolean(input.autoNext);
        room.nextRoundAt = room.phase === 'showdown' && room.autoNext && room.mode === 'timed' ? this.now() + 12_000 : null;
        break;
      }
      case 'leave': {
        this.log(room, `${player.name} 님이 나갔습니다.`); this.revoke(room, player, 'left');
        if (this.rooms.has(room.id)) this.notify(room);
        return { ok: true, left: true };
      }
      case 'close': this.host(room, player); this.close(room); return { ok: true, left: true };
      default: throw new GameError('지원하지 않는 요청입니다.');
    }
    player.seenActions.set(input.requestId, true);
    if (player.seenActions.size > 80) player.seenActions.delete(player.seenActions.keys().next().value);
    this.notify(room);
    return { ok: true, state: this.view(room, player) };
  }
  tick() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const liveMembers = room.players.filter(p => ['approved', 'pending'].includes(p.status));
      if (!liveMembers.length || liveMembers.every(p => now - p.lastSeen > 6 * 60 * 60 * 1000)) { this.close(room); continue; }
      let changed = false;
      for (const p of liveMembers) {
        const online = now - p.lastSeen < ONLINE_MS;
        if (p.online !== online) { p.online = online; changed = true; }
        if (p.status === 'pending' && now - p.lastSeen > 10 * 60 * 1000) {
          this.sessions.delete(p.tokenHash); p.status = 'expired'; changed = true;
        }
      }
      room.players = room.players.filter(p => ['approved', 'pending'].includes(p.status) || room.hand?.participants.some(h => h.id === p.id));
      // All-disconnected rooms stop advancing rather than playing unattended.
      const anyParticipantOnline = room.hand?.participants.some(h => room.players.some(p => p.id === h.id && p.status === 'approved' && p.online));
      if (!room.paused && anyParticipantOnline && ['private', 'flop', 'turn', 'river'].includes(room.phase)) {
        if ((room.deadline && now >= room.deadline) || this.canAdvance(room)) { this.advance(room); changed = true; }
      }
      if (!room.paused && room.phase === 'showdown' && room.nextRoundAt && now >= room.nextRoundAt) {
        if (this.eligible(room).length >= 2) this.start(room, true);
        else { room.nextRoundAt = null; this.log(room, '다음 라운드 대기 · 접속 중인 참가자가 2명 이상 필요합니다.'); }
        changed = true;
      }
      if (!room.paused && room.phase === 'showdown' && room.autoNext && room.mode === 'ready' && this.readyForNext(room)) {
        this.start(room); changed = true;
      }
      if (changed) this.notify(room);
    }
  }
  view(room, viewer) {
    const now = this.now();
    const base = { serverTime: now, revision: room.revision, roomId: room.id, title: room.title,
      me: { id: viewer.id, name: viewer.name, status: viewer.status }, hostId: room.hostId };
    // Pending membership exposes no roster, board, cards, history or invite secret.
    if (viewer.status !== 'approved') return base;
    const shown = { lobby: 0, private: 0, flop: 3, turn: 4, river: 5, showdown: 5 }[room.phase];
    const host = room.players.find(p => p.id === room.hostId);
    const participants = room.hand?.participants || [];
    const allIds = new Set([...room.players.filter(p => p.status === 'approved').map(p => p.id), ...participants.map(p => p.id)]);
    return {
      ...base, phase: room.phase, round: room.round, handId: room.hand?.id ?? null,
      maxPlayers: room.maxPlayers, mode: room.mode, seconds: room.seconds, autoNext: room.autoNext,
      paused: room.paused, locked: room.locked, deadline: room.deadline, nextRoundAt: room.nextRoundAt,
      dealerSeat: room.dealerSeat, board: room.hand?.board.slice(0, shown) || [],
      canClaimHost: viewer.id !== room.hostId && (!host || now - host.lastSeen >= TAKEOVER_MS),
      invite: viewer.id === room.hostId ? room.invite : undefined,
      pending: viewer.id === room.hostId ? room.players.filter(p => p.status === 'pending').map(p => ({ id: p.id, name: p.name, online: p.online })) : [],
      players: [...allIds].map(id => {
        const p = room.players.find(p => p.id === id);
        const h = participants.find(p => p.id === id);
        return {
          id, name: h?.name ?? p.name, seat: h?.seat ?? p.seat,
          online: p?.status === 'approved' && p.online, left: p?.status !== 'approved',
          ready: Boolean(p?.ready), sitOut: Boolean(p?.sitOut), playing: Boolean(h),
          acknowledged: Boolean(room.hand?.acknowledged.has(id)),
          cards: h ? (id === viewer.id || room.phase === 'showdown' ? [...h.cards] : [null, null]) : [],
          stats: p ? { ...p.stats } : { played: 0, wins: 0, ties: 0 }
        };
      }).sort((a, b) => a.seat - b.seat),
      results: room.phase === 'showdown' ? structuredClone(room.hand.results) : null,
      history: structuredClone(room.history), log: room.log.map(item => ({ ...item }))
    };
  }
}
