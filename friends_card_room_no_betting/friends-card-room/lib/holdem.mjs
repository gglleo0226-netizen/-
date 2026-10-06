/** Pure, server-side no-limit hold'em engine. Chips have no monetary value.
 * This module has no network, payment, wallet, transfer, or prize functionality.
 * All chip values are integers. No client-selected cards or outcomes are accepted.
 */
import { shuffledDeck, evaluate, compareScores } from './cards.mjs';
export class PokerError extends Error {}
const requireThat = (ok, message) => { if (!ok) throw new PokerError(message); };
const live = h => h.participants.filter(p => !p.folded);
const actors = h => live(h).filter(p => p.stack > 0);
const orderedAfter = (ps, seat) => [...ps.filter(p => p.seat > seat), ...ps.filter(p => p.seat <= seat)];
const contribute = (p, amount) => {
  requireThat(Number.isSafeInteger(amount) && amount >= 0 && amount <= p.stack, '유효하지 않은 칩 수입니다.');
  p.stack -= amount; p.streetBet += amount; p.totalBet += amount; p.allIn = p.stack === 0;
};
export function potTotal(h) { return h.participants.reduce((s, p) => s + p.totalBet, 0); }
export function assertChips(h) {
  const total = h.participants.reduce((s, p) => {
    for (const field of ['stack', 'streetBet', 'totalBet']) {
      if (!Number.isSafeInteger(p[field]) || p[field] < 0) throw new Error(`Invalid ${field}`);
    }
    if (p.streetBet > p.totalBet) throw new Error('Street contribution exceeds hand contribution');
    return s + p.stack + (h.finished ? 0 : p.totalBet);
  }, 0);
  if (total !== h.initialChips) throw new Error(`Chip conservation: ${total} != ${h.initialChips}`);
}
export function createHand(players, { dealerSeat, sb, bb, deck = shuffledDeck() }) {
  requireThat(players.length >= 2 && players.length <= 9, '2~9명이 필요합니다.');
  requireThat(Number.isSafeInteger(sb) && sb > 0 && Number.isSafeInteger(bb) && bb >= sb, '블라인드 설정이 올바르지 않습니다.');
  requireThat(players.every(p => Number.isSafeInteger(p.stack) && p.stack > 0), '스택이 있는 참가자만 시작할 수 있습니다.');
  requireThat(new Set(players.map(p => p.id)).size === players.length && new Set(players.map(p => p.seat)).size === players.length, '중복 자리입니다.');
  requireThat(deck.length === 52 && new Set(deck).size === 52 && deck.every(c => Number.isInteger(c) && c >= 0 && c < 52), '올바른 덱이 필요합니다.');
  deck = [...deck];
  const participants = [...players].sort((a,b) => a.seat - b.seat).map(p => ({
    id:p.id, name:p.name, seat:p.seat, cards:[], stack:p.stack, startStack:p.stack,
    streetBet:0, totalBet:0, folded:false, allIn:false, actedAt:null, lastAction:'', won:0, returned:0
  }));
  requireThat(participants.some(p => p.seat === dealerSeat), '딜러 자리가 올바르지 않습니다.');
  const after = orderedAfter(participants, dealerSeat);
  const dealer = participants.find(p => p.seat === dealerSeat);
  const sbPlayer = participants.length === 2 ? dealer : after[0];
  const bbPlayer = participants.length === 2 ? after[0] : after[1];
  for (let i=0; i<2; i++) for (const p of after) p.cards.push(deck.pop());
  deck.pop(); const board = [deck.pop(), deck.pop(), deck.pop()];
  deck.pop(); board.push(deck.pop()); deck.pop(); board.push(deck.pop());
  const h = { participants, board, dealerSeat, sbSeat:sbPlayer.seat, bbSeat:bbPlayer.seat, sb, bb,
    phase:'private', shown:0, currentBet:bb, lastFullRaise:bb, actorId:null, turnSeq:1,
    finished:false, ending:null, results:null, pots:[], refunds:[], events:[],
    initialChips:participants.reduce((s,p)=>s+p.stack,0) };
  contribute(sbPlayer, Math.min(sb, sbPlayer.stack)); sbPlayer.lastAction = `SB ${sbPlayer.streetBet}`;
  contribute(bbPlayer, Math.min(bb, bbPlayer.stack)); bbPlayer.lastAction = `BB ${bbPlayer.streetBet}`;
  h.events.push(`블라인드 · ${sbPlayer.name} SB ${sbPlayer.streetBet} / ${bbPlayer.name} BB ${bbPlayer.streetBet}`);
  progress(h, bbPlayer.seat);
  assertChips(h); return h;
}
export function legalActions(h, playerId) {
  const p = h.participants.find(p=>p.id===playerId);
  if (!p || h.finished || p.folded || p.stack === 0 || h.actorId !== playerId) return null;
  const callDue = Math.max(0, h.currentBet-p.streetBet);
  const maxTotal = p.streetBet+p.stack;
  // A short all-in does not erase prior action; cumulative full raises reopen it.
  const reopened = p.actedAt === null || h.currentBet-p.actedAt >= h.lastFullRaise;
  const anotherCanRespond = actors(h).some(x => x.id !== p.id);
  const minRaiseTo = h.currentBet === 0 ? h.bb : h.currentBet + h.lastFullRaise;
  const canRaise = reopened && anotherCanRespond && maxTotal > h.currentBet;
  return { fold:true, check:callDue===0, call:callDue>0, callAmount:Math.min(callDue,p.stack), callDue,
    canRaise, minRaiseTo, maxTotal, canFullRaise:canRaise && maxTotal >= minRaiseTo,
    allIn: maxTotal <= h.currentBet || canRaise, reopened, streetBet:p.streetBet,
    stack:p.stack, turnSeq:h.turnSeq };
}
/** Fold/check/call/raise/allIn. 'amount' is a STREET TOTAL, never an increment. */
export function actHand(h, playerId, action, amount) {
  const a = legalActions(h, playerId);
  requireThat(a, '지금은 본인의 차례가 아닙니다.');
  const p = h.participants.find(p=>p.id===playerId);
  let label;
  if (action === 'fold') { p.folded = true; label='폴드'; }
  else if (action === 'check') { requireThat(a.check,'콜할 칩이 남아 있어 체크할 수 없습니다.'); label='체크'; }
  else if (action === 'call') { requireThat(a.call,'콜할 칩이 없습니다. 체크를 눌러 주세요.'); contribute(p,a.callAmount); label=`콜 ${a.callAmount}${p.allIn?' · 올인':''}`; }
  else if (action === 'raise' || action === 'allIn') {
    const target = action === 'allIn' ? a.maxTotal : amount;
    requireThat(Number.isSafeInteger(target) && target > p.streetBet && target <= a.maxTotal, '스택 범위 안의 정수 총액을 입력해 주세요.');
    if (action === 'allIn' && target <= h.currentBet) {
      contribute(p,p.stack); label=`올인 콜 · 총 ${target}`;
    } else {
      requireThat(a.canRaise,'지금은 레이즈할 수 없습니다. 콜 또는 폴드를 선택해 주세요.');
      requireThat(target > h.currentBet,'현재 베팅보다 큰 총액을 입력해 주세요.');
      requireThat(target >= a.minRaiseTo || target === a.maxTotal, `최소 총액은 ${a.minRaiseTo}입니다. 미달 레이즈는 올인일 때만 가능합니다.`);
      const before = h.currentBet, increase = target-before;
      contribute(p,target-p.streetBet);
      if (increase >= h.lastFullRaise) h.lastFullRaise=increase;
      h.currentBet=target;
      label=`${before===0?'베트':'레이즈'} 총 ${target}${p.allIn?' · 올인':''}`;
    }
  } else throw new PokerError('지원하지 않는 베팅입니다.');
  p.actedAt=h.currentBet; p.lastAction=label; h.events.push(`${p.name} · ${label}`);
  h.turnSeq++; progress(h,p.seat); assertChips(h);
}
/** Explicitly leaving folds an uncommitted hand, but never kills an all-in hand. */
export function abandonHand(h, playerId) {
  const p=h.participants.find(x=>x.id===playerId);
  if (!p || h.finished || p.folded || p.stack===0) return;
  const previousActor=h.actorId;
  p.folded=true; p.lastAction='퇴장 · 폴드'; h.events.push(`${p.name} · 퇴장으로 폴드`);
  h.turnSeq++; progress(h,p.seat,previousActor===playerId?null:previousActor); assertChips(h);
}
function needsAction(h,p) { return !p.folded && p.stack>0 && (p.actedAt===null || p.streetBet<h.currentBet); }
function returnUncalled(h) {
  const sorted=[...h.participants].sort((a,b)=>b.totalBet-a.totalBet);
  const top=sorted[0], second=sorted[1]?.totalBet||0;
  if (top.totalBet>second) {
    const amount=top.totalBet-second;
    top.totalBet-=amount; top.streetBet=Math.max(0,top.streetBet-amount); top.stack+=amount;
    top.allIn=top.stack===0; top.returned+=amount;
    h.refunds.push({id:top.id,name:top.name,amount});
    h.events.push(`${top.name} · 콜되지 않은 ${amount}칩 반환`);
  }
}
function progress(h, afterSeat, preserveActor=null) {
  if (h.finished) return;
  if (live(h).length===1) { settle(h,'folds'); return; }
  const movable=actors(h);
  if (movable.length===1) h.currentBet=Math.max(...live(h).map(p=>p.streetBet));
  // No side-pot betting when all opponents are all-in. The last stack may still owe a call.
  if (movable.length===0 || (movable.length===1 && movable[0].streetBet>=h.currentBet)) {
    h.shown=5; settle(h,'showdown'); return;
  }
  const pending=movable.filter(p=>needsAction(h,p));
  if (pending.length) {
    h.actorId = pending.some(p=>p.id===preserveActor) ? preserveActor : orderedAfter(pending,afterSeat)[0].id;
    return;
  }
  returnUncalled(h);
  if (h.phase==='river') { settle(h,'showdown'); return; }
  h.phase=({private:'flop',flop:'turn',turn:'river'})[h.phase];
  h.shown=({flop:3,turn:4,river:5})[h.phase];
  h.currentBet=0; h.lastFullRaise=h.bb;
  for (const p of h.participants) { p.streetBet=0; p.actedAt=null; if (!p.folded && !p.allIn) p.lastAction=''; }
  h.events.push(`${({flop:'플롭',turn:'턴',river:'리버'})[h.phase]} 공개`);
  progress(h,h.dealerSeat);
}
/** Per-level pots, with folded contributions counted but ineligible to win. */
export function potLayers(h) {
  const levels=[...new Set(h.participants.map(p=>p.totalBet).filter(n=>n>0))].sort((a,b)=>a-b);
  let previous=0;
  return levels.map(level=>{
    const contributors=h.participants.filter(p=>p.totalBet>=level);
    const amount=(level-previous)*contributors.length; previous=level;
    return {amount, cap:level, eligible:contributors.filter(p=>!p.folded).map(p=>p.id), contributorIds:contributors.map(p=>p.id)};
  });
}
function settle(h, ending) {
  returnUncalled(h);
  h.ending=ending;
  const remaining=live(h);
  const evaluated=new Map();
  if (ending==='showdown') {
    h.shown=5;
    for (const p of remaining) evaluated.set(p.id,evaluate([...p.cards,...h.board]));
  }
  const layers=ending==='folds' ? [{amount:potTotal(h),eligible:[remaining[0].id]}] : potLayers(h);
  h.settledPot=potTotal(h);
  for (const layer of layers) {
    if (!layer.amount) continue;
    const eligible=h.participants.filter(p=>layer.eligible.includes(p.id));
    // Can occur only after out-of-turn explicit departures: nobody may win a dead layer.
    // Return that layer to its contributors, not to a short-stack who was never eligible.
    if (!eligible.length) {
      const contributors=h.participants.filter(p=>layer.contributorIds.includes(p.id));
      const each=layer.amount/contributors.length;
      for (const p of contributors) { p.stack+=each; p.returned+=each; h.refunds.push({id:p.id,name:p.name,amount:each,reason:'전원 퇴장한 사이드 팟 반환'}); }
      h.events.push(`승리 자격자가 없는 ${layer.amount}칩을 해당 기여자에게 반환`);
      continue;
    }
    let winners=eligible;
    if (eligible.length>1) {
      const best=eligible.map(p=>evaluated.get(p.id)).sort((a,b)=>compareScores(b.score,a.score))[0];
      winners=eligible.filter(p=>compareScores(evaluated.get(p.id).score,best.score)===0);
    }
    winners=orderedAfter(winners,h.dealerSeat);
    const share=Math.floor(layer.amount/winners.length); let odd=layer.amount%winners.length;
    const awards=winners.map(p=>{ const amount=share+(odd-->0?1:0); p.stack+=amount; p.won+=amount; return {id:p.id,name:p.name,amount}; });
    h.pots.push({amount:layer.amount, eligibleIds:eligible.map(p=>p.id), awards});
  }
  h.results=h.participants.map(p=>{
    const show=ending==='showdown'&&!p.folded, e=evaluated.get(p.id);
    return {id:p.id,name:p.name,cards:show?[...p.cards]:[],bestCards:show?[...e.bestCards]:[],
      score:show?[...e.score]:[],handName:p.folded?'폴드':show?e.name:'다른 참가자 폴드로 승리',folded:p.folded,
      winner:p.won>0, won:p.won, returned:p.returned, net:p.stack-p.startStack, stack:p.stack,
      sharedWin:h.pots.some(pot=>pot.awards.length>1&&pot.awards.some(a=>a.id===p.id))};
  }).sort((a,b)=>Number(b.winner)-Number(a.winner)||b.won-a.won);
  h.finished=true; h.phase='showdown'; h.actorId=null; h.currentBet=0;
  h.events.push(`핸드 종료 · ${h.results.filter(r=>r.winner).map(r=>`${r.name} ${r.won}칩`).join(' / ')}`);
  assertChips(h);
}
