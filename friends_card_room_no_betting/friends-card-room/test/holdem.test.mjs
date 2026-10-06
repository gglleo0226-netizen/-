import test from 'node:test';
import assert from 'node:assert/strict';
import { createHand, actHand, abandonHand, legalActions, assertChips, potTotal } from '../lib/holdem.mjs';
import { GameStore } from '../lib/game.mjs';
const deck=Array.from({length:52},(_,i)=>i);
const players=stacks=>stacks.map((stack,i)=>({id:`P${i}`,name:`친구${i}`,seat:i,stack}));
const hand=(stacks=[1000,1000,1000],options={})=>createHand(players(stacks),{dealerSeat:0,sb:5,bb:10,deck,...options});
const move=(h,action,amount)=>actHand(h,h.actorId,action,amount);
function passive(h) {let n=0;while(!h.finished&&n++<100) {const a=legalActions(h,h.actorId);move(h,a.check?'check':'call');}assert.ok(h.finished);}
function royal(h) {h.board=[8,9,10,11,12];h.participants.forEach((p,i)=>p.cards=[13+i*2,14+i*2]);}
function postflop(stacks=[1000,1000,1000]) {const h=hand(stacks);let n=0;while(h.phase==='private'&&n++<20){const a=legalActions(h,h.actorId);move(h,a.check?'check':'call');}assert.equal(h.phase,'flop');return h;}

