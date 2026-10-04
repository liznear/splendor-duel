package search

import (
	"context"
	"splender/internal/game"
	"testing"
	"time"
)

func TestParallelAlphaBetaChoose(t *testing.T) {
	for _, winning := range []bool{false, true} {
		s := alphaBetaTestPosition(42)
		if winning {
			s.Pyramid[0] = &game.Card{ID: "win", Points: 20, Cost: game.Counts{}}
		}
		cfg, err := Parse("ab/8@30")
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		move, err := Choose(context.Background(), s, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if time.Since(start) > time.Second {
			t.Fatal("parallel search exceeded cancellation grace")
		}
		next, err := game.Apply(s, move)
		if err != nil {
			t.Fatal(err)
		}
		if winning && next.Winner == nil {
			t.Fatal("missed immediate win")
		}
	}
	s := alphaBetaTestPosition(42)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Choose(ctx, s, Config{Kind: "alpha-beta", Parallelism: 8}); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestParallelAlphaBetaParentCancellation(t *testing.T) {
	first := 0
	s := game.New(42, [2]string{"A", "B"}, &first)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(30*time.Millisecond, cancel)
	defer timer.Stop()
	started := time.Now()
	_, err := Choose(ctx, s, Config{Kind: "alpha-beta", Parallelism: 8, TimeMS: 5000})
	if err != context.Canceled {
		t.Fatalf("expected parent cancellation, got %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("workers did not stop promptly")
	}
}
