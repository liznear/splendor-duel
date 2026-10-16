package search

import (
	"context"
	"testing"

	"splender/internal/game"
)

func TestChooseReportsMCTSStats(t *testing.T) {
	s := newState()
	m, stats, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", TimeMS: 500, Parallelism: 2})
	if err != nil {
		t.Fatal(err)
	}
	if stats == nil || stats.Simulations <= 0 || stats.MoveSimulations <= 0 || stats.MoveSimulations > stats.Simulations || stats.WinRate == nil || *stats.WinRate < 0 || *stats.WinRate > 1 {
		t.Fatalf("invalid MCTS statistics: %+v", stats)
	}
	next, err := game.Apply(s, m)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Reply == nil {
		t.Fatal("second tree level must surface the opponent's best sampled reply")
	}
	if _, err := game.Apply(next, *stats.Reply); err != nil {
		t.Fatalf("reply must be legal after the chosen move: %+v, %v", *stats.Reply, err)
	}
	// The same statistics back the extra-turn hint: after stepping the trees
	// along the chosen move, the roots are the opponent's nodes and carry the
	// identical best move. Stepping the (non-extra-turn) reply returns the
	// roots to the searcher, where no opponent hint may be invented.
	sess := NewSession(2)
	sessMove, searchStats, err := sess.Choose(context.Background(), s, Config{Kind: "mcts", TimeMS: 500, Parallelism: 2})
	if err != nil {
		t.Fatal(err)
	}
	if searchStats.Reply == nil {
		t.Fatal("fresh session must surface a sampled reply")
	}
	sess.Step(sessMove)
	hint := sess.OpponentHint()
	if hint == nil || moveKey(*hint) != moveKey(*searchStats.Reply) {
		t.Fatalf("stepped roots must reproduce the sampled reply: %+v vs %+v", hint, searchStats.Reply)
	}
	sess.Step(*searchStats.Reply)
	if sess.OpponentHint() != nil {
		t.Fatal("searcher-owned roots must not yield an opponent hint")
	}
	_, stats, err = ChooseWithStats(context.Background(), s, Config{Kind: "greedy"})
	if err != nil || stats != nil {
		t.Fatalf("non-simulation agents must not report MCTS stats: %+v, %v", stats, err)
	}
}