test('holdem: 2–9 players post blinds, maintain private cards, and conserve chips',()=>{
  for(let n=2;n<=9;n++) {const h=hand(Array(n).fill(1000));assert.equal(potTotal(h),15);assert.equal(new Set([...h.board,...h.participants.flatMap(p=>p.cards)]).size,2*n+5);assertChips(h);}
});
test('holdem: heads-up button is SB, first preflop, last postflop',()=>{
  const h=hand([100,100]);assert.equal(h.sbSeat,0);assert.equal(h.bbSeat,1);assert.equal(h.actorId,'P0');move(h,'call');assert.equal(h.actorId,'P1');move(h,'check');assert.equal(h.phase,'flop');assert.equal(h.actorId,'P1');
});
test('holdem: multiway first actor is left of BB, first postflop left of dealer',()=>{
  const h=hand();assert.equal(h.actorId,'P0');move(h,'call');move(h,'call');assert.equal(h.phase,'private');assert.equal(h.actorId,'P2');move(h,'check');assert.equal(h.actorId,'P1');assert.equal(h.shown,3);
});
test('holdem: BB keeps option after all calls',()=>{const h=hand();move(h,'call');move(h,'call');assert.equal(legalActions(h,'P2').canRaise,true);move(h,'raise',30);assert.equal(h.actorId,'P0');});
test('holdem: rejects out-of-turn, undercalls, overstack, fractional raises',()=>{
  const h=hand();const snapshot=JSON.stringify(h);
  for(const value of [9,11,19,1001,20.5,NaN,'20',Infinity]) assert.throws(()=>actHand(h,'P0','raise',value));
  assert.throws(()=>actHand(h,'P1','fold'));assert.throws(()=>move(h,'check'));assert.equal(JSON.stringify(h),snapshot);
});
test('holdem: raise input is total and next minimum uses increment',()=>{
  const h=hand();move(h,'raise',35);assert.equal(h.participants[0].stack,965);assert.equal(legalActions(h,'P1').minRaiseTo,60);move(h,'raise',60);assert.equal(h.participants[1].stack,940);assert.equal(h.lastFullRaise,25);
});
test('holdem: fold at preflop ends uncontested with cards and future board hidden',()=>{
  const h=hand([100,100]);move(h,'fold');assert.equal(h.phase,'showdown');assert.equal(h.ending,'folds');assert.equal(h.shown,0);assert.deepEqual(h.participants.map(p=>p.stack),[95,105]);assert.equal(h.refunds[0].amount,5);assert.ok(h.results.every(r=>r.cards.length===0));assertChips(h);
});
test('holdem: uncalled all-in excess is returned, not counted as winnings',()=>{
  const h=hand([200,50]);move(h,'allIn');move(h,'call');assert.ok(h.finished);assert.equal(h.settledPot,100);assert.equal(h.refunds.reduce((a,r)=>a+r.amount,0),150);assertChips(h);
});
test('holdem: short BB alone does not force a phantom full-BB call',()=>{
  const h=hand([100,3]);assert.ok(h.finished);assert.equal(h.settledPot,6);assert.equal(h.refunds[0].amount,2);assertChips(h);
});
test('holdem: short BB with several stacks still requires the full nominal BB',()=>{
  const h=hand([100,100,3]);assert.equal(legalActions(h,'P0').callAmount,10);move(h,'call');assert.equal(legalActions(h,'P1').callAmount,5);passive(h);assertChips(h);
});
test('holdem: both blinds can be all-in at creation',()=>{const h=hand([3,4]);assert.ok(h.finished);assert.equal(h.shown,5);assert.equal(h.settledPot,6);assertChips(h);});
test('holdem: short all-in call never creates a negative stack',()=>{const h=hand([200,17,200]);move(h,'raise',100);move(h,'call');assert.equal(h.participants[1].stack,0);assert.equal(h.participants[1].totalBet,17);move(h,'call');passive(h);assertChips(h);});
test('holdem: single short all-in does not reopen a prior raiser',()=>{
  const h=hand([1000,35,1000]);move(h,'raise',30);move(h,'allIn');move(h,'call');const a=legalActions(h,'P0');assert.equal(a.callAmount,5);assert.equal(a.canRaise,false);assert.equal(a.allIn,false);assert.throws(()=>move(h,'raise',55));assert.throws(()=>move(h,'allIn'));move(h,'call');passive(h);
});
test('holdem: cumulative short all-ins reopen at a full increment',()=>{
  const h=hand([1000,35,50,1000]); // dealer P0, UTG P3
  move(h,'raise',30); // P3 full raise, increment 20
  move(h,'call'); // P0 calls 30
  move(h,'allIn'); // P1 ->35
  move(h,'allIn'); // P2 ->50
  assert.equal(h.actorId,'P3');assert.equal(legalActions(h,'P3').canRaise,true);assert.equal(legalActions(h,'P3').minRaiseTo,70);move(h,'call');assert.equal(legalActions(h,'P0').canRaise,true);passive(h);
});
test('holdem: later caller does not reopen when facing only a short increment',()=>{
  const h=hand([1000,35,1000,50,1000]); // UTG P3 -> too short for scenario, set stack later safely before bets using fixture below
  const x=postflop([1000,1000,45,1000,60]); // postflop: P1, P2, P3, P4, P0
  move(x,'raise',20);move(x,'allIn'); // P2 remaining35 -> total35
  move(x,'call'); // P3 calls35
  move(x,'allIn'); // P4 remaining50 ->total50
  move(x,'call'); // P0 calls50
  assert.equal(x.actorId,'P1');assert.equal(legalActions(x,'P1').canRaise,true);
  move(x,'call');assert.equal(x.actorId,'P3');assert.equal(legalActions(x,'P3').canRaise,false);passive(x);
});
test('holdem: one remaining stack cannot bet into all-in-only opponents',()=>{
  const h=hand([25,100]);move(h,'allIn');const a=legalActions(h,h.actorId);assert.equal(a.canRaise,false);assert.equal(a.callAmount,15);move(h,'call');assert.ok(h.finished);assert.equal(h.shown,5);
});
test('holdem: unequal all-ins create main and side pots',()=>{
  const h=hand([50,100,200]);move(h,'allIn');move(h,'allIn');move(h,'call');assert.ok(h.finished);assert.deepEqual(h.pots.map(p=>p.amount),[150,100]);assert.deepEqual(h.pots[1].eligibleIds,['P1','P2']);assertChips(h);
});
test('holdem: folded strongest hand cannot win main or side pot',()=>{
  const h=hand();h.board=[0,14,28,42,6];h.participants[0].cards=[12,25];h.participants[1].cards=[2,15];h.participants[2].cards=[3,16];move(h,'fold');passive(h);assert.equal(h.results.find(r=>r.id==='P0').winner,false);assert.deepEqual(h.results.find(r=>r.id==='P0').bestCards,[]);
});
test('holdem: board-only tie splits separately and gives odd chip left of D',()=>{
  const h=hand([100,100,100],{sb:1,bb:3});royal(h);move(h,'call');move(h,'call');move(h,'check');move(h,'fold');passive(h);assert.deepEqual(h.participants.map(p=>p.stack),[101,97,102]);assert.equal(h.pots[0].awards.find(a=>a.id==='P2').amount,5);
});
test('holdem: leaving out of turn preserves current actor',()=>{const h=hand([100,100,100,100]);const actor=h.actorId;abandonHand(h,'P0');assert.equal(h.actorId,actor);assert.equal(h.participants[0].folded,true);passive(h);});
test('holdem: already all-in hand survives explicit leave',()=>{const h=hand([50,100,100]);move(h,'allIn');abandonHand(h,'P0');assert.equal(h.participants[0].folded,false);passive(h);});
test('holdem: street bets reset while total contributions are retained',()=>{const h=postflop();assert.ok(h.participants.every(p=>p.streetBet===0&&p.totalBet===10));assert.equal(h.currentBet,0);assert.equal(legalActions(h,h.actorId).minRaiseTo,10);});
test('holdem: river actions finish exactly once',()=>{const h=hand();passive(h);const s=JSON.stringify(h);assert.throws(()=>actHand(h,'P0','call'));assert.equal(JSON.stringify(h),s);});

