# Parallel MCTS investigation

Baseline: `85952dc990a43755f17b3d728fb1d470bc21e2c5`, the last committed parallel MCTS with hidden-card sampling. Both comparison agents use that commit's MCTS tree and game engine. The updated agent overlays either full-state access alone or full-state access plus voluntary replenishment. The unfinished workspace subtree-reuse refactor is excluded.

## Recorded session

Session: `sessions/2026-10-04-07-33-23-3ab2c52408d2f1da.jsonl`. Turn numbers below are zero-based.

| Turn | Recorded take | Alternatives |
| --- | --- | --- |
| 19 | One token | Ordinary takes only have single tokens; replenishment enables a three-token take. |
| 30 | One token | Ordinary takes only have single tokens; replenishment enables a three-token take. |
| 47 | White at cell 6 | Ordinary `[2,6]` takes black and white; `[2,3,4]` takes three tokens. |
| 61 | Red at cell 14 | Ordinary `[2,3]` takes two tokens. |

Replenishment enables a three-token take in all four positions. Taking the most tokens is not necessarily the strongest move, but the original MCTS did not search voluntary replenishment at all. A 20-second replay still selected a single token, so this behavior is not explained solely by a short timeout. The engine and simulation agreed on 2,180 candidate transitions checked during the initial diagnosis.

The original parallel search samples one hidden world per worker and keeps it for that search. Eight workers therefore search only eight sampled deck configurations. Altering the sampled configurations changed a selected move's estimated reward at turn 47 from 38.5% to 27.1%. Full-state access removes this source of uncertainty. Different rollout policies, search depths, and actual intervening moves can still change the displayed estimate.

## Frequent replenishment

Voluntary replenishment is now a separate branch, including replenishment before privilege spending. The simulation grants the opponent a privilege exactly as the engine does, including privilege transfer when the global cap is reached. Tests compare generated moves and resulting states against the engine and cover an immediate win requiring replenishment.

The rollout policy subtracts only `0.01` from a replenishment move's immediate score. An ordinary gem adds `1.5`, and a pearl adds `8`. Selection also adds independent random noise in `[0,4)`, easily overwhelming the refill penalty even for nearly equivalent actions. This policy therefore often prefers a fuller board without directly pricing the opponent's privilege or the tokens left for their next turn. The engine applies those consequences, but a weak rollout policy can still distort MCTS values. Extra branches also reduce search throughput.

A selective policy is plausible, but removing replenishment from legal search branches can exclude winning combinations. A better first experiment is to price its consequences in rollout selection or use a lower expansion priority, while keeping the option available. Candidate triggers for a later selective experiment include replenishment enabling an immediate purchase or win, useful privilege spending, or a materially better token take. The present implementation has no hard filter.

## Match results

Results are from the updated agent's perspective. The four-game rows use the same two seed pairs, with seats swapped. They compare each variant against the original; they are not direct matches between the two updated variants.

| Variant | Budget | Games | Wins–losses–draws | Voluntary refills / moves |
| --- | --- | --- | --- | --- |
| Full state only | 200 ms | 4 | 3–1–0 | 0 / 143 |
| Full state only | 1 s | 4 | 3–1–0 | 0 / 127 |
| Full state only | 5 s | 4 | 4–0–0 | 0 / 152 |
| Full state + refill | 200 ms, matching cohort | 4 | 0–4–0 | 45 / 129 |
| Full state + refill | 200 ms, larger sample | 24 | 8–16–0 | 278 / 796 |
| Full state + refill | 1 s | 4 | 1–3–0 | 35 / 112 |
| Full state + refill | 5 s | 4 | 1–3–0 | 25 / 134 |

