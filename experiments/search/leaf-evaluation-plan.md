# Go MCTS leaf evaluation improvement plan

Status: first milestone completed; candidates rejected and later work deferred.
See [results](leaf-evaluation/report.md). The experimental harness was removed
during cleanup; this plan remains a record of the proposed work. No production
bot behavior changed.

## Goal and scope

Improve decisions made from nonterminal rollout leaves by evaluating winning
progress, tempo, useful discounts, flexibility, denial, and tactical threats.
The success criterion is stronger play at the same time budget, not a more
elaborate formula or a higher simulation count.

Start with leaf evaluation only. Keep rollout move selection, UCT, tree reuse,
worker count, move generation, information available to the bot, and the
160-action rollout limit unchanged. Changes to rollout policy or cutoff length
are separate experiments after this evaluator has been assessed.

## Current behavior and prior evidence

- `internal/search/sim.go`: `simRollout` returns 1 for a win, 0 for a loss,
  and 0.5 for a draw. A nonterminal leaf uses
  `0.5 + 0.45*tanh((playerValue(me)-playerValue(opponent))/600)`.
- `playerValue` uses fixed weights for points, crowns, maximum single-color
  points, discounts, tokens, privileges, reserved cards, and affordable cards.
- A rollout stops after at most 160 actions. `internal/search/mcts.go` discards
  its result if the search context has expired; changing the leaf evaluator
  alone therefore does not recover deadline-interrupted simulations.
- The TS experiments in `experiments/search/README.md`, R2/R3, reported poor
  results when rollouts were shortened to 6/12/24 actions with the old static
  evaluator. These are warnings about that combination, not proof that a new
  Go evaluator cannot work.

First question: how often does the current Go bot actually backpropagate a
nonterminal leaf? If almost every completed rollout reaches a terminal state,
a leaf-only improvement has little opportunity to help live play.

## Proposed evaluator

Separate feature extraction from scoring. Use a small immutable configuration
for weights, feature normalization, phase interpolation, and reward scale.
Keep the implementation in the compact simulation kernel, with stack scratch
space and no per-card heap allocations. Do not modify `playerValue` in place
if doing so would change another search algorithm or policy.

For player p:

    H(s,p) = sum_i w_i(s) * f_i(s,p)
    D(s,p) = H(s,p) - H(s,1-p)
    reward(s,p) = 0.5 + 0.45*tanh(D(s,p)/T)

Retain exact terminal rewards. Nonterminal rewards remain bounded away from
0 and 1, and are heuristic rewards rather than calibrated win probabilities.
Normalize features into documented ranges before tuning weights; tune T
explicitly because reward scale changes the balance with the existing UCT
exploration term even when UCT itself stays unchanged.

| Feature | First implementation | Later refinement |
| --- | --- | --- |
| WinProgress | Normalize progress toward total points, single-color points, and crowns using engine victory thresholds; emphasize the closest route rather than simply adding three overlapping scores | Estimate the purchases needed to complete each route, including royal rewards |
| Tempo | Best useful affordable purchase and smallest resource deficit for a useful target; account for current player and extra turns | Bounded legal-action search for actionable acquisition time |
| Engine | Marginal discount savings on a small set of worthwhile available/reserved targets, with diminishing returns | Estimate how many times those discounts can be used before the race ends |
| Optionality | Capped number/quality of distinct useful affordable or nearly affordable purchases; contextual gold and privilege utility | Diversity of viable winning routes, and token-cap pressure |
| Denial | Initially zero; avoid treating any resource removal as beneficial | Value only verifiable disruption of an opponent's identified target, accounting for the action spent |
| Threats | Immediate legal winning actions for the player to move; opponent winning opportunities marked as conditional threats | Verify defensive replies and multiple threats with bounded tactical search |

“Useful target” means a card that advances a winning route, gives relevant
discounts, or provides a valuable ability. Limit scans to visible market cards
and the relevant player's reserved cards initially. Preserve the current bot's
information policy; do not add knowledge of future deck order as a feature.
Resource deficit is a proxy, not an exact number of turns: board geometry,
pearls, privileges, gold, replenishment, and forced discards can change the
legal acquisition sequence.

