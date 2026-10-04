// Package search provides greedy, alpha-beta and MCTS local agents.
package search

import (
	"context"
	"errors"
	"math/rand/v2"
	"time"

	"splender/internal/game"
)

func Choose(ctx context.Context, s *game.State, c Config) (game.Move, error) {
	if s.Over() {
		return game.Move{}, errors.New("game over")
	}
	c, err := Normalize(c)
	if err != nil {
		return game.Move{}, err
	}
	if ctx.Err() != nil {
		return game.Move{}, ctx.Err()
	}
	searchCtx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeMS)*time.Millisecond)
	defer cancel()
	r := rand.New(rand.NewPCG(uint64(s.Seed)+uint64(s.Turn), uint64(s.Current)+42))
	v := position(s, r)
	fallback, err := greedy(searchCtx, v)
	if err != nil {
		return game.Move{}, err
	}
	if score(v, fallback) >= 1e9 || c.Kind == "greedy" {
		if ctx.Err() != nil {
			return game.Move{}, ctx.Err()
		}
		return fallback, nil
	}
	switch c.Kind {
	case "alpha-beta":
		fallback = alphaBeta(searchCtx, v, fallback)
	case "mcts":
		fallback = parallelMCTS(searchCtx, v, c.Parallelism, fallback)
	}
	if ctx.Err() != nil {
		return game.Move{}, ctx.Err()
	}
	return fallback, nil
}
