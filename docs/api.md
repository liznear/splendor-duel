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

`mode` is `human` or `agents`. Human seat defaults to 1; the human player's agent configuration is ignored. Seat 0 starts, seat 1 receives a privilege. Seed is optional. Missing agent configurations default to greedy. `timeMs` defaults to 4000, range 1–120000. MCTS `parallelism` defaults to 1, range 1–32; other agents require 1.

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
| `notice`, `noticeSeat` | Forced replenishment notification, or `null` |
| `pending` | Human-mode bot turn is due; call `/bot` |

Legal is `{actions: [{i, action, desc}], canReplenish, mustReplenish, privilegeCells}`. `i` is descriptive, not a persistent action identifier. Submit the action itself. Optional actions immediately change the view and legal list; fetch/consume the new snapshot before constructing the mandatory move.

The public `view` retains the browser model: `board` (25 colors/null), `bag` (colors), `decks` (three arrays of anonymous `{}` entries, exposing counts only), `pyramid` (12 cards/null), `royals`, `players` (two), `current`, `extraTurns`, `turnCount`, `winner`, `draw`, `log`. It omits seed and RNG state. Opponent blind reserved cards are `id: "hidden"` placeholders with only their level visible. Public pyramid reservations stay visible. Search samples unseen cards without reading the live deck order, actual shuffle state, or opponent blind cards.

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

Go session records retain the original event format and add an optional `names` event when a resumed game changes agent names.

## Compatibility and evolution

`public/api.js` translates the UI's operation names and agent selections to v1. Rendering code consumes the established Snapshot model. Introduce a new version for incompatible wire changes, and translate the new representation in this adapter. Contract tests cover both route families and browser translation.

The compatibility route mapping is: `/api/new` → create; `/api/state/{id}` → read; `/api/move/{id}` → moves; `/api/option/{id}` → options; `/api/bot/{id}` → bot; `/api/step/{id}` → step; `/api/sessions` → list; `/api/resume` → resume. Compatibility creates accept `p1`/`p2` specs instead of structured `players`. Compatibility snapshots additionally include `ok: true`.