### Phase and tactics

Use continuous phase weights, not turn-number thresholds:

    w_i(s) = opening(s)*w_i_open + middle(s)*w_i_mid + ending(s)*w_i_end

The three nonnegative phase coefficients sum to one. Derive urgency from both
players' closest victory routes and, when available, estimated acquisition
time. Use the same phase coefficients when scoring both players, preserving
perspective symmetry. Smoothly reduce Engine's weight as either player nears
a win; increase WinProgress and Threats. An early crown race can therefore be
treated as an ending despite low total points.

Compare this against fixed weights on the same features. Dynamic weights are
a hypothesis, not a requirement; contextual features may capture most of the
benefit without additional phase parameters.

Terminal checks precede all features. A verified winning action for the player
to move receives a dominant tactical score below the terminal reward. Do not
declare a forced loss solely because the opponent could buy a winning card:
the current player might win first, reserve it, steal a resource, or gain an
extra turn. Reserve forced-loss treatment for a bounded search that verifies
all relevant defenses; otherwise use a strong but finite threat penalty.

## Work packages and evaluation gates

### 1. Establish a reproducible baseline

Freeze the exact source snapshot used for experiments, including relevant
uncommitted MCTS work, and record its diff/hash, binary hash, Go version, CPU,
GOMAXPROCS, worker count, and configuration. All candidates derive from this
snapshot. Keep unrelated active changes out of the comparison.

Add experiment-only rollout diagnostics, accumulated locally per worker and
merged after search rather than updated through shared atomics per action:

- Terminal wins/losses, draws, cap cutoffs, and deadline interruptions.
- Completed/backpropagated simulations separately from retained tree visits.
- Rollout length distribution and fraction of backpropagated heuristic rewards.
- Evaluator time, allocations, simulations per second, search latency, and
  root move visits/reward.

Measure at 200ms, 1s, and 5s on openings, midgames, endings, and the saved
single-token session position. Use 20s for a small diagnostic position sample,
not the initial full-match screening budget. Measure instrumentation overhead.

Gate: if natural cap cutoffs are rare, report the limited impact surface.
Continue evaluator validation offline if useful, but do not claim a likely
leaf-only playing-strength gain or shorten rollouts merely to make it visible.

### 2. Build a position corpus and correctness checks

Collect positions from several baseline matchups, not just one greedy policy.
Include naturally occurring cap leaves and replayable normal game positions.
Stratify by phase, victory route, resource scarcity, and tactical urgency.
Split by whole game seed into development, validation, and untouched final
test sets so neighboring positions cannot leak across splits.

Add targeted fixtures for immediate wins on all three routes, opponent threats
with and without defenses, extra turns, royal acquisition, gold/pearl scarcity,
redundant discounts, and token-cap constraints. Some defenses involve choices
outside default simulated moves; document this coverage limit.

Verify exact terminal rewards, finite bounded nonterminal rewards, no state
mutation, and `reward(s,0)+reward(s,1)=1`. Test phase continuity and meaningful
feature behavior in controlled positions, rather than merely reproducing the
formula in tests. Check tactical outcomes against legal engine moves.

### 3. Implement incremental candidates

| Candidate | Single hypothesis tested |
| --- | --- |
| E0 | Frozen current leaf evaluator |
| E1 | Better victory-route progress and resource-deficit tempo improve ranking |
| E2 | Verified immediate wins and conditional opponent threats fix tactical blind spots |
| E3 | Target-aware Engine and capped Optionality improve economic judgment |
| E4 | Smooth phase weighting improves E3 compared with fixed weights |
| E5 | Verified target-specific Denial adds value beyond Threats |

Keep the old evaluator selectable for experiments. Use distinct evaluator
identities in benchmark output, and start new search sessions when switching
variants: reused trees must not mix rewards from different evaluators.
Implement Denial last; it is both expensive and easy to double-count with
Threats. Reject unnecessary features through ablations.

