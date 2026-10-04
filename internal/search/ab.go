package search

import (
	"context"
	"math"

	"splender/internal/game"
)

func alphaBeta(ctx context.Context, s *game.State, fallback game.Move) game.Move {
	moves := orderedMoves(s)
	for depth := 1; depth <= 4; depth++ {
		best := fallback
		v := math.Inf(-1)
		complete := true
		for _, m := range moves {
			if ctx.Err() != nil {
				complete = false
				break
			}
			n, err := game.Apply(s, m)
			if err != nil {
				continue
			}
			value, ok := minimax(ctx, n, depth-1, math.Inf(-1), math.Inf(1), s.Current)
			if !ok {
				complete = false
				break
			}
			if value > v {
				v = value
				best = m
			}
		}
		if !complete {
			break
		}
		fallback = best
		if v >= 1e9 {
			break
		}
	}
	return refine(ctx, s, fallback)
}
func cmpScore(a, b float64) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}
func minimax(ctx context.Context, s *game.State, depth int, alpha, beta float64, seat int) (float64, bool) {
	if ctx.Err() != nil {
		return 0, false
	}
	s = ready(s)
	if depth == 0 || s.Over() {
		return symmetric(s, seat), true
	}
	moves := orderedMoves(s)
	maximize := s.Current == seat
	best := math.Inf(1)
	if maximize {
		best = math.Inf(-1)
	}
	for _, m := range moves {
		n, err := game.Apply(s, m)
		if err != nil {
			continue
		}
		v, ok := minimax(ctx, n, depth-1, alpha, beta, seat)
		if !ok {
			return 0, false
		}
		if maximize {
			best = max(best, v)
			alpha = max(alpha, best)
		} else {
			best = min(best, v)
			beta = min(beta, best)
		}
		if alpha >= beta {
			break
		}
	}
	return best, true
}
