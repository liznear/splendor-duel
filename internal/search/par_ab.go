package search

import (
	"context"
	"math"
	"sync"

	"splender/internal/game"
)

// Both variants use the same iterative-deepening driver and exact root values.
// One worker searches root moves directly; multiple workers distribute them.
func parallelAlphaBeta(ctx context.Context, s *game.State, workers int, fallback game.Move) game.Move {
	return searchAlphaBeta(ctx, s, workers, fallback)
}

func searchAlphaBeta(ctx context.Context, s *game.State, workers int, fallback game.Move) game.Move {
	moves := orderedMoves(s)
	for depth := 1; depth <= 4; depth++ {
		best, value, complete := alphaBetaDepth(ctx, s, moves, depth, workers)
		if !complete {
			break
		}
		fallback = best
		if value >= 1e9 {
			break
		}
	}
	return refine(ctx, s, fallback)
}

func alphaBetaDepth(ctx context.Context, s *game.State, moves []game.Move, depth, workers int) (game.Move, float64, bool) {
	if ctx.Err() != nil || len(moves) == 0 {
		return game.Move{}, 0, false
	}
	if workers <= 1 {
		best, value := moves[0], math.Inf(-1)
		for _, move := range moves {
			if ctx.Err() != nil {
				return game.Move{}, 0, false
			}
			v, complete := alphaBetaRootValue(ctx, s, move, depth)
			if !complete {
				return game.Move{}, 0, false
			}
			if v > value {
				best, value = move, v
			}
		}
		return best, value, true
	}
	type result struct {
		value    float64
		complete bool
	}
	results := make([]result, len(moves))
	jobs := make(chan int, len(moves))
	for i := range moves {
		jobs <- i
	}
	close(jobs)
	var wg sync.WaitGroup
	for worker := 0; worker < min(workers, len(moves)); worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if ctx.Err() != nil {
					return
				}
				value, complete := alphaBetaRootValue(ctx, s, moves[i], depth)
				results[i] = result{value, complete}
				if !complete {
					return
				}
			}
		}()
	}
	wg.Wait()
	best, value := moves[0], math.Inf(-1)
	for i, r := range results {
		if !r.complete {
			return game.Move{}, 0, false
		}
		if r.value > value {
			best, value = moves[i], r.value
		}
	}
	return best, value, true
}

func alphaBetaRootValue(ctx context.Context, s *game.State, move game.Move, depth int) (float64, bool) {
	next, err := game.Apply(s, move)
	if err != nil {
		return math.Inf(-1), true
	}
	return minimax(ctx, next, depth-1, math.Inf(-1), math.Inf(1), s.Current)
}
