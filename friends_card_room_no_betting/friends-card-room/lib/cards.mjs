import { randomInt } from 'node:crypto';

export const HAND_NAMES = [
  '하이 카드', '원 페어', '투 페어', '트리플', '스트레이트',
  '플러시', '풀 하우스', '포 카드', '스트레이트 플러시'
];
export const rank = card => card % 13 + 2;
export const suit = card => Math.floor(card / 13);

/** A uniformly shuffled 52-card deck. No Math.random() or client-selected cards. */
export function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; --i) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** Five-card score in lexicographically comparable form: category, tiebreakers. */
export function score5(cards) {
  const rs = cards.map(rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => suit(c) === suit(cards[0]));
  const straight = counts.size === 5
    ? (rs[0] - rs[4] === 4 ? rs[0] : rs.join(',') === '14,5,4,3,2' ? 5 : 0)
    : 0;
  if (flush && straight) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...rs];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map(g => g[0])];
  return [0, ...rs];
}

/** Best five of 5–7 distinct cards. Hole cards may be used zero, one or two times. */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7 ||
      new Set(cards).size !== cards.length ||
      cards.some(c => !Number.isInteger(c) || c < 0 || c > 51)) {
    throw new Error('서로 다른 5~7장의 카드가 필요합니다.');
  }
  let best = null, bestCards = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++)
    for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++)
      for (let e = d + 1; e < n; e++) {
        const chosen = [cards[a], cards[b], cards[c], cards[d], cards[e]];
        const score = score5(chosen);
        if (!best || compareScores(score, best) > 0) { best = score; bestCards = chosen; }
      }
  return {
    score: best,
    name: best[0] === 8 && best[1] === 14 ? '로열 스트레이트 플러시' : HAND_NAMES[best[0]],
    bestCards: bestCards.sort((a, b) => rank(b) - rank(a) || suit(a) - suit(b))
  };
}
