# HTTP interface v1

JSON requests and replies. Successful operations return 200. Errors are `{ "error": "human-readable message", "code": "stable_code" }`; invalid input is 400 and missing games/sessions are 404. Request bodies are limited to 1 MiB. Unknown JSON fields are rejected. Clients must tolerate additional response fields.

## Endpoints

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{status: "ok", version: 1}` |
| GET | `/api/v1/agents` | — | `['greedy', 'alpha-beta', 'mcts']` |
| POST | `/api/v1/games` | CreateGame | Snapshot, plus `id`, `mode`, `humanSeat`, `file` |
| GET | `/api/v1/games/{id}` | `?seat=0` or `?seat=1` | Snapshot |
| POST | `/api/v1/games/{id}/moves` | `{seat, move}` | Snapshot |
| POST | `/api/v1/games/{id}/options` | `{seat, privileges?: number[], replenish?: boolean}` | Snapshot |
| POST | `/api/v1/games/{id}/bot` | `{}` | Human-mode snapshot after bots yield or finish |
| POST | `/api/v1/games/{id}/step` | `{}` | Agent-mode snapshot after one turn |
| GET | `/api/v1/sessions` | — | Up to 50 summaries, newest filename first |
| POST | `/api/v1/sessions/resume` | `{file, mode?, humanSeat?, players?}` | Created-game snapshot plus `resumedFile` |

CreateGame:

```json
{
  "mode": "human",
  "humanSeat": 1,
  "seed": 42,
  "players": [
    {"kind": "mcts", "timeMs": 1000, "parallelism": 8},
    {"kind": "greedy"}
  ]
}
```

`mode` is `human` or `agents`. Human seat defaults to 1; the human player's agent configuration is ignored. Seat 0 starts, seat 1 receives a privilege. Seed is optional. Missing agent configurations default to greedy. `timeMs` defaults to 4000, range 1–120000. MCTS and alpha-beta `parallelism` defaults to 1, range 1–32; greedy requires 1. Alpha-beta workers search separate root moves with a shared time budget and retain only fully completed depths.

MCTS enables restricted voluntary replenishment by default at every tree and rollout position: the board must have at most three non-gold tokens, and no purchase may be available, including reserved cards and privilege-assisted purchases. Forced replenishment remains available regardless. Token-taking actions use only the maximum legal take size when a maximum-size take avoids granting the opponent a privilege. Smaller takes remain available if every maximum-size take triggers the privilege rule (three matching colors or at least two pearls). This applies independently before and after replenishment. The legacy `includeRefill` field and `+refill` string option remain accepted, but MCTS normalizes `includeRefill` to `true` even when omitted or set to `false`. Other agent kinds reject `includeRefill: true`.

Resume defaults to recorded mode, human seat, and supported agent specs. Removed LLM/random specs fall back to greedy. Optional `p1`/`p2` string specs are accepted for compatibility; new clients should use `players`.

## Snapshot

| Field | Type / meaning |
| --- | --- |
| `view` | Public game view described below |
| `seat`, `current`, `turn` | Requested seat, active seat, completed-turn counter |
| `over`, `draw` | Booleans |
| `winner` | `0`, `1`, or `null` |
| `winReason` | `20分`, `10皇冠`, `同色10分`, or `null` |
| `legal` | Legal action descriptions for the active requested seat, otherwise `null` |
| `names` | Two player names |
| `recentMoves` | Last 20 bot move visuals, cleared on human move |
| `botSearch` | Two entries indexed by seat: latest completed MCTS search statistics, or `null` |
| `botTimeoutMs` | Two configured search timeouts in milliseconds, indexed by seat; used for the frontend elapsed-time progress bar |
| `notice`, `noticeSeat` | Forced replenishment notification, or `null` |
| `pending` | Human-mode bot turn is due; call `/bot` |

Legal is `{actions: [{i, action, desc}], canReplenish, mustReplenish, privilegeCells}`. `i` is descriptive, not a persistent action identifier. Submit the action itself. Optional actions immediately change the view and legal list; fetch/consume the new snapshot before constructing the mandatory move.

Each `botSearch` entry is `{turn, simulations, moveSimulations, winRate, reply}`. `turn` identifies the searched turn (one-based). `simulations` counts completed rollouts across all MCTS workers; `moveSimulations` counts those for the selected move. `winRate` is that move's average rollout reward from the bot's perspective, in `[0, 1]`, or `null` when no rollouts completed. Wins score 1, draws 0.5, and unfinished rollouts use a position evaluation, so this is an estimated win rate rather than a calibrated probability. `reply` is the opponent's best sampled response to the searched move, read from the second MCTS tree level at no extra search cost and shown in the UI as a hint; it is the searcher's model of the opponent (limited to sampled moves), and `null` when the search never sampled past its own move or the sampled reply is no longer legal on the live board. It is an object `{text, move}`: `text` is the display description — bundled optional actions are part of it, with replenishment and privilege steps listed before the main action, whose text reads the board after those options — and `move` is the sampled move itself, ready to submit verbatim through the move endpoint (bundled optional actions and engine picks included). When the human's move earns an extra turn, the hint is refreshed from the same stepped tree (again at no search cost) or cleared when that level was never sampled. Non-MCTS agents and players without a completed search have `null` entries. Statistics are retained for the current server session, including across human moves, but are not restored from saved game records.

Move visuals include `action`, `privGems`, `replenished`, `replenishFirst`, `takeGems`, `card`, `refill`, `associateGem`, `takeSameGem`, `stealGems`, `royals`, and `deltas` when applicable. `replenishFirst` determines the order of replenishment and privileges; both precede the main action. Gem colors reflect the board after preceding optional actions. Ability results and earned royals include the engine's default choices, even when the submitted move omitted those choices. `stealGems` lists all gems actually stolen and `royals` lists all royal cards earned. The singular `stealGem` and `royal` fields remain as compatibility aliases for the first result. Card and royal `ability` fields identify extra-turn, privilege, steal, and same-color effects for the recap.

Purchase visuals also include `payment`, a map of gem colors to the counts actually paid after discounts and preceding optional actions, including gold substitutions. `tokenChanges` records the acting player's signed net changes by gem color across the whole move, including privileges, payment, abilities, and discards. Zero net changes are omitted. The recap shows payment separately from net changes so a gem spent and subsequently recovered remains visible in the payment row.

The public `view` retains the browser model: `board` (25 colors/null), `bag` (colors), `decks` (three arrays of anonymous `{}` entries, exposing counts only), `pyramid` (12 cards/null), `royals`, `players` (two), `current`, `extraTurns`, `turnCount`, `winner`, `draw`, `log`. It omits seed and RNG state. Opponent blind reserved cards are `id: "hidden"` placeholders with only their level visible. Public pyramid reservations stay visible. Server-side bots search the full game state, including actual deck and bag order, shuffle RNG state, and both players' blind reserved cards. Every parallel MCTS worker starts from that same full state, with separate rollout randomness.

Player fields: `name`, `tokens`, `bonuses`, `cards` (`{def, color}`), `reserved`, `royals`, `privileges`, `crowns`, `points`, `royalsTaken`. Token counts use `black`, `red`, `green`, `blue`, `white`, `pearl`, `gold`; bonuses use the first five. Cards expose `id`, `level`, `color`, `isAssociate`, `points`, `bonus`, `ability`, `crowns`, `cost`, optional `blind`. Royals expose `id`, `points`, `ability`.

## Move

```json
{"seat": 1, "move": {"action": {"kind": "take", "cells": [6, 7, 8]}}}
```

Actions:

- `take`: `{kind: "take", cells: [cell, ...]}` — 1–3 consecutive horizontal, vertical, or diagonal non-gold cells.
- `reserve`: `{kind: "reserve", goldCell, from: {kind: "pyramid", slot}}` or `from: {kind: "deck", level}`.
- `buy`: `{kind: "buy", from: {kind: "pyramid", slot}}` or `from: {kind: "reserved", index}`.

All cell, slot, and reserved-card indices are zero-based. Deck level is 1–3. Moves also accept `privileges`, `replenish`, `replenishFirst`, `associateColor`, `royalPick`, `stealPick`, `takeSameCell`, `discard`. Optional actions are applied before the mandatory action. `replenishFirst` changes their order. Conditional choices default to the engine's deterministic choice when absent; invalid associate colors and invalid discard counts are rejected. Excess tokens are discarded at the end of the mandatory turn, not after optional actions.

Mutations require the configured human seat and the current turn. State reads do not advance games or write session results. Repeated calls during the same bot/step search share that operation. A later step request, after completion, intentionally starts another turn. There is no streaming or `botMessage` field.

Go session records retain the original event format and add an optional `names` event when a resumed game changes agent names. MCTS `move` events also include `search: {simulations, moveSimulations, winRate}`, with the same values and reward semantics as the snapshot. The event's `seat` identifies the bot and its zero-based `turn` identifies the searched position. If no rollouts completed, counts are zero and `winRate` is `null`. Human and non-MCTS moves omit `search`. Older records without statistics remain replayable; resume prefixes preserve recorded statistics, but the snapshot's latest-search display is not restored on resume.

## Compatibility and evolution

`public/api.js` translates the UI's operation names and agent selections to v1. Rendering code consumes the established Snapshot model. Introduce a new version for incompatible wire changes, and translate the new representation in this adapter. Contract tests cover both route families and browser translation.

The compatibility route mapping is: `/api/new` → create; `/api/state/{id}` → read; `/api/move/{id}` → moves; `/api/option/{id}` → options; `/api/bot/{id}` → bot; `/api/step/{id}` → step; `/api/sessions` → list; `/api/resume` → resume. Compatibility creates accept `p1`/`p2` specs instead of structured `players`. Compatibility snapshots additionally include `ok: true`.
