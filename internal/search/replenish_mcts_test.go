package search

import (
	"context"
	"reflect"
	"testing"

	"splender/internal/game"
)

func TestMCTSChoosesVoluntaryReplenishmentWin(t *testing.T) {
	for _, workers := range []int{1, 8} {
		s := replenishmentWinPosition()
		move, _, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", Parallelism: workers, TimeMS: 100, IncludeRefill: true})
		if err != nil {
			t.Fatal(err)
		}
		next, err := game.Apply(s, move)
		if err != nil || !move.Replenish || next.Winner == nil || *next.Winner != 0 {
			t.Fatalf("workers=%d missed immediate replenishment win: %+v, %v", workers, move, err)
		}
	}
}

func TestMCTSRefillDisabledByDefault(t *testing.T) {
	for _, workers := range []int{1, 8} {
		s := replenishmentWinPosition()
		move, _, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", Parallelism: workers, TimeMS: 30})
		if err != nil || move.Replenish {
			t.Fatalf("workers=%d default search refilled: %+v, %v", workers, move, err)
		}
		if _, err := game.Apply(s, move); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMCTSWorkersUseFullStateAndRefillPolicy(t *testing.T) {
	s := replenishmentWinPosition()
	sess := NewSession(3)
	for _, enabled := range []bool{false, true, false} {
		_, _, err := sess.Choose(context.Background(), s, Config{Kind: "mcts", Parallelism: 3, TimeMS: 30, IncludeRefill: enabled})
		if err != nil {
			t.Fatal(err)
		}
		for i, tr := range sess.trees {
			want := importSim(s)
			want.includeRefill = enabled
			if tr == nil || !reflect.DeepEqual(tr.trunk, want) {
				t.Fatalf("worker %d does not match full state/refill policy", i)
			}
			found := false
			for _, e := range tr.root.children {
				found = found || e.move.replenish
			}
			if found != enabled {
				t.Fatalf("worker %d refill branches=%v, want %v", i, found, enabled)
			}
		}
	}
}

func TestMoveKeySeparatesReplenishment(t *testing.T) {
	ordinary := game.Move{Action: game.Action{Kind: "take", Cells: []int{0}}}
	replenished := ordinary
	replenished.Replenish = true
	if moveKey(ordinary) == moveKey(replenished) {
		t.Fatal("parallel statistics merge replenishment with ordinary moves")
	}
	first := replenished
	first.ReplenishFirst = true
	if moveKey(first) == moveKey(replenished) {
		t.Fatal("move identity loses optional-action ordering")
	}
}
