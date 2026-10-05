# Leaf evaluator experiment: first milestone

Decision: retain production E0. The natural leaf-evaluation surface is tiny,
and the first E1/E2 candidates did not improve the small validation corpus.
No production search behavior changed; no playing-strength claim is made.

## Archived baseline and methodology

Baseline commit: `62dfba4357a0065491e8e62e41b38c4bd8d58688`.
`manifest.json` retains the recorded source/binary hashes, Go version, CPU,
GOMAXPROCS, parameters, and tracked diff as historical experiment metadata.
The rejected candidate implementations, diagnostic tests, runner, and console
logs were removed during cleanup. Production search never used them. The
reports, summaries, raw measurements, and captured positions remain available
for analysis; rerunning the experiment requires rebuilding a dedicated harness.

The experiment ran one search at a time with a fresh single-worker tree, E0,
160-action rollouts, full-state information, and optional early replenishment
disabled. RNG was PCG(3,74) for each search. Rollout policy, UCT, move generation,
and deadline-discard behavior were unchanged.

The diagnostic MCTS was a frozen test-only copy of the baseline control flow.
Its differences are counters and an instrumented rollout; production code has
no added branches/counters. A differential test checks rewards and subsequent
RNG state against production rollout for 100 seeds. Counters are local, not
shared atomics. This first gate uses one worker; parallel-worker/reuse checks
are deferred because no candidate advances to deployment.

## Natural cutoff frequency

Thirteen searches cover opening (turn 0), midgame (turn 24), ending (turn 48),
and the saved single-token position. Each runs at 200ms, 1s, and 5s; the saved
position also runs at 20s. `baseline.jsonl` includes root visits/reward sums,
length histograms, terminal wins/losses, draws, cap cutoffs, interruptions,
backpropagated simulations, retained visits, and elapsed time.

| Position | 1s completed simulations | Mean rollout actions | 5s cap rewards |
| --- | ---: | ---: | ---: |
| Opening | 6,027 | 68.22 | 0 |
| Midgame | 10,245 | 40.48 | 0 |
| Ending | 21,579 | 16.82 | 1 |
| Saved single-token | 8,019 | 53.36 | 2 |

Across all searches: **22 cap rewards / 507,888 backpropagated simulations =
0.00433%**. All 200ms and 1s searches had zero cap rewards. The 20s saved
position search contributed 19 / 200,955 (0.00945%). Each search discarded one
deadline-interrupted rollout. The worst observed overshoot was 16.6ms at 20s;
these are observations of the existing search, not new timeout behavior.

This sample is not an estimate for every game position, refill policy or
worker configuration. It does establish that a leaf-only improvement has
very little opportunity in these representative current settings.

## E1 and E2 implementations

The offline harness selected experimental E0/E1/E2 evaluators isolated from
production. These implementations have since been removed; no app configuration
or session reward mixing was introduced.

- E0: exact existing static reward.
- E1: nearest normalized victory route (total points/20, crowns/10, single
  color points/10), plus best useful visible/reserved purchase's resource
  deficit tempo. Progress and tempo lie in [0,1]. Difference uses weights
  3 and 1, temperature 1.5, and the existing `.5 + .45*tanh(...)` mapping.
  The tempo proxy handles discounts, gold and pearls but is not a legal
  acquisition-time search. Pure discount value is deferred to E3.
- E2: E1 plus verified generated winning purchases for the player to move
  (reward .95/.05), and a finite 1.5 penalty for a conditional opponent
  winning purchase. It applies legal kernel purchase plans on copies,
  including privileges and default royal/associate choices. It does not
  declare a forced loss or enumerate every explicit engine choice.

Exact terminal 1/0 and draw .5 rewards are preserved. Tactical tests verify
all three winning routes and a royal-triggered points win against engine
actions. Other checks cover a reserve defense to a conditional threat,
gold/pearl deficit behavior, early crown urgency, bounded finite rewards,
perspective symmetry, no mutation, and zero allocations.

No phase tuning, engine/optionality, denial, shorter rollout, or rollout-policy
change was made. Those are later hypotheses and have not cleared this gate.

## Corpus and offline quality

