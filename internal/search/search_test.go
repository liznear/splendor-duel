package search

import (
	"context"
	"reflect"
	"testing"
	"time"

	"splender/internal/game"
)

func newState() *game.State { first := 0; return game.New(42, [2]string{"A", "B"}, &first) }
func TestConfigs(t *testing.T) {
	for _, spec := range []string{"greedy", "ab@20", "mcts@20", "mcts2@20", "par-mcts2@20"} {
		if _, err := Parse(spec); err != nil {
			t.Errorf("%s: %v", spec, err)
		}
	}
	for _, spec := range []string{"llm", "random", "ab@NaN", "mcts@-10", "ab@120001", "mcts@1@2"} {
		if _, err := Parse(spec); err == nil {
			t.Errorf("accepted %s", spec)
		}
	}
}
func TestAgentsChooseLegalMoves(t *testing.T) {
	for _, kind := range []string{"greedy", "alpha-beta", "mcts"} {
		t.Run(kind, func(t *testing.T) {
			s := newState()
			for step := 0; step < 5; step++ {
				cfg := Config{Kind: kind, TimeMS: 35}
				if kind == "mcts" {
					cfg.Parallelism = 2
				}
				m, err := Choose(context.Background(), s, cfg)
				if err != nil {
					t.Fatal(err)
				}
				s, err = game.Apply(s, m)
				if err != nil {
					t.Fatalf("illegal move: %+v: %v", m, err)
				}
			}
		})
	}
}
func TestImmediateWin(t *testing.T) {
	for _, kind := range []string{"greedy", "alpha-beta", "mcts"} {
		s := newState()
		s.Pyramid[0] = &game.Card{ID: "win", Level: 3, Points: 20, Cost: game.NewCounts(game.Colors[:6])}
		m, err := Choose(context.Background(), s, Config{Kind: kind, TimeMS: 20})
		if err != nil {
			t.Fatal(err)
		}
		n, err := game.Apply(s, m)
		if err != nil || n.Winner == nil {
			t.Fatalf("%s missed win: %+v", kind, m)
		}
	}
}
func TestPrivilegesUnlockPurchase(t *testing.T) {
	s := newState()
	s.Players[0].Privileges = 1
	s.Pyramid[0] = &game.Card{ID: "win", Level: 3, Points: 20, Cost: game.Counts{"red": 1}}
	s.Board[0] = "red"
	m, err := Choose(context.Background(), s, Config{Kind: "greedy"})
	if err != nil {
		t.Fatal(err)
	}
	n, err := game.Apply(s, m)
	if err != nil || n.Winner == nil {
		t.Fatalf("missed privilege win: %+v", m)
	}
}
func TestCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Choose(ctx, newState(), Config{Kind: "mcts"})
	if err != context.Canceled {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	time.AfterFunc(15*time.Millisecond, cancel)
	start := time.Now()
	_, err = Choose(ctx, newState(), Config{Kind: "mcts", TimeMS: 5000, Parallelism: 2})
	if err != context.Canceled {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancellation stalled")
	}
}
func TestSearchPreservesFullState(t *testing.T) {
	s := newState()
	s.Bag = []game.Color{"blue", "red"}
	blind := *s.Decks[0][len(s.Decks[0])-1]
	blind.Blind = true
	s.Players[1].Reserved = []*game.Card{&blind}
	s.Decks[0] = s.Decks[0][:len(s.Decks[0])-1]
	s.Log = []string{"history"}
	v := position(s)
	expected := s.Clone()
	expected.Log = []string{}
	if !reflect.DeepEqual(v, expected) {
		t.Fatal("search changed deck, bag, RNG, or private reservation")
	}
	v.Board[0] = ""
	v.Bag[0] = game.Gold
	v.Decks[0][0] = nil
	v.Players[1].Reserved[0] = nil
	if !reflect.DeepEqual(s.Board, expected.Board) || !reflect.DeepEqual(s.Bag, expected.Bag) || !reflect.DeepEqual(s.Decks, expected.Decks) || !reflect.DeepEqual(s.Players, expected.Players) {
		t.Fatal("search position shares mutable state with the live game")
	}
}

func TestAgentsReserveActualWinningDeckCard(t *testing.T) {
	for _, spec := range []string{"greedy", "alpha-beta", "mcts", "mcts/8"} {
		t.Run(spec, func(t *testing.T) {
			s := newState()
			s.Board = [25]game.Color{}
			s.Board[0], s.Board[1] = game.Gold, "blue"
			s.Bag = nil
			s.Pyramid = [12]*game.Card{}
			s.Decks = [3][]*game.Card{
				{{ID: "unaffordable", Level: 1, Color: "red", Cost: game.Counts{"red": 99}}},
				{{ID: "winning", Level: 2, Color: "blue", Points: 20, Cost: game.Counts{}}},
				nil,
			}
			s.Players[1].Privileges = 0
			before := s.Clone()
			config, err := Parse(spec + "@200")
			if err != nil {
				t.Fatal(err)
			}
			move, err := Choose(context.Background(), s, config)
			if err != nil {
				t.Fatal(err)
			}
			if move.Action.Kind != "reserve" || move.Action.From.Kind != "deck" || move.Action.From.Level != 2 {
				t.Fatalf("did not reserve the actual winning top card: %+v", move)
			}
			if !reflect.DeepEqual(s, before) {
				t.Fatal("search mutated the live game")
			}
		})
	}
}
func TestGreedyGamesFinish(t *testing.T) {
	for seed := int64(0); seed < 5; seed++ {
		s := game.New(seed, [2]string{"A", "B"}, nil)
		for step := 0; step < 600 && !s.Over(); step++ {
			s = ready(s)
			if s.Over() {
				break
			}
			m, err := Choose(context.Background(), s, Config{Kind: "greedy"})
			if err != nil {
				t.Fatal(err)
			}
			s, err = game.Apply(s, m)
			if err != nil {
				t.Fatal(err)
			}
		}
		if !s.Over() {
			t.Fatalf("seed %d failed to finish", seed)
		}
	}
}

func TestMCTSBackpropagatesCompletedPlayouts(t *testing.T) {
	s := newState()
	s.Board = [25]game.Color{}
	s.Board[0] = "blue"
	s.Bag = []game.Color{}
	s.Pyramid = [12]*game.Card{}
	s.Decks = [3][]*game.Card{{}, {}, {}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	stats := mcts(ctx, s, 3)
	if len(stats) != 1 || stats[0].visits == 0 || stats[0].wins != float64(stats[0].visits)/2 {
		t.Fatalf("draw playouts were not propagated: %+v", stats)
	}
}
