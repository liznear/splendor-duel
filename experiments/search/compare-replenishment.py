#!/usr/bin/env python3
"""Compare committed sampled MCTS with isolated full-state or refill MCTS.

Builds both agents from one commit, then overlays only the full-state position
and replenishment kernel onto the updated agent. Concurrent workspace changes
to tree reuse, alpha-beta, HTTP, and UI are deliberately excluded.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile


BENCH = r'''
package main

import (
 "context"
 "encoding/json"
 "flag"
 "fmt"
 "os"
 "path/filepath"
 "runtime"
 "time"

 "splender/internal/game"
 "splender/internal/session"
 original "splender/internal/original"
 updated "splender/internal/updated"
)

type totals struct {
 Moves int `json:"moves"`
 Simulations int `json:"simulations"`
 SearchSeconds float64 `json:"searchSeconds"`
 Replenishments int `json:"voluntaryReplenishments"`
}

func probes(file string, budget, workers int, includeRefill bool, emit func(any)) {
 rec, err := (session.Store{Dir:filepath.Dir(file)}).Read(filepath.Base(file))
 if err != nil { panic(err) }
 for _, turn := range []int{19,30,47,61} {
  index := -1
  for i,e := range rec.Events { if e.Type=="move" && e.Turn==turn { index=i; break } }
  if index<0 { panic(fmt.Sprintf("missing probe turn %d",turn)) }
  prefix:=rec
  prefix.Events=rec.Events[:index]
  s,err:=prefix.Replay()
  if err!=nil {panic(err)}
  for trial:=0;trial<3;trial++ {
   for agent:=0;agent<2;agent++ {
    start:=time.Now()
    var move game.Move
    var simulations int
    var rate *float64
    label:="original"
    if agent==0 {
     var stats *original.Stats
     move,stats,err=original.ChooseWithStats(context.Background(),s,original.Config{Kind:"mcts",TimeMS:budget,Parallelism:workers})
     if stats!=nil {simulations=stats.Simulations;rate=stats.WinRate}
    } else {
     label="updated"
     var stats *updated.Stats
     move,stats,err=updated.ChooseWithStats(context.Background(),s,updated.Config{Kind:"mcts",TimeMS:budget,Parallelism:workers,IncludeRefill:includeRefill})
     if stats!=nil {simulations=stats.Simulations;rate=stats.WinRate}
    }
    if err!=nil {panic(err)}
    if _,err=game.Apply(s,move);err!=nil {panic(err)}
    emit(map[string]any{"t":"probe","turn":turn,"trial":trial,"agent":label,"simulations":simulations,"searchSeconds":time.Since(start).Seconds(),"winRate":rate,"move":move})
   }
  }
 }
}

func main() {
 games := flag.Int("games", 24, "even number of paired games")
 budget := flag.Int("time-ms", 200, "wall-clock budget per turn")
 workers := flag.Int("workers", 8, "workers per agent")
 includeRefill := flag.Bool("include-refill", false, "updated agent voluntary refill")
 seed := flag.Int64("seed", 20261004, "first paired seed")
 probeSession := flag.String("probe-session", "", "session for fixed-position probes")
 flag.Parse()
 runtime.GOMAXPROCS(*workers)
 enc := json.NewEncoder(os.Stdout)
 emit := func(v any) { if err := enc.Encode(v); err != nil { panic(err) } }
 emit(map[string]any{"t":"benchmark", "games":*games, "timeMs":*budget, "workers":*workers, "gomaxprocs":runtime.GOMAXPROCS(0), "seed":*seed, "statsOrder":[2]string{"original","updated"}, "protocol":"same-seed seat-swapped pairs; one game at a time; 180-turn cap"})
 if *probeSession!="" {probes(*probeSession,*budget,*workers,*includeRefill,emit)}
 aggregate := [2]totals{}
 wins, losses, draws := 0, 0, 0
 started := time.Now()
 for i := 0; i < *games; i++ {
  pairSeed := *seed + int64(i/2)*7919
  first, updatedSeat := 0, i%2
  names := [2]string{"original", "original"}
  names[updatedSeat] = "updated"
  s := game.New(pairSeed, names, &first)
  counts := [2]totals{}
  for step := 0; step < 180 && !s.Over(); step++ {
   legal := game.LegalMoves(s)
   if legal.MustReplenish {
    if !legal.CanReplenish { s.Draw = true; break }
    next, err := game.Replenish(s)
    if err != nil { panic(err) }
    s = next
   }
   seat := s.Current
   agent := 0
   var move game.Move
   var simulations int
   var moveSimulations int
   var winRate *float64
   var err error
   start := time.Now()
   if seat == updatedSeat {
    agent = 1
    var stats *updated.Stats
    move, stats, err = updated.ChooseWithStats(context.Background(), s, updated.Config{Kind:"mcts", TimeMS:*budget, Parallelism:*workers, IncludeRefill:*includeRefill})
    if stats != nil { simulations = stats.Simulations; moveSimulations = stats.MoveSimulations; winRate = stats.WinRate }
   } else {
    var stats *original.Stats
    move, stats, err = original.ChooseWithStats(context.Background(), s, original.Config{Kind:"mcts", TimeMS:*budget, Parallelism:*workers})
    if stats != nil { simulations = stats.Simulations; moveSimulations = stats.MoveSimulations; winRate = stats.WinRate }
   }
   if err != nil { panic(fmt.Sprintf("game=%d turn=%d choose: %v", i, s.Turn, err)) }
   searchSeconds := time.Since(start).Seconds()
   emit(map[string]any{"t":"move", "index":i, "seed":pairSeed, "seat":seat, "turn":s.Turn, "agent":names[seat], "move":move, "searchSeconds":searchSeconds, "search":map[string]any{"simulations":simulations,"moveSimulations":moveSimulations,"winRate":winRate}})
   counts[agent].Moves++
   counts[agent].Simulations += simulations
   counts[agent].SearchSeconds += searchSeconds
   if move.Replenish { counts[agent].Replenishments++ }
   next, err := game.Apply(s, move)
   if err != nil { panic(fmt.Sprintf("game=%d turn=%d illegal %+v: %v", i, s.Turn, move, err)) }
   s = next
   if step%10==9 && !s.Over() {
    emit(map[string]any{"t":"progress", "index":i, "turn":s.Turn, "updatedSeat":updatedSeat, "stats":counts, "points":[2]int{s.Players[0].Points,s.Players[1].Points}, "crowns":[2]int{s.Players[0].Crowns,s.Players[1].Crowns}})
   }
  }
  outcome := "draw"
  if s.Winner == nil { draws++ } else if *s.Winner == updatedSeat { wins++; outcome="updated" } else { losses++; outcome="original" }
  for agent := range aggregate {
   aggregate[agent].Moves += counts[agent].Moves
   aggregate[agent].Simulations += counts[agent].Simulations
   aggregate[agent].SearchSeconds += counts[agent].SearchSeconds
   aggregate[agent].Replenishments += counts[agent].Replenishments
  }
  emit(map[string]any{"t":"game", "index":i, "seed":pairSeed, "updatedSeat":updatedSeat, "outcome":outcome, "turns":s.Turn, "stats":counts, "points":[2]int{s.Players[0].Points,s.Players[1].Points}, "crowns":[2]int{s.Players[0].Crowns,s.Players[1].Crowns}})
 }
 emit(map[string]any{"t":"summary", "updatedWins":wins, "originalWins":losses, "draws":draws, "errors":0, "stats":aggregate, "elapsedSeconds":time.Since(started).Seconds()})
}
'''


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("Baseline source differs from expected MCTS implementation")
    return source.replace(old, new)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="85952dc990a43755f17b3d728fb1d470bc21e2c5")
    parser.add_argument("--variant", choices=["refill", "full-state"], default="refill")
    parser.add_argument("--games", type=int, default=24)
    parser.add_argument("--time-ms", type=int, default=200)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20261004)
    parser.add_argument("--probe-session", help="compare three searches per recorded single-token position")
    parser.add_argument("--check", action="store_true", help="run isolated search tests before benchmarking")
    args = parser.parse_args()
    if (args.games < 2 or args.games % 2) and not (args.games == 0 and args.probe_session):
        parser.error("--games must be a positive even number")
    if not 1 <= args.time_ms <= 120000 or not 1 <= args.workers <= 32:
        parser.error("invalid time budget or worker count")
    repo = pathlib.Path(__file__).resolve().parents[2]

    def git(*arguments):
        return subprocess.check_output(["git", *arguments], cwd=repo)

    with tempfile.TemporaryDirectory(prefix="splender-refill-") as directory:
        root = pathlib.Path(directory)
        (root / "go.mod").write_bytes(git("show", f"{args.baseline}:go.mod"))
        files = git("ls-tree", "-r", "--name-only", args.baseline, "internal/game", "internal/search", "internal/session").decode().splitlines()
        for name in files:
            if name.endswith("_test.go") or "/testdata/" in name:
                continue
            relative = pathlib.Path(name)
            destinations = [root / relative] if relative.parts[1] in {"game", "session"} else [root / "internal" / agent / relative.name for agent in ["original", "updated"]]
            for path in destinations:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(git("show", f"{args.baseline}:{name}"))
        updated = root / "internal/updated"
        hashes = {}
        for name in ["sim.go", "position.go"]:
            data = (repo / "internal/search" / name).read_bytes() if name == "position.go" or args.variant == "refill" else (updated / name).read_bytes()
            (updated / name).write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        config = (repo / "internal/search/config.go").read_bytes()
        (updated / "config.go").write_bytes(config)
        hashes["config.go"] = hashlib.sha256(config).hexdigest()
        path = updated / "search.go"
        code = replace_once(path.read_text(), '\n\t"math/rand/v2"', "")
        code = replace_once(code, '\tr := rand.New(rand.NewPCG(uint64(s.Seed)+uint64(s.Turn), uint64(s.Current)+42))\n\tv := position(s, r)', '\tv := position(s)')
        if args.variant == "refill":
            code = replace_once(code, "parallelMCTS(searchCtx, v, c.Parallelism, fallback)", "parallelMCTS(searchCtx, v, c.Parallelism, c.IncludeRefill, fallback)")
        path.write_text(code)
        path = updated / "mcts.go"
        code = replace_once(path.read_text(), '\t\t\tr := rand.New(rand.NewPCG(uint64(s.Seed)+uint64(i)+1, uint64(s.Turn)+77))\n\t\t\tv := position(s, r)\n\t\t\tresults <- mcts(ctx, v,', '\t\t\tresults <- mcts(ctx, s,')
        code = replace_once(code, '"%s:%v:%d:%s:%d:%d:%d:%v",', '"%s:%v:%d:%s:%d:%d:%d:%v:%t:%t",')
        code = replace_once(code, 'm.Action.From.Level, m.Privileges)', 'm.Action.From.Level, m.Privileges, m.Replenish, m.ReplenishFirst)')
        if args.variant == "refill":
            code = replace_once(code, "func mcts(ctx context.Context, s *game.State, seed uint64) []rootStat {", "func mcts(ctx context.Context, s *game.State, seed uint64) []rootStat {\n return mctsWithRefill(ctx, s, seed, false)\n}\nfunc mctsWithRefill(ctx context.Context, s *game.State, seed uint64, includeRefill bool) []rootStat {")
            code = replace_once(code, "root := &node{state: importSim(s)}", "root := &node{state: importSim(s)}\n root.state.includeRefill = includeRefill")
            code = replace_once(code, "workers int, fallback game.Move", "workers int, includeRefill bool, fallback game.Move")
            code = replace_once(code, "mcts(ctx, s, uint64(i)+uint64(s.Turn)*100+3)", "mctsWithRefill(ctx, s, uint64(i)+uint64(s.Turn)*100+3, includeRefill)")
        if "type simScorer struct" in (updated / "sim.go").read_text():
            code = replace_once(code, '\tmoves := n.state.ready(scratch[:0])', '\tmoves := n.state.ready(scratch[:0])\n\tscorer := n.state.scorer()')
            code = replace_once(code, 'n.state.score(b), n.state.score(a)', 'scorer.score(b), scorer.score(a)')
        path.write_text(code)
        if args.check:
            if args.variant == "refill":
                for name in ["replenish_test.go", "replenish_mcts_test.go"]:
                    tests = (repo / "internal/search" / name).read_text()
                    if name == "replenish_mcts_test.go":
                        start = tests.index("func TestMCTSWorkersUseFullStateAndRefillPolicy")
                        end = tests.index("func TestMoveKeySeparatesReplenishment", start)
                        tests = tests[:start] + tests[end:]
                        tests = replace_once(tests, '\n\t"reflect"', "")
                    (updated / name).write_text(tests)
            tests = git("show", f"{args.baseline}:internal/search/search_test.go").decode()
            start = tests.index("func TestSearchDoesNotUseRealDeckOrder")
            end = tests.index("func TestGreedyGamesFinish", start)
            tests = tests[:start] + tests[end:]
            tests = replace_once(tests, '\n\t"math/rand/v2"', "")
            current_tests = (repo / "internal/search/search_test.go").read_text()
            for name in ["TestSearchPreservesFullState", "TestAgentsReserveActualWinningDeckCard"]:
                start = current_tests.index(f"func {name}(")
                end = current_tests.find("\nfunc ", start + 1)
                tests += "\n" + current_tests[start:end if end >= 0 else len(current_tests)]
            (updated / "search_test.go").write_text(tests)
            tests = git("show", f"{args.baseline}:internal/search/sim_test.go").decode()
            tests = replace_once(tests, "position(s, rand.New(rand.NewPCG(1, 2)))", "position(s)")
            (updated / "sim_test.go").write_text(tests)
            (updated / "stats_test.go").write_bytes(git("show", f"{args.baseline}:internal/search/stats_test.go"))
            data_dir = updated / "testdata"
            data_dir.mkdir()
            for name in git("ls-tree", "-r", "--name-only", args.baseline, "internal/search/testdata").decode().splitlines():
                (data_dir / pathlib.Path(name).name).write_bytes(git("show", f"{args.baseline}:{name}"))
            subprocess.run(["go", "test", "-race", "./internal/updated", "-count=1"], cwd=root, check=True, stdout=sys.stderr)
        command = root / "cmd/compare"
        command.mkdir(parents=True)
        (command / "main.go").write_text(BENCH)
        binary = root / "compare"
        subprocess.run(["go", "build", "-buildvcs=false", "-o", str(binary), "./cmd/compare"], cwd=root, check=True)
        scope = "full state and voluntary replenishment only; no subtree reuse" if args.variant == "refill" else "full state only; no voluntary replenishment or subtree reuse"
        print(json.dumps({"t": "source", "baselineCommit": args.baseline, "updatedVariant": args.variant, "updatedKernelSHA256": hashes, "scope": scope}), flush=True)
        arguments = [str(binary), "-games", str(args.games), "-time-ms", str(args.time_ms), "-workers", str(args.workers), "-seed", str(args.seed), "-include-refill", str(args.variant == "refill").lower()]
        if args.probe_session:
            arguments += ["-probe-session", str(pathlib.Path(args.probe_session).resolve())]
        subprocess.run(arguments, cwd=root, check=True)


if __name__ == "__main__":
    main()