let request=0;
function roomFixture(n=3,options={}) {
  let now=100000;const g=new GameStore({now:()=>now});
  const host=g.create({name:'방장',maxPlayers:n,gameType:'holdem',...options});const users=[host];
  const room=g.rooms.get(host.state.roomId);
  const state=(u=host)=>{const a=g.auth(u.token);return g.view(a.room,a.player);};
  const act=(u,action,extra={})=>{const s=state(u);return g.action(u.token,{action,requestId:`holdem_${++request}`,handId:s.handId,phase:s.phase,turnSeq:s.poker?.turnSeq,...extra});};
  for(let i=1;i<n;i++){const u=g.join({room:room.id,invite:room.invite,name:`손님${i}`});users.push(u);act(host,'approve',{playerId:u.state.me.id});}
  function start(){for(const u of users)act(u,'ready',{ready:true});act(host,'start');}
  const actor=()=>users.find(u=>u.state.me.id===room.hand.actorId);
  const finish=()=>{for(let n=0;n<100&&room.phase!=='showdown';n++){const u=actor(),a=state(u).poker.legal;act(u,a.check?'check':'call');}assert.equal(room.phase,'showdown');};
  return {g,room,host,users,state,act,start,actor,finish,step:ms=>now+=ms};
}
test('v2: creation validates stack/blind/clock values atomically',()=>{
  for(const options of [{initialStack:0},{initialStack:'2000'},{sb:0},{sb:21,bb:20},{bb:1.5},{actionSeconds:9},{gameType:'money'}])assert.throws(()=>roomFixture(2,options));
});
test('v2: all non-owner private cards stay secret, including folded results/history',()=>{
  const f=roomFixture();f.start();const u=f.actor(),id=u.state.me.id;f.act(u,'fold');f.finish();
  for(const viewer of f.users){const s=f.state(viewer),p=s.players.find(p=>p.id===id);if(viewer!==u)assert.deepEqual(p.cards,[null,null]);assert.deepEqual(s.results.find(r=>r.id===id).cards,[]);assert.deepEqual(s.history[0].results.find(r=>r.id===id).bestCards,[]);assert.equal(s.poker.legal,null);}
});
test('v2: host cannot force-reveal a betting hand or act for someone else',()=>{
  const f=roomFixture();f.start();assert.throws(()=>f.act(f.host,'advance'));assert.throws(()=>f.act(f.host,'ack'));const u=f.users.find(u=>u!==f.actor());assert.throws(()=>f.act(u,'fold'));assert.equal(f.state().board.length,0);
});
test('v2: stale turns are rejected even within same hand and street',()=>{
  const f=roomFixture();f.start();const u=f.actor(),old=f.state(u);f.act(u,'call');assert.throws(()=>f.act(f.actor(),'call',{turnSeq:old.poker.turnSeq}),/갱신/);
});
test('v2: retrying same request does not spend chips twice',()=>{
  const f=roomFixture();f.start();const u=f.actor(),s=f.state(u);const extra={requestId:'stable_retry',turnSeq:s.poker.turnSeq,phase:s.phase,handId:s.handId};f.act(u,'call',extra);const snapshot=JSON.stringify(f.room.hand);f.act(u,'call',extra);assert.equal(JSON.stringify(f.room.hand),snapshot);
});
test('v2: turn timeout auto-folds facing chips and marks sit-out',()=>{
  const f=roomFixture(3,{actionSeconds:10});f.start();const id=f.actor().state.me.id;f.step(10001);f.g.tick();assert.equal(f.room.hand.participants.find(p=>p.id===id).folded,true);assert.equal(f.room.players.find(p=>p.id===id).sitOut,true);
});
test('v2: turn timeout auto-checks when free',()=>{
  const f=roomFixture(3,{actionSeconds:10});f.start();f.act(f.actor(),'call');f.act(f.actor(),'call');const id=f.actor().state.me.id;f.step(10001);f.g.tick();assert.equal(f.room.hand.participants.find(p=>p.id===id).folded,false);assert.equal(f.room.phase,'flop');
});
test('v2: pause freezes turn clock and rejects actions while paused',()=>{
  const f=roomFixture(3,{actionSeconds:30});f.start();f.step(5000);f.act(f.host,'pause',{paused:true});assert.equal(f.state(f.actor()).poker.legal,null);assert.throws(()=>f.act(f.actor(),'fold'),/일시정지/);f.step(10000);f.g.tick();f.act(f.host,'pause',{paused:false});assert.equal(f.room.deadline,140000);
});
test('v2: chip reset prohibited during hand; free reset after hand clears readiness',()=>{
  const f=roomFixture();f.start();assert.throws(()=>f.act(f.host,'resetStacks'));f.finish();f.act(f.host,'settings',{mode:'ready',seconds:10,initialStack:3000,sb:20,bb:40,actionSeconds:60});f.act(f.host,'resetStacks');assert.equal(f.room.phase,'lobby');assert.equal(f.room.hand,null);assert.ok(f.state().players.every(p=>p.stack===3000&&!p.ready));assert.equal(f.state().history.length,1);
});
test('v2: setting initial stack alone never overwrites existing balances',()=>{
  const f=roomFixture();const stacks=f.state().players.map(p=>p.stack);f.act(f.host,'settings',{mode:'ready',seconds:10,initialStack:4000});assert.deepEqual(f.state().players.map(p=>p.stack),stacks);
});
test('v2: invalid settings leave room unchanged',()=>{
  const f=roomFixture();assert.throws(()=>f.act(f.host,'settings',{mode:'ready',seconds:10,initialStack:4000,sb:100,bb:10}));assert.equal(f.room.initialStack,2000);assert.equal(f.room.sb,10);
});
test('v2: late join spectates until next hand and cannot act',()=>{
  const f=roomFixture(2);f.start();f.room.maxPlayers=3;const u=f.g.join({room:f.room.id,invite:f.room.invite,name:'늦은친구'});f.act(f.host,'approve',{playerId:u.state.me.id});const s=f.state(u);assert.equal(s.poker.legal,null);assert.deepEqual(s.players.find(p=>p.id===u.state.me.id).cards,[]);assert.throws(()=>f.act(u,'fold'));f.finish();
});
test('v2: chip auto-next waits for everyone to ready, no unattended timed stakes',()=>{
  const f=roomFixture(2,{autoNext:true,mode:'timed'});f.start();f.finish();assert.equal(f.room.nextRoundAt,null);f.step(12000);f.g.tick();assert.equal(f.room.phase,'showdown');f.act(f.users[0],'ready',{ready:true});assert.equal(f.room.phase,'showdown');f.act(f.users[1],'ready',{ready:true});assert.equal(f.room.round,2);
});
test('v2: compare mode also supports fold, hides it, and ends at one survivor',()=>{
  const f=roomFixture(2,{gameType:'compare'});f.start();f.act(f.users[0],'fold');const s=f.state(f.users[1]);assert.equal(s.phase,'showdown');assert.equal(s.board.length,0);assert.equal(s.results.filter(r=>r.winner).length,1);assert.ok(s.results.every(r=>r.cards.length===0));assert.deepEqual(s.players.find(p=>p.id===f.users[0].state.me.id).cards,[null,null]);
});
test('v2: compare folded participant cannot acknowledge, can join next hand',()=>{
  const f=roomFixture(3,{gameType:'compare'});f.start();f.act(f.users[2],'fold');assert.throws(()=>f.act(f.users[2],'ack'),/폴드/);for(let i=0;i<4;i++){f.act(f.users[0],'ack');f.act(f.users[1],'ack');}assert.equal(f.room.phase,'showdown');f.start();assert.equal(f.state(f.users[2]).players.find(p=>p.id===f.users[2].state.me.id).folded,false);
});
test('v2: pending members never receive chip balances or turn metadata',()=>{
  const f=roomFixture(2);f.room.maxPlayers=3;const u=f.g.join({room:f.room.id,invite:f.room.invite,name:'대기'});for(const k of ['players','poker','sb','history','board'])assert.equal(u.state[k],undefined);
});
test('v2: zero stack players are excluded until free reset',()=>{
  const f=roomFixture(3);f.room.players[2].stack=0;assert.throws(()=>f.act(f.users[2],'ready',{ready:true}),/스택/);f.act(f.users[0],'ready',{ready:true});f.act(f.users[1],'ready',{ready:true});f.act(f.host,'start');assert.equal(f.room.hand.participants.length,2);f.finish();f.act(f.host,'resetStacks');assert.equal(f.room.players[2].stack,2000);
});
test('v2: 2–9 user seeded fuzz, 1000 random hands terminate and conserve chips',()=>{
  let seed=749153;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let i=0;i<1000;i++) {
    const n=2+random(8),h=hand(Array.from({length:n},()=>1+random(1000)),{sb:1+random(20),bb:40});
    let count=0;
    while(!h.finished&&count++<500){const a=legalActions(h,h.actorId);const choices=['fold',a.check?'check':'call'];if(a.allIn)choices.push('allIn');if(a.canFullRaise)choices.push('raise');const action=choices[random(choices.length)];move(h,action,action==='raise'?a.minRaiseTo+random(a.maxTotal-a.minRaiseTo+1):undefined);assertChips(h);}
    assert.ok(h.finished,`hand ${i} stuck`);assert.ok(h.participants.every(p=>p.stack>=0));
    assert.equal(h.results.reduce((s,r)=>s+r.net,0),0);
  }
});

test('holdem: strongest short stack wins only main pot, next hand wins side pot',()=>{
  const h=hand([50,100,200]);h.board=[0,14,28,42,6];h.participants[0].cards=[12,25];h.participants[1].cards=[11,24];h.participants[2].cards=[10,23];
  move(h,'allIn');move(h,'allIn');move(h,'call');assert.deepEqual(h.participants.map(p=>p.stack),[150,100,100]);assert.equal(h.pots[0].awards[0].id,'P0');assert.equal(h.pots[1].awards[0].id,'P1');
});
