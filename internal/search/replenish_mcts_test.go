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
		move, _, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", Parallelism: workers, TimeMS: 100})
		if err != nil {
			t.Fatal(err)
		}
		next, err := game.Apply(s, move)
		if err != nil || !move.Replenish || next.Winner == nil || *next.Winner != 0 {
			t.Fatalf("workers=%d missed immediate replenishment win: %+v, %v", workers, move, err)
		}
	}
}

func TestMCTSChoosesVoluntaryReplenishmentWinByDefault(t *testing.T) {
	for _, workers := range []int{1, 8} {
		s := replenishmentWinPosition()
		move, _, err := ChooseWithStats(context.Background(), s, Config{Kind: "mcts", Parallelism: workers, TimeMS: 30})
		if err != nil || !move.Replenish {
			t.Fatalf("workers=%d default search missed refill: %+v, %v", workers, move, err)
		}
		if _, err := game.Apply(s, move); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMCTSWorkersUseFullStateAndRefillPolicy(t *testing.T) {
	s := replenishmentWinPosition()
	sess := NewSession(3)
	for i := 0; i < 3; i++ {
		_, _, err := sess.Choose(context.Background(), s, Config{Kind: "mcts", Parallelism: 3, TimeMS: 30})
		if err != nil {
			t.Fatal(err)
		}
		for i, tr := range sess.trees {
			want := importSim(s)
			if tr == nil || !reflect.DeepEqual(tr.trunk, want) {
				t.Fatalf("worker %d does not match full state/refill policy", i)
			}
			found := false
			for _, e := range tr.root.children {
				found = found || e.move.replenish
			}
			if !found {
				t.Fatalf("worker %d missing default refill branches", i)
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
