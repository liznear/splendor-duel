// Package search provides greedy, alpha-beta and MCTS local agents.
package search

import (
	"context"
	"errors"
	"time"

	"splender/internal/game"
)

func Choose(ctx context.Context, s *game.State, c Config) (game.Move, error) {
	move, _, err := ChooseWithStats(ctx, s, c)
	return move, err
}

// Stats describes the last completed MCTS search from the acting player's perspective.
// WinRate is the selected move's average rollout reward: wins score 1, draws .5,
// and unfinished rollouts use the position evaluation. It is an estimate, not a calibrated probability.
type Stats struct {
	Simulations     int      `json:"simulations"`
	MoveSimulations int      `json:"moveSimulations"`
	WinRate         *float64 `json:"winRate"`
	// Reply is the opponent's best sampled response to the selected move,
	// read from the second tree level at no extra search cost. It is the
	// searcher's model of the opponent, not a certified minimax reply.
	Reply *game.Move `json:"reply,omitempty"`
}

func ChooseWithStats(ctx context.Context, s *game.State, c Config) (game.Move, *Stats, error) {
	return chooseWithStats(ctx, s, c, nil)
}

func chooseWithStats(ctx context.Context, s *game.State, c Config, sess *Session) (game.Move, *Stats, error) {
	if s.Over() {
		return game.Move{}, nil, errors.New("game over")
	}
	c, err := Normalize(c)
	if err != nil {
		return game.Move{}, nil, err
	}
	if ctx.Err() != nil {
		return game.Move{}, nil, ctx.Err()
	}
	searchCtx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeMS)*time.Millisecond)
	defer cancel()
	v := position(s)
	fallback, err := greedy(searchCtx, v)
	if err != nil {
		return game.Move{}, nil, err
	}
	var stats *Stats
	if c.Kind == "mcts" {
		stats = &Stats{}
	}
	if score(v, fallback) >= 1e9 || c.Kind == "greedy" {
		if ctx.Err() != nil {
			return game.Move{}, nil, ctx.Err()
		}
		return fallback, stats, nil
	}
	switch c.Kind {
	case "alpha-beta":
		if c.Parallelism > 1 {
			fallback = parallelAlphaBeta(searchCtx, v, c.Parallelism, fallback)
		} else {
			fallback = alphaBeta(searchCtx, v, fallback)
		}
	case "mcts":
		if sess == nil {
			sess = NewSession(c.Parallelism)
		} else if sess.workers != c.Parallelism {
			sess.workers = c.Parallelism
			sess.trees = make([]*tree, c.Parallelism)
			sess.seat = -1
		}
		fallback, stats = sess.searchMCTS(searchCtx, v, c.RefillTurn, fallback)
	}
	if ctx.Err() != nil {
		return game.Move{}, nil, ctx.Err()
	}
	return fallback, stats, nil
}
