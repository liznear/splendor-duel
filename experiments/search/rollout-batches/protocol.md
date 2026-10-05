# Averaged rollout batches: archived experiment protocol

Compare batch sizes 2 and 4 with current single-rollout MCTS. Every batch
starts from the same tree leaf, consumes consecutive draws from the existing
worker RNG, and backpropagates the arithmetic mean. A complete batch counts
as one tree traversal/visit; partial deadline-interrupted batches are discarded.
UCT remains 1.4. No maximum reward selection or reward reweighting is used.

The candidate was test-only; its implementation and harness have been removed
after rejection. Batch 1 was checked against production root statistics and
subsequent RNG state under deterministic cancellation.
All variants use fresh single-worker trees, full server state, the existing
160-action rollout policy, unchanged immediate-win shortcut, optional early
refill followed the frozen baseline, and legal mandatory refill behavior was
preserved. Reuse and parallel-worker interactions were outside this experiment.

## Predetermined pilot runs

1. Seven replayable positions: saved single-token position plus turns 0/24/48
   from seeds 72001 and 72002, generated with fixed-budget baseline self-play.
   Each variant runs three RNG seeds at 2048 total rollouts, 200ms, and 1s.
2. Equal-rollout matches: 1024 total rollouts per searched action, six initial
   seed pairs per candidate, first seed 73001, spacing 7919, seats swapped.
   Batch 2 gets 512 traversals; batch 4 gets 256; baseline gets 1024.
3. Equal-time screening matches: 200ms, same six paired seeds per candidate.
4. Longer-budget check: 1s, three fresh seed pairs per candidate, first seed
   83001, spacing 7919. Run both candidates irrespective of screening score.

One match runs at a time. First player is always seat 0. Search RNG is
PCG(turn*100+3, turn*100+74) for both variants. Stop a game at 600 actions;
record nonterminal limits separately as a match draw, never as an engine rule.

Record moves, seed, seat, budget, winner/draw, turns, elapsed time, completed
raw rollouts, tree traversals, and attempted rollouts (including discarded
partial batches). The manifest freezes source/binary hashes and environment.

Report wins/losses/draws, draw-inclusive score, and seed-paired bootstrap 95%
intervals. With only 3 or 6 pairs these intervals are exploratory, not strong
evidence. Fixed-rollout matches isolate allocation of rollout samples, not
equal computation: tree depth and rollout length may also differ. Equal-time
matches are the practical comparison. Simulation counts must distinguish raw
rollouts from tree visits; extra turns can change per-seat totals.

Keep production batch 1 after this pilot unless a later, larger independent
confirmation supports promotion. Report all predetermined outcomes; do not
stop after a favorable score or choose only successful seeds.

## Retained evidence

Completed match and position results, summaries, and manifests are retained
in the baseline subdirectories. Console logs, the interrupted trial, and the
rejected Go harness/runner were removed during cleanup. This document records
the historical protocol; it does not provide an executable rerun command.

## Rerun after action-policy changes

The original commit 62dfba4 results are archived in `baseline-62dfba4/`.
Its 1s matches were interrupted after three games when the user requested a
comparison against the new action policy. That incomplete trial was excluded
and its output discarded during cleanup.

All four predetermined stages were rerun on commit ce31a91, with results in
`pruned-ce31a91/`. The new default prunes smaller token takes when
a maximum-size take without a privilege penalty exists, and enables
conditional early replenishment. These policies apply equally to batch 1,
2, and 4, in both tree expansion and rollouts. Match budgets/seeds/pair counts
remain unchanged. Production's updated root fallback is mirrored as well.
