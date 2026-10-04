package search

import (
	"context"
	"testing"

	"splender/internal/game"
)

func TestChooseReportsMCTSStats(t *testing.T) {
	s := newState()
	m, stats, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", TimeMS: 100, Parallelism: 2})
	if err != nil {
		t.Fatal(err)
	}
	if stats == nil || stats.Simulations <= 0 || stats.MoveSimulations <= 0 || stats.MoveSimulations > stats.Simulations || stats.WinRate == nil || *stats.WinRate < 0 || *stats.WinRate > 1 {
		t.Fatalf("invalid MCTS statistics: %+v", stats)
	}
	if _, err := game.Apply(s, m); err != nil {
		t.Fatal(err)
	}
	_, stats, err = ChooseWithStats(context.Background(), s, Config{Kind: "greedy"})
	if err != nil || stats != nil {
		t.Fatalf("non-simulation agents must not report MCTS stats: %+v, %v", stats, err)
	}
}