`corpus.jsonl` records complete engine states from three independent seeds,
with noisy static, uniform, and asymmetric static/uniform move policies.
Snapshots occur at turns 0/24/48/72 where the game survives that long.
Whole-seed split: 31001 development, 41001 validation, 51001 final.
The final seed has no outcome labels generated or used for selection.
This is a pilot corpus, not the full diverse matchup corpus in the plan.

Each ordinary development/validation position receives 256 independent
continuations under unchanged production rollout policy, with recorded RNG
formula. All 5,120 ordinary continuations terminate. Labels describe this
policy, not optimal play. Scores below average positions equally; neighboring
positions are correlated, and there is only one seed per split. They do not
support significance or strength claims.

| Split | Evaluator | Brier score (lower better) | Ranking accuracy |
| --- | --- | ---: | ---: |
| Development, 10 positions | E0 | .1968 | 81.6% |
| Development | E1/E2 | .1989 | 85.5% |
| Validation, 10 positions | E0 | .2162 | 78.6% |
| Validation | E1/E2 | .2584 | 62.5% |

Ranking compares pairs whose empirical mean outcome differs by more than .1,
with ties scored .5 (38 development pairs, 28 validation pairs). Brier score
is against individual continuation outcomes, not just squared error against
the mean. `summary.json` also provides mean-outcome error and calibration
bins. E2 has the same scores as E1 here because these ordinary positions do
not exercise its tactical override; targeted engine fixtures cover that
behavior. No parameters were tuned after viewing validation results.

### Natural cap leaves cannot be given terminal labels yet

The 22 naturally generated cap leaves are preserved in `cap-leaves.jsonl`.
They are exact kernel snapshots in engine-shaped JSON, with synthesized owned
card identities preserving color counts/points. A round-trip test checks all
kernel fields; these snapshots support kernel continuation and are not game
history records.

**All 90,112 continuations (4,096 per leaf) hit the 160-action cap again.**
None provided a terminal outcome. `offline.jsonl` records them as censored;
`summary.json` excludes them from quality scores. Using E0's heuristic as a
target would be circular, and calling them draws would invent a rule.

These leaves expose stalled behavior under the current rollout policy. For
example, one cap snapshot is at turn 215 with both players holding 10 tokens,
both reservation slots full, only gold remaining on the board, and players
at 16/19 points. Default refill/take/discard choices can keep the continuation
nonterminal. This is a separate policy/acquisition question. We have not
proved the states unwinnable, classified repetition as a draw, or changed
deadline handling.

## Runtime

Three benchmark repetitions, with no per-evaluation allocation:

| Evaluator | ns/evaluation observed |
| --- | ---: |
| E0 | 382–395 |
| E1 | 720–1,869 |
| E2 | 7,469–7,717 |

Typical production rollout benchmark was 124.7–125.1µs. Diagnostic rollout
was 60.1–125.0µs, also with zero allocations in the benchmark sample. The
large scheduling/frequency outlier means this run cannot resolve a precise
instrumentation overhead; it shows no consistent slowdown. Capturing actual
cap states allocates one snapshot per rare captured leaf (up to 64 per search).

E2 is much more expensive per leaf. Its amortized cost should be small at
the observed cutoff rate, but candidate search throughput was not measured
and is not claimed. All candidates remain experimental.

## Gate decision and next iteration

Completed: frozen baseline diagnostics, pilot split corpus, captured cap
states, isolated E1/E2, tactical/correctness tests, independent continuation
labels with censoring, runtime measurements, and raw/reporting harness.

**Retain E0. Stop before match screening and E3–E5.** E1/E2 did not improve
validation quality, and terminal continuations cannot currently label their
actual cap-leaf surface. Equal-time matches, fixed-simulation support,
30/100-pair promotion trials, dynamic weights, denial, and calibration plots
remain deferred; calibration data is supplied in JSON.

A justified next investigation is to classify stalled continuations and
compare controlled acquisition/discard alternatives on these saved leaves.
That changes rollout policy and needs its own experiment. If the evaluator
work resumes, first enlarge the corpus across whole independent game seeds,
improve target-aware features with ablations, and obtain an independent
reference for cap leaves. Keep the final seed locked and the 160-action cap
unchanged until those checks pass.

Validation performed: `go test ./...`, focused leaf tests under the race
detector, `gofmt`, Python syntax check, and the reproducible opt-in experiment.
No commit was created.
