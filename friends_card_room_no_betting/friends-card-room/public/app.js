'use strict';
const $ = id => document.getElementById(id);
const sessionKey = 'friends-card-room.session.v1';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const PHASE_NAMES = { lobby: '대기실', private: '개인 카드', flop: '플롭', turn: '턴', river: '리버', showdown: '결과' };
const PHASES = ['private', 'flop', 'turn', 'river', 'showdown'];
const SUITS = ['♠', '♥', '♦', '♣'];
let token = '', state = null, pollGeneration = 0, pollAbort = null, busy = false;
let hiddenCards = false, serverOffset = 0, toastTimer, settingsDraft = null, online = false;
function patch(id, html) {
  const node = $(id);
  if (node && node._html !== html) {
    const openDetails = [...node.querySelectorAll('details')].map(d => d.open);
    node.innerHTML = html; node._html = html;
    [...node.querySelectorAll('details')].forEach((d, i) => { if (openDetails[i] !== undefined) d.open = openDetails[i]; });
  }
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = `visible${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => { $('toast').className = ''; }, error ? 8000 : 4000);
}
function connection(value, ok) { $('connection').textContent = value; $('connection').className = `connection ${ok ? 'online' : 'offline'}`; online = ok; }
function persist(value) {
  try { value ? localStorage.setItem(sessionKey, value) : localStorage.removeItem(sessionKey); }
  catch { if (value) toast('이 브라우저에서는 접속 정보를 저장할 수 없어요. 새로고침하면 다시 입장을 요청해야 해요.', true); }
}
function checked(value) { return value ? ' checked' : ''; }
function selected(a, b) { return String(a) === String(b) ? ' selected' : ''; }
function disabled(value) { return value ? ' disabled' : ''; }
function button(action, label, kind = 'secondary', extra = '') { return `<button class="button ${kind}" data-action="${action}" ${extra}>${label}</button>`; }
function card(value, mini = false, blank = false) {
  const size = mini ? ' mini' : '';
  if (value === null || value === undefined) return `<span class="card ${blank ? 'blank' : 'back'}${size}" role="img" aria-label="${blank ? '아직 공개되지 않은 공통 카드' : '뒷면 카드'}"></span>`;
  const rank = value % 13 + 2, suit = Math.floor(value / 13);
  const r = ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || rank;
  return `<span class="card${size}${suit === 1 || suit === 2 ? ' red' : ''}" role="img" aria-label="${r} ${SUITS[suit]}"><span class="corner">${r}<small>${SUITS[suit]}</small></span><span class="pip" aria-hidden="true">${SUITS[suit]}</span></span>`;
}
function cards(values, mini = false) { return values.map(c => card(c, mini)).join(''); }
async function api(path, data, signal) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers,
    body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store',
    signal: signal || AbortSignal.timeout(20_000) });
  let body;
  try { body = await response.json(); } catch { throw new Error('서버 응답을 읽을 수 없어요. 서버 시작 또는 연결 상태를 확인해 주세요.'); }
  if (!response.ok) { const err = new Error(body.error || '요청에 실패했습니다.'); err.status = response.status; throw err; }
  return body;
}
function acceptState(next) {
  if (state && next.roomId === state.roomId && next.revision < state.revision) return;
  serverOffset = next.serverTime - Date.now();
  state = next; connection('실시간 연결됨', true); render();
}
function stopSession(message = '') {
  token = ''; state = null; settingsDraft = null; pollGeneration++; pollAbort?.abort(); persist('');
  $('home').hidden = false; $('room').hidden = true; connection('초대받은 친구들과 함께', false);
  if (message) toast(message, true);
}
async function poll() {
  const generation = ++pollGeneration;
  let delay = 500;
  while (token && generation === pollGeneration) {
    try {
      pollAbort = new AbortController();
      const timeout = setTimeout(() => pollAbort?.abort(), 28_000);
      let response;
      try { response = await api(`/api/state?wait=1&since=${state?.revision ?? -1}`, undefined, pollAbort.signal); }
      finally { clearTimeout(timeout); }
      if (generation !== pollGeneration) break;
      acceptState(response); delay = 500;
      await new Promise(resolve => setTimeout(resolve, 80));
    } catch (err) {
      if (generation !== pollGeneration) break;
      if (err.status === 401) { stopSession(err.message); break; }
      connection('연결 복구 중 · 화면을 닫지 마세요', false);
      await new Promise(resolve => setTimeout(resolve, err.status === 429 ? 5000 : delay));
      delay = Math.min(delay * 2, 6000);
    }
  }
}
function startSession(result) {
  pollGeneration++; pollAbort?.abort(); token = result.token; persist(token); state = null;
  acceptState(result.state); history.replaceState(null, '', location.pathname); poll();
}
function currentMe() { return state?.players?.find(p => p.id === state.me.id); }
function render() {
  if (!state) return;
  $('home').hidden = true; $('room').hidden = false;
  const s = state, isHost = s.hostId === s.me.id, me = currentMe();
  patch('room-head', `<div class="room-heading"><div><h1>${escape(s.title)}</h1><div class="room-meta">ROOM ${escape(s.roomId)} · ${s.me.status === 'pending' ? '입장 승인 대기' : `최대 ${s.maxPlayers}명 · ${s.locked ? '잠긴 방' : '초대 전용'}`}</div></div><div class="heading-actions">${button('leave', '나가기', 'subtle')}</div></div>`);
  const pending = s.me.status !== 'approved';
  $('waiting').hidden = !pending; $('game').hidden = pending;
  if (pending) {
    patch('waiting', `<section class="panel waiting-panel"><div class="waiting-symbol waiting-dot" aria-hidden="true">♧</div><p class="eyebrow">WAITING FOR APPROVAL</p><h2>방장의 승인을 기다리고 있어요.</h2><p><strong>${escape(s.me.name)}</strong> 이름으로 입장을 요청했어요.<br>승인되면 자동으로 테이블로 이동해요.</p>${button('leave', '입장 요청 취소', 'secondary')}</section>`);
    return;
  }
  const live = !['lobby', 'showdown'].includes(s.phase);
  const active = s.players.filter(p => !p.left && !p.sitOut && p.online);
  const hostName = s.players.find(p => p.id === s.hostId)?.name || '';
  patch('table-top', `<div class="table-topline"><span class="phase-chip">${s.paused ? 'Ⅱ 일시정지' : `● ROUND ${String(s.round).padStart(2, '0')}`} · ${PHASE_NAMES[s.phase]}</span><div class="phase-steps">${PHASES.map((phase, i) => `<span class="${phase === s.phase ? 'active' : PHASES.indexOf(s.phase) > i ? 'done' : ''}">${PHASE_NAMES[phase]}</span>`).join('')}</div></div>`);
  const others = s.players.filter(p => p.id !== s.me.id);
  const seat = p => {
    const winner = s.results?.some(r => r.id === p.id && r.winner);
    const label = p.left ? '퇴장' : p.sitOut && !p.playing ? '자리 비움' : !p.online ? '연결 끊김' : live ? (p.playing ? p.acknowledged ? '확인 완료 ✓' : '카드 확인 중' : '다음 라운드 대기') : p.ready ? '준비 완료 ✓' : winner ? '승리 ✦' : '대기 중';
    return `<div class="seat${winner ? ' winner' : ''}${!p.online ? ' offline' : ''}"><span class="name">${escape(p.name)}${p.seat === s.dealerSeat ? '<span class="dealer" title="카드 배분 기준 자리">D</span>' : ''}</span><div class="mini-cards">${p.cards.length ? cards(p.cards, true) : card(null, true) + card(null, true)}</div><div class="seat-status">${label}</div></div>`;
  };
  const showCards = Array.from({ length: 5 }, (_, i) => card(s.board[i], false, s.board[i] === undefined)).join('');
  const caption = s.phase === 'lobby' ? '친구들이 모이면 준비하고 시작해요.' : s.phase === 'showdown' ? '7장 중 가장 강한 5장으로 승패를 비교해요.' : s.mode === 'ready' ? '카드를 봤다면 아래의 확인 버튼을 눌러 주세요.' : '시간이 지나거나 모두 확인하면 다음 카드가 공개돼요.';
  patch('table', `<div class="opponent-row">${others.slice(0, 4).map(seat).join('') || '<div class="table-empty">친구를 초대해 주세요.</div>'}</div><div class="board-wrap"><p class="board-label">COMMUNITY CARDS</p><div class="board-cards">${showCards}</div><p class="board-caption">${caption}</p></div><div class="opponent-row">${others.slice(4, 8).map(seat).join('')}</div>`);
  const myCards = me?.cards.length ? me.cards : [];
  patch('my-area', `<div class="my-hand"><div class="my-hand-left"><div class="my-cards">${myCards.length ? cards(hiddenCards ? [null, null] : myCards) : card(null) + card(null)}</div><div><h3 class="my-hand-name">${escape(s.me.name)}${me?.seat === s.dealerSeat ? '<span class="dealer">D</span>' : ''}</h3><p class="my-hand-copy">${myCards.length ? s.phase === 'showdown' ? '결과에서 모두의 카드가 공개돼요.' : hiddenCards ? '내 카드를 화면에서 가렸어요.' : '이 카드 2장은 나에게만 보여요.' : live ? '다음 라운드부터 참가해요.' : '시작하면 카드 2장을 받아요.'}</p><span class="hand-private">${s.phase === 'showdown' ? 'SHOWDOWN' : 'ONLY YOU'}</span></div></div>${myCards.length ? button('hide', hiddenCards ? '카드 보기' : '잠깐 가리기', 'subtle small') : ''}</div>`);
  renderResults(s);
  const everyoneReady = active.length >= 2 && active.every(p => p.ready);
  const readyCount = active.filter(p => p.ready).length;
  const ackCount = s.players.filter(p => p.playing && (p.acknowledged || p.left || !p.online)).length;
  const playingCount = s.players.filter(p => p.playing).length;
  let controls;
  if (!live) {
    controls = `<p class="control-copy">${s.phase === 'showdown' ? '다음 라운드에 참가하려면 준비를 눌러 주세요.' : '카드를 나누기 전에 각자 준비를 눌러 주세요.'}<br><span class="status-strong">준비 ${readyCount} / ${active.length}명</span> · ${isHost ? '모두 준비하면 시작 버튼이 켜져요.' : `방장 ${escape(hostName)} 님이 시작할 수 있어요.`}</p>${s.nextRoundAt ? '<div class="timer-line"><span>다음 라운드 자동 시작</span><b id="phase-count"></b></div><progress id="timer-progress" class="timer-progress" max="12" value="12"></progress>' : ''}<div class="control-row">${button('ready', me?.ready ? '✓ 준비 완료 · 취소' : '준비하기', `${me?.ready ? 'secondary' : 'primary'} main-action`, disabled(me?.sitOut))}${isHost ? button('start', s.phase === 'showdown' ? '다음 라운드 시작' : '카드 나누기', 'secondary', disabled(!everyoneReady || s.paused)) : ''}</div>`;
  } else {
    controls = `<p class="control-copy"><span class="status-strong">확인 ${ackCount} / ${playingCount}명</span> · ${s.paused ? '방장이 진행을 잠시 멈췄어요.' : s.mode === 'ready' ? '이번 단계의 참가자 모두 확인하면 자동으로 넘어가요.' : `${s.seconds}초 간격으로 공개해요. 모두 확인하면 바로 넘어가요.`}</p>${s.deadline ? '<div class="timer-line"><span>다음 공개까지</span><b id="phase-count"></b></div><progress id="timer-progress" class="timer-progress" value="10" max="60"></progress>' : ''}<div class="control-row">${me?.playing ? button('ack', me.acknowledged ? '✓ 확인 완료 · 친구들 기다리는 중' : s.phase === 'river' ? '확인했어요 · 결과 보기' : '확인했어요 · 다음 카드 준비', `${me.acknowledged ? 'secondary' : 'primary'} main-action`, disabled(me.acknowledged)) : '<p class="read-only">이번 라운드는 관전 중이에요.</p>'}</div><p class="short-note">35초 이상 응답이 없는 참가자는 자동 확인 처리돼요. 자리 비움은 다음 라운드부터 적용돼요.</p>`;
  }
  controls += `<div class="control-row">${button('sitOut', me?.sitOut ? '자리 비움 해제' : '다음 라운드 쉬기', 'subtle small')}</div>${!online ? '<p class="notice warning">연결 복구 중입니다.</p>' : ''}`;
  patch('controls', controls);
  patch('invite-panel', `<div class="panel-title"><h3>${isHost ? '친구 초대하기' : '초대 전용 테이블'}</h3><span>${s.locked ? '잠김' : '승인 필요'}</span></div>${isHost ? `${button('copyInvite', '초대 링크 복사', 'primary full')}<p class="short-note">링크를 받은 친구의 닉네임을 확인하고 입장을 승인해 주세요. 링크는 아는 사람에게만 보내 주세요.</p>` : `<p class="notice">방장 ${escape(hostName)} 님이 입장을 관리해요. 추가 참가자는 방장에게 초대 링크를 요청해 주세요.</p>`}<p class="short-note">서버 재시작 시 방과 기록이 초기화돼요. 중요한 결과는 아래에서 저장해 주세요.</p>`);
  patch('roster', `<div class="panel-title"><h3>참가자</h3><span>${s.players.filter(p => !p.left).length} / ${s.maxPlayers}</span></div><p class="score-label">기록: 참여 · 단독승 · 공동승</p>${s.players.map(p => `<div class="roster-row"><div class="avatar${p.id === s.me.id ? ' me' : ''}">${escape([...p.name][0])}</div><div class="roster-info"><div class="roster-name"><span>${escape(p.name)}</span>${p.id === s.me.id ? '<small>나</small>' : ''}${p.id === s.hostId ? '<small>방장</small>' : ''}</div><div class="roster-sub">${p.stats.played}회 · ${p.stats.wins}승 · ${p.stats.ties}공동승</div></div><span class="roster-status${p.ready || p.acknowledged ? ' ready' : ''}">${p.left ? '퇴장' : !p.online ? '연결 끊김' : p.sitOut ? '다음 판 쉼' : live && p.playing ? p.acknowledged ? '확인 ✓' : '진행 중' : p.ready ? '준비 ✓' : '대기'}</span></div>`).join('')}`);
  $('pending').hidden = !isHost || !s.pending.length;
  if (isHost) patch('pending', `<div class="panel-title"><h3>입장 요청</h3><span>${s.pending.length}명</span></div>${s.pending.map(p => `<div class="pending-person"><span>${escape(p.name)}${p.online ? '' : ' (연결 끊김)'}</span><div class="pending-actions">${button('approve', '승인', 'primary small', `data-id="${p.id}"${disabled(s.locked)}`)}${button('reject', '거절', 'subtle small', `data-id="${p.id}"`)}</div></div>`).join('')}`);
  $('host-panel').hidden = !isHost && !s.canClaimHost;
  if (isHost) renderHost(s, live);
  else if (s.canClaimHost) patch('host-panel', `<h3>방장 연결이 끊겼어요.</h3><p class="short-note">90초 이상 응답이 없어 방장을 인계받을 수 있어요.</p>${button('claimHost', '방장 인계받기', 'secondary full')}`);
  $('history-count').textContent = `(${s.history.length})`;
  patch('history', s.history.length ? s.history.map(h => `<div class="history-entry"><strong>${h.round}라운드 · ${escape(h.results.filter(r => r.winner).map(r => r.name).join(', '))}</strong><p>${escape(h.results[0].handName)} · ${h.results.filter(r => r.winner).length > 1 ? '공동 승리' : '승리'}</p><div class="mini-cards">${cards(h.board, true)}</div></div>`).join('') : '<p class="empty-history">라운드가 끝나면 공개된 결과가 여기에 기록돼요. 최근 30라운드를 보관해요.</p>');
  patch('log', s.log.map(l => `<div class="log-line"><small>${new Date(l.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>${escape(l.message)}</div>`).join(''));
  tickTimer();
}
function renderResults(s) {
  if (!s.results) { patch('result-area', ''); return; }
  const wins = s.results.filter(r => r.winner);
  patch('result-area', `<section class="panel result-panel"><p class="eyebrow">ROUND ${String(s.round).padStart(2, '0')} · RESULTS</p><h2 class="result-heading"><span class="win-icon">✦</span>${escape(wins.map(r => r.name).join(', '))} ${wins.length > 1 ? '공동 승리' : '승리'}</h2><p class="result-subtitle">오른쪽 5장이 각 참가자의 가장 강한 조합이에요. 무늬로 순위를 나누지 않아요.</p><div class="result-list">${s.results.map(r => `<div class="result-row"><div><div class="result-person">${r.winner ? '✦ ' : ''}${escape(r.name)}${r.id === s.me.id ? ' (나)' : ''}</div><p class="result-hand">${escape(r.handName || r.name)}</p></div><div class="best-five">${cards(r.bestCards, true)}</div></div>`).join('')}</div></section>`);
}
function renderHost(s, live) {
  const config = settingsDraft || s;
  const form = `<form id="settings-form"><div class="form-row"><label>진행 방식<select name="mode"${disabled(live || s.paused)}><option value="ready"${selected(config.mode, 'ready')}>모두 확인</option><option value="timed"${selected(config.mode, 'timed')}>시간 공개</option></select></label><label>공개 간격<select name="seconds"${disabled(live || s.paused)}>${[5, 10, 15, 30, 60].map(x => `<option value="${x}"${selected(config.seconds, x)}>${x}초</option>`).join('')}</select></label></div><label class="check-label"><input name="autoNext" type="checkbox"${checked(config.autoNext)}${disabled(live || s.paused)}><span>다음 라운드 자동 시작</span></label><button class="button secondary full small" type="submit"${disabled(live || s.paused)}>진행 설정 적용</button></form>`;
  patch('host-panel', `<div class="panel-title"><h3>방장 관리</h3><span>HOST</span></div><div class="host-tools">${button('lock', s.locked ? '방 잠금 해제' : '추가 입장 잠그기', 'secondary full')}${button('pause', s.paused ? '▶ 진행 재개' : 'Ⅱ 진행 일시정지', 'subtle full')}${live ? button('advance', '다음 단계 바로 공개', 'subtle full', disabled(s.paused)) : ''}${form}<details><summary>참가자 관리 · 방 종료</summary>${s.players.filter(p => !p.left && p.id !== s.me.id).map(p => `<div class="host-person"><span>${escape(p.name)}</span>${button('transfer', '방장 넘기기', 'subtle', `data-id="${p.id}"${disabled(!p.online)}`)}${button('kick', '퇴장', 'danger', `data-id="${p.id}"${disabled(live)}`)}</div>`).join('')}<div class="host-tools"><p class="short-note">초대 링크 변경은 신규 입장에만 적용돼요. 이미 승인된 참가자는 그대로 남아요.</p>${button('rotateInvite', '초대 링크 새로 만들기', 'subtle full small')}${button('close', '방 종료하기', 'danger full small')}</div></details></div>`);
}
function tickTimer() {
  if (!state) return;
  const end = state.deadline || state.nextRoundAt;
  if (!end || !$('phase-count')) return;
  const seconds = Math.max(0, Math.ceil((end - Date.now() - serverOffset) / 1000));
  $('phase-count').textContent = `${seconds}초`;
  const p = $('timer-progress'); if (p) { p.max = state.nextRoundAt ? 12 : state.seconds; p.value = seconds; }
}
setInterval(tickTimer, 250);
async function confirmAction(title, message) {
  const dlg = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-body').textContent = message;
  dlg.returnValue = ''; dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}
async function copyInvite() {
  const link = `${location.origin}${location.pathname}#join=${encodeURIComponent(state.roomId)}&key=${encodeURIComponent(state.invite)}`;
  try { await navigator.clipboard.writeText(link); toast('초대 링크를 복사했어요. 친구에게 보내 주세요.'); }
  catch { $('copy-text').value = link; $('copy-dialog').showModal(); $('copy-text').select(); }
}
async function act(action, extra = {}) {
  if (busy || !state) return;
  busy = true;
  try {
    const data = { action, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''), handId: state.handId, phase: state.phase, ...extra };
    const response = await api('/api/action', data);
    if (response.left) stopSession();
    else if (response.state) acceptState(response.state);
  } catch (err) { if (err.status === 401) stopSession(err.message); else toast(err.message, true); }
  finally { busy = false; }
}
async function handleAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled || !state) return;
  const a = target.dataset.action, me = currentMe();
  if (a === 'hide') { hiddenCards = !hiddenCards; render(); return; }
  if (a === 'copyInvite') { await copyInvite(); return; }
  if (a === 'export') {
    const payload = { title: state.title, exportedAt: new Date().toISOString(), note: '공개된 결과만 포함. 접속 인증이나 미공개 카드 없음.', history: state.history };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `card-room-results-${state.roomId}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
  const confirmations = {
    leave: ['방에서 나갈까요?', '다시 들어오려면 초대 링크와 방장 승인이 필요해요. 마지막 참가자가 나가면 방이 종료돼요.'],
    close: ['방을 종료할까요?', '모든 참가자가 퇴장하고 방과 기록이 삭제돼요. 필요한 결과는 먼저 저장해 주세요.'],
    rotateInvite: ['초대 링크를 변경할까요?', '기존 링크로는 새로운 입장 요청을 할 수 없어요. 이미 입장한 참가자는 그대로 남아요.'],
    kick: ['참가자를 내보낼까요?', '해당 참가자는 다시 입장을 요청해야 해요.'],
    transfer: ['방장을 넘길까요?', '선택한 참가자가 입장 승인과 진행 관리 권한을 갖게 돼요.'],
    advance: ['다음 단계를 바로 공개할까요?', '아직 확인하지 않은 참가자가 있어도 다음 카드 또는 결과를 공개해요.']
  };
  if (confirmations[a] && !(await confirmAction(...confirmations[a]))) return;
  const data = {};
  if (target.dataset.id) data.playerId = target.dataset.id;
  if (a === 'ready') data.ready = !me.ready;
  if (a === 'sitOut') data.sitOut = !me.sitOut;
  if (a === 'lock') data.locked = !state.locked;
  if (a === 'pause') data.paused = !state.paused;
  await act(a, data);
}
document.addEventListener('click', event => { handleAction(event).catch(err => toast(err.message, true)); });
document.addEventListener('change', event => {
  if (event.target.closest('#settings-form')) {
    const form = $('settings-form'); settingsDraft = { mode: form.mode.value, seconds: Number(form.seconds.value), autoNext: form.autoNext.checked };
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  const f = event.target, draft = { mode: f.mode.value, seconds: Number(f.seconds.value), autoNext: f.autoNext.checked };
  settingsDraft = null; await act('settings', draft);
});
$('create-form').mode.addEventListener('change', event => { document.querySelector('.timed-option').hidden = event.target.value !== 'timed'; });
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    data.maxPlayers = Number(data.maxPlayers); data.seconds = Number(data.seconds); data.autoNext = form.autoNext.checked;
    startSession(await api('/api/rooms', data));
  } catch (err) { toast(err.message, true); } finally { submit.disabled = false; }
});
$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    let parsed;
    try { parsed = new URL(form.link.value.trim()); } catch { throw new Error('방장이 보낸 초대 링크 전체를 붙여 넣어 주세요.'); }
    if (parsed.origin !== location.origin) throw new Error('다른 서버의 초대 링크예요. 받은 링크를 새 탭에서 직접 열어 주세요.');
    const params = new URLSearchParams(parsed.hash.slice(1));
    if (!params.get('join') || !params.get('key')) throw new Error('방 코드와 초대 인증이 포함된 전체 링크가 필요해요.');
    startSession(await api('/api/join', { room: params.get('join'), invite: params.get('key'), name: form.elements.namedItem('name').value }));
  } catch (err) { toast(err.message, true); } finally { submit.disabled = false; }
});
function parseInvite() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('join') && params.has('key')) {
    $('join-form').link.value = location.href;
    $('invite-detected').textContent = `방 ${params.get('join')}의 초대 링크를 확인했어요. 닉네임을 입력해 주세요.`;
  }
}
parseInvite();
try { token = localStorage.getItem(sessionKey) || ''; } catch { /* Session remains in memory when storage is unavailable. */ }
if (token) { connection('이전 자리로 다시 연결 중', false); poll(); }
window.addEventListener('online', () => { if (token) { pollGeneration++; pollAbort?.abort(); poll(); } });
window.addEventListener('offline', () => { connection('인터넷 연결이 끊겼어요.', false); });
