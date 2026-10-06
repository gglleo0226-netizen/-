import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, score5, shuffledDeck, compareScores } from '../lib/cards.mjs';
export function parse(s) {
  return s.split(/\s+/).map(c => {
    const suit = 'shdc'.indexOf(c.slice(-1));
    const rank = ({ T: 10, J: 11, Q: 12, K: 13, A: 14 })[c.slice(0, -1)] || Number(c.slice(0, -1));
    return suit * 13 + rank - 2;
  });
}
const hands = [
  ['As Jd 9h 6c 2s', [0, 14, 11, 9, 6, 2]],
  ['As Ad Jh 6c 2s', [1, 14, 11, 6, 2]],
  ['As Ad Jh Jc 2s', [2, 14, 11, 2]],
  ['As Ad Ah 6c 2s', [3, 14, 6, 2]],
  ['As 2d 3h 4c 5s', [4, 5]],
  ['As Js 9s 6s 2s', [5, 14, 11, 9, 6, 2]],
  ['As Ad Ah 6c 6s', [6, 14, 6]],
  ['As Ad Ah Ac 6s', [7, 14, 6]],
  ['9s Ts Js Qs Ks', [8, 13]]
];
for (const [cards, score] of hands) test(`five-card score: ${cards}`, () => assert.deepEqual(score5(parse(cards)), score));
test('royal flush named correctly', () => assert.equal(evaluate(parse('As Ks Qs Js Ts 2h 3d')).name, '로열 스트레이트 플러시'));
test('two trips form the higher full house', () => assert.deepEqual(evaluate(parse('As Ad Ah Kc Ks Kh 2s')).score, [6, 14, 13]));
test('three pairs use the highest two pairs and best kicker', () => assert.deepEqual(evaluate(parse('As Ad Kh Kc Qs Qd Jh')).score, [2, 14, 13, 12]));
test('can use only the five community cards', () => assert.deepEqual(evaluate(parse('2h 3d Ts Js Qs Ks As')).score, [8, 14]));
test('wheel loses to six-high straight', () => assert.equal(compareScores(evaluate(parse('As 2h 3d 4c 5s')).score, evaluate(parse('2s 3h 4d 5c 6s')).score), -1));
test('not a wraparound straight', () => assert.equal(evaluate(parse('Qs Kh Ad 2c 3s')).score[0], 0));
test('suits never break an otherwise tied hand', () => assert.equal(compareScores(evaluate(parse('As Ks Qs 9s 6s')).score, evaluate(parse('Ah Kh Qh 9h 6h')).score), 0));
test('pair uses all three kickers', () => assert.equal(compareScores(evaluate(parse('As Ad Kh Qh 9h')).score, evaluate(parse('Ah Ac Ks Qs 8s')).score), 1));
test('invalid or duplicate cards rejected', () => {
  for (const cards of [[0, 0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3, 99], [0, 1, 2, 3, 2.5]]) assert.throws(() => evaluate(cards));
});
test('shuffle contains exactly each card once', () => {
  for (let i = 0; i < 100; i++) assert.deepEqual([...shuffledDeck()].sort((a, b) => a - b), Array.from({ length: 52 }, (_, n) => n));
});
test('best hand comparison is invariant under input ordering', () => {
  for (let i = 0; i < 150; i++) {
    const cards = shuffledDeck().slice(0, 7);
    assert.deepEqual(evaluate(cards).score, evaluate([...cards].reverse()).score);
  }
});
