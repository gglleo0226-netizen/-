// All C(52,5)=2,598,960 five-card hands, with independently known combinatorial counts.
import assert from 'node:assert/strict';
import { score5 } from '../lib/cards.mjs';
const counts = Array(9).fill(0);
const start = Date.now();
for (let a = 0; a < 48; a++) for (let b = a + 1; b < 49; b++)
  for (let c = b + 1; c < 50; c++) for (let d = c + 1; d < 51; d++)
    for (let e = d + 1; e < 52; e++) counts[score5([a,b,c,d,e])[0]]++;
const expected = [1302540,1098240,123552,54912,10200,5108,3744,624,40];
assert.deepEqual(counts, expected);
console.log(JSON.stringify({ total: counts.reduce((a,b)=>a+b,0), counts, elapsedMs: Date.now()-start, passed:true }, null, 2));
