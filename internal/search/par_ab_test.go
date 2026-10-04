package search

import (
	"context"
	"math"
	"reflect"
	"testing"

	"splender/internal/game"
)

func serialRootDepth(ctx context.Context, s *game.State, moves []game.Move, depth int) (game.Move, float64, bool) {
	best, value := moves[0], math.Inf(-1)
	for _, m := range moves {
		next, err := game.Apply(s, m)
		if err != nil {
			continue
		}
		v, complete := minimax(ctx, next, depth-1, math.Inf(-1), math.Inf(1), s.Current)
		if !complete {
			return game.Move{}, 0, false
		}
		if v > value {
			best, value = m, v
		}
	}
	return best, value, true
}

func alphaBetaTestPosition(seed int64) *game.State {
	first := 0
	s := game.New(seed, [2]string{"A", "B"}, &first)
	s.Board = [25]game.Color{}
	s.Board[0], s.Board[1], s.Board[2] = "red", "blue", "green"
	s.Bag = nil
	s.Decks = [3][]*game.Card{}
	s.Pyramid = [12]*game.Card{}
	extra := "turn"
	s.Pyramid[0] = &game.Card{ID: "points", Color: "blue", Bonus: 1, Points: 3, Cost: game.Counts{"blue": 1}}
	s.Pyramid[1] = &game.Card{ID: "extra", Color: "red", Bonus: 1, Ability: &extra, Cost: game.Counts{}}
	s.Pyramid[2] = &game.Card{ID: "crowns", Color: "green", Bonus: 1, Crowns: 3, Cost: game.Counts{}}
	s.Players[0].Privileges = 1
	s.Players[1].Tokens["blue"] = 1
	return s
}

func TestParallelAlphaBetaMatchesSerialDepth(t *testing.T) {
	for seed := int64(0); seed < 3; seed++ {
		s := alphaBetaTestPosition(seed)
		before := s.Clone()
		moves := orderedMoves(s)
		for depth := 1; depth <= 4; depth++ {
			expected, value, ok := serialRootDepth(context.Background(), s, moves, depth)
			if !ok {
				t.Fatal("serial search did not complete")
			}
			for _, workers := range []int{1, 2, 8, 32} {
				actual, v, complete := alphaBetaDepth(context.Background(), s, moves, depth, workers)
				if !complete || v != value || !reflect.DeepEqual(actual, expected) {
					t.Fatalf("seed %d depth %d workers %d: move=%+v value=%v complete=%t; expected=%+v value=%v", seed, depth, workers, actual, v, complete, expected, value)
				}
			}
		}
		if !reflect.DeepEqual(s, before) {
			t.Fatal("parallel search mutated its input")
		}
	}
}

func TestParallelAlphaBetaKeepsFallbackOnCancellation(t *testing.T) {
	s := alphaBetaTestPosition(42)
	fallback := orderedMoves(s)[0]
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if actual := parallelAlphaBeta(ctx, s, 8, fallback); !reflect.DeepEqual(actual, fallback) {
		t.Fatal("cancelled search replaced fallback")
	}
	_, _, complete := alphaBetaDepth(ctx, s, orderedMoves(s), 4, 8)
	if complete {
		t.Fatal("cancelled depth counted as complete")
	}
}

func BenchmarkAlphaBetaRootDepth(b *testing.B) {
	first := 0
	s := game.New(1095041074, [2]string{"A", "B"}, &first)
	s.Log = []string{}
	moves := orderedMoves(s)
	expected, expectedValue, complete := serialRootDepth(context.Background(), s, moves, 2)
	if !complete {
		b.Fatal("reference search did not complete")
	}
	for _, workers := range []int{1, 8} {
		name := "serial"
		if workers > 1 {
			name = "parallel8"
		}
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				var actual game.Move
				var value float64
				var complete bool
				actual, value, complete = alphaBetaDepth(context.Background(), s, moves, 2, workers)
				if !complete || value != expectedValue || !reflect.DeepEqual(actual, expected) {
					b.Fatal("fixed-depth search disagreed with serial reference")
				}
			}
		})
	}
}
