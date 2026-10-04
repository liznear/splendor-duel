# Parallel alpha-beta benchmark

Implemented `ab/8@1000` / `par-ab@1000`, with eight root workers, the same evaluation and pruning within each branch, stable tie-breaking, and the original maximum depth of four. The original serial search was unchanged during the benchmark runs. Before committing, the serial and parallel variants were refactored to share the iterative-deepening driver and root-value helper; the one-worker path runs directly without a goroutine pool. An iteration replaces the previous result only when all root branches complete.

## One-second head-to-head

Six games on seeds 1000, 8919, and 16838, swapping seats on each seed. One match ran at a time. The parallel agent had eight workers; the serial agent had one. Both had a one-second wall-clock budget per move.

| Agent | Wins | Losses | Draws |
| --- | ---: | ---: | ---: |
| Parallel alpha-beta | 1 | 5 | 0 |
| Original alpha-beta | 5 | 1 | 0 |

This small sample does not establish a general strength difference. Increased fixed-depth throughput did not improve the match result.

Raw games: [go-parallel-ab-vs-ab-1000ms-2026-10-04.jsonl](go-parallel-ab-vs-ab-1000ms-2026-10-04.jsonl).

## Fixed-depth throughput and agreement

On the opening position with seed 1095041074, depth two searches returned the same move and score. On an Intel Core Ultra 7 255H, a three-iteration benchmark measured 2.212 seconds for serial versus 0.816 seconds for eight workers (2.7x speedup). A one-iteration repeat measured 2.512 seconds versus 1.113 seconds (2.3x). Both perform the same root searches; scheduling and memory overhead limit scaling.

Tests compare exact root scores and moves at depths 1–4 with 1, 2, 8, and 32 workers, including extra turns, royal milestones, privilege plans, ties, and input immutability. Cancelled searches retain their fallback and workers stop when the parent context is cancelled. Isolated alpha-beta tests pass under the race detector; browser adapter tests also pass.

Three same-position probes with one-second budgets produced identical moves and completed depths: depth one on openings 1000 and 8919, and depth two on the saved turn-14 position. These probes do not identify the cause of the head-to-head losses; differences in completed depth elsewhere, timing, and horizon effects remain possible explanations.

Raw probes: [go-parallel-ab-depth-probes-1000ms-2026-10-04.jsonl](go-parallel-ab-depth-probes-1000ms-2026-10-04.jsonl).

## Reproduction and workspace limitation

```sh
go test ./internal/search -run '^TestParallelAlphaBeta' -race
go test ./internal/search -run '^$' -bench '^BenchmarkAlphaBetaRootDepth$' -benchtime=3x -benchmem
bun test test/api.test.ts
```

For each seed above, run the arena once with `-a ab/8@1000 -baseline ab@1000`, and once with the specs reversed; use `-games 1 -jobs 1 -seed SEED`.

The shared workspace contained an unfinished MCTS refactor during this task. Its compile errors (`position` signature mismatch, missing `tree.index`, and missing `parallelMCTS`) prevented full-package testing and building the normal arena. The games and probes used an isolated executable made from the actual alpha-beta, configuration, evaluation, position, dispatch, and arena sources, with the unused MCTS dispatch branch excluded. Full integration checks, including session serialization, must be rerun when that concurrent work compiles. Temporary sources were removed after verification; production MCTS files were left untouched by this task.

## Five-second follow-up

The same isolated arena executable, seeds, seat swaps, and depth-four limit were used with `ab/8@5000` versus `ab@5000`. Only the per-move budget changed. Six games ran sequentially, with no draws or errors.

| Budget per move | Parallel wins | Serial wins |
| --- | ---: | ---: |
| 1 second | 1 | 5 |
| 5 seconds | 5 | 1 |

At five seconds, parallel alpha-beta won all three games as first player and two of three as second player. This reverses the earlier result on these seeds, but the sample remains small. Completed depths were not recorded for these games, so the result alone does not prove why the longer budget changed the outcomes.

Raw games: [go-parallel-ab-vs-ab-5000ms-2026-10-04.jsonl](go-parallel-ab-vs-ab-5000ms-2026-10-04.jsonl).

## Commit snapshot validation

After sharing the serial and parallel search driver, the AB-only staged snapshot was exported to a clean temporary checkout. `go test ./...`, `go test -race ./...`, `go vet ./...`, and `bun test test/api.test.ts` all passed there, including the session-spec round-trip test. The separate MCTS working-tree edits were excluded from that snapshot and remain uncommitted by this task.