Full-state-only throughput was approximately 144k versus 145k original simulations/second at 200 ms, 145k versus 142k at 1 s, and 252k versus 365k at 5 s. Full state plus refill achieved approximately 70k versus 172k at 200 ms (24 games), 57k versus 161k at 1 s, and 70k versus 167k at 5 s. Different game trajectories affect these aggregates, especially terminal rollouts that are very cheap; fixed-position refill probes also showed lower throughput, approximately 30–56% of the original at 5 s.

The preliminary evidence favors full-state access and revisiting the refill rollout policy. Simply increasing the timeout did not make the refill-enabled version outperform the original in this pilot. Every completed comparison had zero search or move-application errors. The full-state-only files contain 845 per-move predictions in total, and all three budgets used identical source fingerprints.

Raw records:

- [Full state only, 200 ms](go-full-state-vs-original-200ms-2026-10-04.jsonl)
- [Full state only, 1 s](go-full-state-vs-original-1000ms-2026-10-04.jsonl)
- [Full state only, 5 s](go-full-state-vs-original-5000ms-2026-10-04.jsonl)
- [Full state + refill, 200 ms](go-replenishment-cached-vs-original-200ms-2026-10-04.jsonl)
- [Full state + refill, 1 s](go-replenishment-cached-vs-original-1000ms-2026-10-04.jsonl)
- [Full state + refill, 5 s](go-replenishment-cached-vs-original-5000ms-2026-10-04.jsonl)

## Output and validation

New session move events carry `search: {simulations, moveSimulations, winRate}`. Human and non-MCTS moves omit it; older session records remain replayable. Comparison output additionally records each move's agent, seat, searched turn, move, seed, game index, and elapsed search time. Per-move prediction logging was added before the full-state-only batch; earlier refill match records have predictions for the fixed-position probes only.

`winRate` is the selected move's mean rollout reward from the acting player's perspective. Wins score 1, draws 0.5, and unfinished rollouts use a heuristic evaluation. It is not a calibrated probability, and it should not be confused with the fraction of completed comparison games won. `moveSimulations` identifies how much evidence supports that selected move.

Full state does not eliminate jumps between turns. In the 1-second full-state-only file, game 0's updated agent predicted 31.5% for `take [7,8]` at turn 55 and 82.0% for a reserved-card purchase at turn 58, after the opponent made two purchases (an extra turn). These are different positions and decisions. Repeated searches of an unchanged probe position were much steadier: turn 47's full-state estimates were 21.5–21.8% at 200 ms and 19.6–19.7% at 1 s. Neither observation establishes calibration.

Isolated full-state and replenishment search packages passed race-enabled tests. Session record tests passed. At the time of these comparisons, the workspace search/HTTP compile check was blocked by the unrelated unfinished subtree-reuse refactor (`position` signature mismatch, missing `tree.index`, and missing `parallelMCTS`). The isolated benchmark uses the coherent committed tree implementation instead.

## Reproduction

Run from the repository root:

```sh
python3 experiments/search/compare-replenishment.py --variant full-state --check --games 4 --time-ms 200 --workers 8 --probe-session sessions/2026-10-04-07-33-23-3ab2c52408d2f1da.jsonl
```

Use `--time-ms 1000` or `5000` for the longer budgets, and `--variant refill` for full state plus replenishment. Each file begins with the baseline commit, variant, and kernel SHA-256 fingerprints. Matches run serially with eight workers and `GOMAXPROCS=8`, identical initial seeds in seat-swapped pairs, a shared wall-clock limit per move, and a 180-turn cap. Four games cover two seeds, so these are exploratory comparisons rather than reliable estimates of playing strength. Timing-based search is not bit-for-bit reproducible.

## Follow-up implementation

The integrated MCTS now uses full state, with voluntary replenishment disabled by default. API configs enable it with `includeRefill: true`, and CLI specs with `mcts/8+refill@1000`. Forced replenishment remains enabled. The previously unfinished session integration has been repaired; retained trees validate the full state and policy before reuse. These historical comparisons still exclude subtree reuse. The harness explicitly selects the refill flag for new refill-variant runs.
