# Go MCTS optimization ideas

These are candidate experiments, not implementation commitments. Evaluate
playing strength at equal time budgets; more simulations alone do not imply
better decisions. Keep each experiment isolated from other changes.

| Idea | Why it might help | Main tradeoff |
| --- | --- | --- |
| Improve rollout purchasing and discarding | Avoid observed stalled continuations and make simulated play more realistic | A smarter policy costs more per rollout |
| Progressive widening | Initially explore a few actions, then introduce more as visits accumulate, even after current action pruning | Good moves introduced late may receive too little search |
| Allocate nodes and edges in blocks | Reduce allocation and garbage-collection overhead as trees grow | More complicated memory management |
| Detect immediate opponent threats | Resolve urgent defensive situations before relying on long rollouts | Defense checks must include reservation, stealing, and extra turns |
| Merge equivalent resulting states | Share information when different action sequences reach the same position | Correct state identity and visit accounting are difficult |
| Tune exploration to the new action policy | The current UCT constant may no longer be a good fit after pruning | Requires independent validation to avoid overfitting |
| Tune parallel worker count | Balance additional rollouts against duplicated exploration in independent trees | The best count may depend on time budget and position |

## Suggested priorities

1. **Investigate rollout policy quality.** Replay the captured stalled leaves
   and identify unproductive acquisition/discard sequences. Test controlled
   policy changes without simultaneously changing leaf scoring or rollout caps.
2. **Profile allocation costs.** Establish whether node/edge allocation and
   garbage collection materially limit throughput before changing memory
   management. Preserve search decisions in deterministic comparisons.
3. **Try progressive widening.** Concentrate early search effort on promising
   actions while allowing unusual moves to enter as evidence accumulates.
   Widening the already-pruned move set cannot restore removed actions; testing
   a broader candidate pool would be a separate change.
4. **Evaluate tactical checks, state sharing, exploration tuning, and worker
   counts** as separate experiments after the first three investigations.

## Evidence and evaluation

- Natural capped rollouts were rare, but captured cap leaves repeatedly failed
  to reach a terminal state under the existing rollout policy. This supports
  investigating stalled behavior, not assuming the positions are unwinnable.
- Averaged rollout batches of 2 and 4 did not improve the recent pruned-baseline
  pilot. They increased raw-rollout throughput while reducing tree traversals.
  Keep the single-rollout default unless another independently tested variant
  supports a change.
- Static priors and exploration tuning in earlier TS experiments did not show
  benefits for those configurations. New proposals need fresh evidence rather
  than assuming that more heuristic guidance helps.

For each idea, freeze the baseline, state one hypothesis, record raw results,
and compare paired game seeds with seats swapped. Use fixed-work comparisons
where appropriate to understand the mechanism, then equal-time matches to
evaluate practical strength. Record legality, latency, throughput, memory,
and relevant search statistics. Confirm promising candidates on independent
seeds before changing defaults; label small or inconclusive samples explicitly.

Related reports:

- [Leaf evaluation experiment](experiments/search/leaf-evaluation/report.md)
- [Averaged rollout batches](experiments/search/rollout-batches/report.md)
