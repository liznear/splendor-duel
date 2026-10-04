package search

import (
	"math/rand/v2"
	"reflect"
	"testing"

	"splender/internal/game"
)

func replenishmentWinPosition() *game.State {
	first := 0
	s := game.New(42, [2]string{"A", "B"}, &first)
	s.Board = [25]game.Color{}
	s.Board[0] = "blue"
	s.Bag = []game.Color{"red"}
	s.Pyramid = [12]*game.Card{}
	s.Pyramid[0] = &game.Card{ID: "win", Level: 1, Color: "blue", Points: 1, Cost: game.Counts{"red": 1}}
	s.Decks = [3][]*game.Card{}
	s.Players[0].Points, s.Players[1].Points = 19, 19
	s.Players[0].Privileges, s.Players[1].Privileges = 1, 0
	return s
}

func TestSimVoluntaryRefillEnabledByDefault(t *testing.T) {
	sim := importSim(replenishmentWinPosition())
	var scratch [simMaxMoves]simMove
	found := false
	for _, m := range sim.ready(scratch[:0]) {
		found = found || m.replenish
	}
	if !found {
		t.Fatal("restricted voluntary replenishment must be enabled by default")
	}
}

func TestSimForcedRefillWithDefaultPolicy(t *testing.T) {
	s := replenishmentWinPosition()
	s.Board = [25]game.Color{}
	sim := importSim(s)
	var scratch [simMaxMoves]simMove
	moves := sim.ready(scratch[:0])
	if len(moves) == 0 {
		t.Fatal("default policy disabled forced refill")
	}
	for _, m := range moves {
		if !m.replenish {
			t.Fatal("forced branch did not replenish")
		}
		next := *sim
		next.apply(m)
		want, err := game.Apply(s, decodeSimMove(m))
		if err != nil || !reflect.DeepEqual(&next, importSim(want)) {
			t.Fatalf("forced refill diverged from engine: %v", err)
		}
	}
}

func TestSimReplenishmentMatchesEngine(t *testing.T) {
	rng := rand.New(rand.NewPCG(19, 47))
	for seed := int64(0); seed < 8; seed++ {
		reference := game.New(seed, [2]string{"A", "B"}, nil)
		sim := importSim(reference)
		var scratch [simMaxMoves]simMove
		for step := 0; step < 120 && !reference.Over(); step++ {
			legal := game.LegalMoves(reference)
			if legal.MustReplenish {
				if !legal.CanReplenish {
					break
				}
				var err error
				reference, err = game.Replenish(reference)
				if err != nil {
					t.Fatal(err)
				}
				sim.replenish()
			}
			before := *sim
			moves := sim.ready(scratch[:0])
			scorer := sim.scorer()
			if !reflect.DeepEqual(*sim, before) {
				t.Fatal("optional generation changed its parent")
			}
			for _, m := range moves {
				if scorer.score(m) != sim.score(m) {
					t.Fatalf("seed=%d step=%d cached scoring differs", seed, step)
				}
				move := decodeSimMove(m)
				expected, err := game.Apply(reference, move)
				if err != nil {
					t.Fatalf("seed=%d step=%d invalid move %+v: %v", seed, step, move, err)
				}
				next := *sim
				next.apply(m)
				if !reflect.DeepEqual(&next, importSim(expected)) {
					t.Fatalf("seed=%d step=%d divergent move %+v", seed, step, move)
				}
			}
			if len(moves) == 0 {
				break
			}
			pick := moves[rng.IntN(len(moves))]
			sim.apply(pick)
			var err error
			reference, err = game.Apply(reference, decodeSimMove(pick))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestSimNoVoluntaryReplenishmentWithEmptyBag(t *testing.T) {
	s := replenishmentWinPosition()
	s.Bag = nil
	sim := importSim(s)
	var scratch [simMaxMoves]simMove
	for _, move := range sim.ready(scratch[:0]) {
		if decodeSimMove(move).Replenish {
			t.Fatal("generated replenishment with an empty bag")
		}
	}
}

func TestSimForcedReplenishmentIsAnExplicitBranch(t *testing.T) {
	s := replenishmentWinPosition()
	s.Board = [25]game.Color{}
	sim := importSim(s)
	before := *sim
	var scratch [simMaxMoves]simMove
	moves := sim.ready(scratch[:0])
	if len(moves) == 0 {
		t.Fatal("missing mandatory actions after forced replenishment")
	}
	if !reflect.DeepEqual(*sim, before) {
		t.Fatal("forced replenishment was applied before its branch was chosen")
	}
	for _, m := range moves {
		move := decodeSimMove(m)
		if !move.Replenish {
			t.Fatal("forced replenishment is missing from the move")
		}
		next := *sim
		next.apply(m)
		expected, err := game.Apply(s, move)
		if err != nil || !reflect.DeepEqual(&next, importSim(expected)) {
			t.Fatalf("forced branch diverged: %+v, %v", move, err)
		}
	}
}

func TestSimGeneratesVoluntaryReplenishment(t *testing.T) {
	s := replenishmentWinPosition()
	sim := importSim(s)
	before := *sim
	var scratch [simMaxMoves]simMove
	moves := sim.ready(scratch[:0])
	ordinary, replenished, winning := 0, 0, false
	for _, m := range moves {
		move := decodeSimMove(m)
		if move.Replenish {
			replenished++
		} else {
			ordinary++
		}
		next := *sim
		next.apply(m)
		expected, err := game.Apply(s, move)
		if err != nil {
			t.Fatalf("illegal search branch %+v: %v", move, err)
		}
		if !reflect.DeepEqual(&next, importSim(expected)) {
			t.Fatalf("simulation diverged from engine for %+v", move)
		}
		if move.Replenish && expected.Winner != nil && *expected.Winner == s.Current {
			winning = true
			if !move.ReplenishFirst || len(move.Privileges) != 1 || expected.Players[1].Privileges != 1 {
				t.Fatalf("wrong replenishment order or privilege cost: %+v", move)
			}
		}
	}
	if ordinary == 0 || replenished == 0 || !winning {
		t.Fatalf("missing ordinary/replenishment branches or replenishment win: ordinary=%d replenished=%d winning=%v", ordinary, replenished, winning)
	}
	if !reflect.DeepEqual(*sim, before) {
		t.Fatal("optional replenishment mutated the parent position")
	}
}
