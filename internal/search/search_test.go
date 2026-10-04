package search

import (
	"context"
	"math/rand/v2"
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
func TestSearchDoesNotUseRealDeckOrder(t *testing.T) {
	s := newState()
	altered := s.Clone()
	for _, deck := range altered.Decks {
		for i, j := 0, len(deck)-1; i < j; i, j = i+1, j-1 {
			deck[i], deck[j] = deck[j], deck[i]
		}
	}
	altered.RNGState = 1
	a := position(s, rand.New(rand.NewPCG(1, 2)))
	b := position(altered, rand.New(rand.NewPCG(1, 2)))
	if !reflect.DeepEqual(a, b) {
		t.Fatal("search reads private order or RNG")
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
