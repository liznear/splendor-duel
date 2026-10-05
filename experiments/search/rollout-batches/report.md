# Averaged rollout batches in Go MCTS

Decision: keep single-rollout MCTS. Averaging 2 or 4 rollouts per traversal
did not improve play on the pruned baseline in this pilot.

## Implementation and scope

The experiment compares one rollout per tree traversal with batches of 2 and
4. Each continuation starts from the same leaf. The mean reward is propagated
once; one completed batch counts as one visit. Deadline-interrupted batches
contribute no reward or visits. UCT remains 1.4, and the selected root move is
the most visited, with reward sum breaking ties.

Production files and defaults were unchanged. The experimental implementations,
tests, runners, and console logs were removed after both candidates were rejected.
Reports, summaries, manifests, and completed raw results remain for analysis;
rerunning the experiment requires rebuilding a dedicated harness.

Matches use fresh single-worker trees, unchanged rollout policy and 160-action
cap, full server state, the production immediate-win shortcut, and matched
search RNG settings. Reuse and parallel-worker interactions are not tested.
One match runs at a time. Seed pairs share the initial game seed and swap
candidate seats. The written `protocol.md` fixes budgets and sample sizes.

## Updated action-policy baseline

The user requested a rerun after commit `ce31a91` reduced token-take actions
and enabled conditional early replenishment. All three batch variants use
that updated policy in both tree expansion and rollouts. The updated root
fallback is mirrored too.

The exact source/binary hashes, commit and environment are in
`pruned-ce31a91/manifest.json`. Raw results are kept separate from the previous
baseline in `baseline-62dfba4/`. The previous 1s run was interrupted after
three games at the user's request; its incomplete output was discarded during
cleanup and is excluded from comparisons.

For unchanged positions, root actions fell from 58 to 17 in the saved
single-token position, and from 163/168 to 82/84 in the two opening fixtures.
Midgame fixture paths changed under the new policy, so those action counts
cannot be compared directly between commits.

## Results on ce31a91

All scores below are from the batched candidate's perspective against batch 1.

| Budget per searched action | Batch | Wins | Losses | Draws | Seed pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,024 raw rollouts | 2 | 5 | 7 | 0 | 6 |
| 1,024 raw rollouts | 4 | 4 | 8 | 0 | 6 |
| 200ms | 2 | 5 | 7 | 0 | 6 |
| 200ms | 4 | 3 | 9 | 0 | 6 |
| 1s, fresh seeds | 2 | 2 | 4 | 0 | 3 |
| 1s, fresh seeds | 4 | 1 | 5 | 0 | 3 |

Fixed-rollout trials allocate 1,024 traversals to batch 1, 512 to batch 2,
and 256 to batch 4. They isolate allocation of rollout samples, not equal
computation: tree depth, rollout length and tree construction cost can differ.
Immediate-win shortcuts skip search for every variant.

Neither equal-time budget justifies increasing the production batch size.
All 60 updated-baseline games completed with no draws or illegal actions.
The samples are exploratory; seed-paired bootstrap intervals and all raw
counts are recorded in `pruned-ce31a91/summary.json`. The 1s trials contain
only three independent seed pairs per candidate and do not establish a
precise strength difference. No favorable-score early stopping was used.

At 200ms, batch 2 improved from 3 wins/8 losses/1 limit draw in the old
baseline to 5 wins/7 losses on ce31a91; batch 4 remained 3 wins/9 losses.
These are separate within-baseline comparisons and do not isolate which
action-policy change caused any difference.

## Throughput versus tree coverage

Seven positions, three RNG seeds per position, tested at fixed 2,048 raw
rollouts, 200ms and 1s. At 1s the median paired raw-rollout throughput ratio
versus batch 1 was:

| Batch | Raw rollout throughput | Tree traversal throughput |
| --- | ---: | ---: |
| 1 | 1.00x | 1.00x |
| 2 | 1.14x | 0.57x |
| 4 | 1.24x | 0.31x |

Each ratio is computed per matching position/RNG seed before taking the
median. Tree throughput is raw-rollout throughput divided by batch size.
The reduction in tree exploration is measured. It is a plausible contributor
to playing-strength losses, but this experiment does not establish the cause.
Changing UCT or treating each rollout as a separate visit would be different
variants and were not tested.

## Earlier baseline, kept separate

| Budget | Batch 2 | Batch 4 |
| --- | --- | --- |
| 1,024 raw rollouts | 8 wins, 4 losses | 6 wins, 6 losses |
| 200ms | 3 wins, 8 losses, 1 limit draw | 3 wins, 9 losses |

One old-baseline match reached the predefined 600-action limit without an
engine terminal result. It is counted as a match draw, not a game-rule draw.
Do not pool these games with ce31a91: both move filtering and replenishment
policy changed. Timing-based matches are also sensitive to machine load.

## Validation and reproduction

Passed: exact batch-1 comparison with production root statistics and RNG state
on three seeds; arithmetic-mean and interrupted-batch tests; visit/reward
accounting and input-mutation checks; `go test ./...`; focused batch tests
under the race detector; Go formatting; Python runner syntax check.

All completed matches produced legal engine actions. No production change or
commit has been made. Historical experiment parameters are in `protocol.md`.
Completed old results remain archived; the interrupted 1s trial was discarded.

The next production decision is to retain batch 1. Adaptive batching, UCT
retuning, different visit accounting, subtree reuse, and parallel workers
would require separate experiments; none is implied by this result.
