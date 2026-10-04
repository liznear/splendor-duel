// Regenerate migration fixtures with the original rules, independently of Go.
import { createGame, applyMove, applyOption, applyReplenish, legalMoves, mulberry32Step, type Move } from '../src/engine/game';
import { greedyAgent } from '../src/agents/greedy';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, sorted(value[k])]));
  return value;
}
function fingerprint(state: any) { const { log, ...rest } = state; return createHash('sha256').update(JSON.stringify(sorted(rest))).digest('hex'); }
const fixtures = [];
for (let seed = 0; seed < 20; seed++) {
  const firstSeat = seed % 2;
  let state = createGame({ seed, names: ['A', 'B'], firstSeat: firstSeat as 0 | 1 });
  const rng = { rngState: seed + 113 };
  const random = () => mulberry32Step(rng);
  const events: any[] = [];
  const initial = fingerprint(state);
  for (let step = 0; step < 150 && state.winner === null && !state.draw; step++) {
    let lm = legalMoves(state);
    if (lm.mustReplenish) {
      if (!lm.canReplenish) break;
      state = applyReplenish(state);
      events.push({ t: 'replenish', expected: fingerprint(state) });
      lm = legalMoves(state);
    }
    // Exercise separately committed privileges and voluntary replenishment.
    if (state.players[state.current].privileges > 0 && lm.privilegeCells.length && random() < .15) {
      const privileges = [lm.privilegeCells[Math.floor(random() * lm.privilegeCells.length)]!];
      state = applyOption(state, { privileges });
      events.push({ t: 'option', privileges, expected: fingerprint(state) });
      lm = legalMoves(state);
    }
    if (!lm.actions.length) continue;
    let move: Move;
    if (seed < 10) {
      // Control tie noise so regeneration is repeatable.
      const old = Math.random; Math.random = random;
      move = await greedyAgent().chooseMove({ seat: state.current, view: state, legal: lm, turn: state.turnCount });
      Math.random = old;
    } else {
      move = { action: lm.actions[Math.floor(random() * lm.actions.length)]! };
      if (state.players[state.current].privileges && random() < .5) {
        const used = move.action.kind === 'take' ? move.action.cells : move.action.kind === 'reserve' ? [move.action.goldCell] : [];
        const available = lm.privilegeCells.filter(c => !used.includes(c));
        if (available.length) move.privileges = [available[Math.floor(random() * available.length)]!];
      }
      if (lm.canReplenish && random() < .15) move.replenish = true;
    }
    state = applyMove(state, move);
    events.push({ t: 'move', move, expected: fingerprint(state) });
  }
  fixtures.push({ seed, firstSeat, initial, events });
}
mkdirSync('internal/game/testdata', { recursive: true });
writeFileSync('internal/game/testdata/typescript-traces.json', JSON.stringify(fixtures) + '\n');
console.log(`Generated ${fixtures.length} games, ${fixtures.reduce((n, f) => n + f.events.length, 0)} transitions`);