### 4. Evaluate leaf quality and runtime separately

For each corpus position, generate repeated completed continuations under the
unchanged rollout policy with independent recorded RNG seeds. Compare old and
new rewards with empirical continuation outcomes using ranking accuracy,
Brier score, and calibration plots, stratified by phase and cutoff status.
These labels describe that policy, not optimal play. Supplement tactical cases
with verified outcomes and a small stronger-search reference sample.

Benchmark feature extraction and complete rollout/search costs on representative
positions. Record ns/evaluation, allocations, wall time, and completed
simulations. Use a provisional budget of at most 5% search throughput loss
for a leaf-only candidate; exceeding it calls for profiling and a stronger
playing-strength justification, not automatic rejection.

Tune a small bounded parameter set on development data, select on validation,
and lock all parameters before final testing. Do not repeatedly tune against
the final seeds. Correctness and runtime checks must pass before match trials.

### 5. Test actual playing strength

Run both fixed-completed-simulation comparisons and equal-wall-clock matches.
The first isolates changes in reward quality; the second is the deployment
criterion and includes evaluator cost. Add experiment-only fixed-simulation
support if needed, with deterministic single-worker RNG and identical rollout
caps. Tree reuse, when enabled, must be identical and reported for both sides.

Use seed pairs: play each initial game seed twice with seats swapped. The
current Go arena alternates seats but increments the seed every game; update
the experimental harness or run two explicit one-game invocations per seed.
Use one active match at a time for parallel bots to avoid CPU contention.

- Screen each candidate at 1s on 12 seed pairs; treat results as exploratory.
- Advance only promising candidates to 30 validation seed pairs at 1s, with
  smaller 200ms and 5s sensitivity checks.
- Confirm the locked finalist against E0 on 100 fresh seed pairs at 1s.
  Include smaller checks against serial MCTS and alpha-beta to expose opponent
  dependence; these are secondary outcomes.

Record raw JSONL: initial seed, seats, search RNG settings, variants, budgets,
workers, winner/draw, turns, errors, latency, completed simulations, cutoff
counts, and reuse statistics. Score wins as 1 and draws as 0.5; keep draws in
the denominator. Report scores by seat and a 95% confidence interval using
paired-seed bootstrap resampling. Do not treat individual moves or the two
games in a seed pair as independent samples.

Promotion rule: all correctness checks pass, no illegal actions or observed
timeout regressions, and the primary 1s held-out score has a 95% interval
entirely above 50%. Smaller budget/opponent checks must show no clear material
regression; uncertainty is reported rather than called equivalence. If the
primary interval includes 50%, label the result inconclusive and retain E0.
Set the test sample size before running it; do not stop at a favorable score.

### 6. Iterate and consider shorter rollouts separately

For each round, record hypothesis, exact change, parameters, performance,
match results, and a keep/reject/inconclusive decision. Inspect losses and
feature contributions, then test one proposed correction on development data.
Use feature ablations to detect redundant or harmful terms.

Only after leaf quality improves, test rollout caps such as 80 and 40 against
160 in a separate evaluator-by-cap experiment, including E0 at each cap.
Recheck fixed-simulation quality and equal-time strength; more simulations do
not imply better play. Keep deadline-interrupted rollout handling unchanged.
If later changing rollout move selection, use another separate experiment:
feeding the evaluator into that policy changes which leaves are generated.

## Deliverables and first milestone

Deliver diagnostics and a baseline report first, followed by a split position
corpus, selectable evaluator candidates, focused tests, reproducible benchmark
scripts, raw results, and a final report with the locked configuration or an
explicit decision to retain the baseline.

The first milestone is the cutoff-frequency report plus E1/E2 offline
validation. It decides whether this work should remain a leaf evaluator
improvement, proceed to a separately validated shorter-rollout experiment, or
stop because terminal rollouts already make the heuristic irrelevant.
