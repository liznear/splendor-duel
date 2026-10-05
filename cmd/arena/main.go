// Arena runs local matches in goroutines for repeatable agent comparisons.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"

	"splender/internal/game"
	"splender/internal/search"
)

type result struct {
	index  int
	winner *int
	draw   bool
	turns  int
	sims   [2]int
	err    error
}

func play(ctx context.Context, index int, seed int64, agents [2]search.Config, reuse bool) result {
	first := 0
	s := game.New(seed, [2]string{"A", "B"}, &first)
	r := result{index: index}
	var sess [2]*search.Session
	if reuse {
		for i := range agents {
			if agents[i].Kind == "mcts" {
				sess[i] = search.NewSession(agents[i].Parallelism)
			}
		}
	}
	for turns := 0; turns < 600 && !s.Over(); turns++ {
		l := game.LegalMoves(s)
		if l.MustReplenish {
			if !l.CanReplenish {
				s.Draw = true
				break
			}
			var err error
			s, err = game.Replenish(s)
			if err != nil {
				return result{index: index, err: err}
			}
			for _, x := range sess {
				if x != nil {
					x.Reset()
				}
			}
		}
		var m game.Move
		var stats *search.Stats
		var err error
		if sess[s.Current] != nil {
			m, stats, err = sess[s.Current].Choose(ctx, s, agents[s.Current])
		} else {
			m, stats, err = search.ChooseWithStats(ctx, s, agents[s.Current])
		}
		if err != nil {
			return result{index: index, err: err}
		}
		if stats != nil {
			r.sims[s.Current] += stats.Simulations
		}
		s, err = game.Apply(s, m)
		if err != nil {
			return result{index: index, err: err}
		}
		for _, x := range sess {
			if x != nil {
				x.Step(m)
			}
		}
	}
	r.winner, r.draw, r.turns = s.Winner, s.Draw || s.Winner == nil, s.Turn
	return r
}
func main() {
	games := flag.Int("games", 10, "number of games")
	jobs := flag.Int("jobs", 1, "concurrent matches")
	aSpec := flag.String("a", "mcts@1000", "subject agent")
	bSpec := flag.String("baseline", "greedy", "baseline agent")
	seed := flag.Int64("seed", 1000, "first game seed")
	reuse := flag.Bool("reuse", true, "retain MCTS subtrees across turns")
	flag.Parse()
	if *games < 1 || *jobs < 1 {
		log.Fatal("games and jobs must be positive")
	}
	a, err := search.Parse(*aSpec)
	if err != nil {
		log.Fatal(err)
	}
	b, err := search.Parse(*bSpec)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	queue := make(chan int)
	results := make(chan result, min(*jobs, *games))
	var wg sync.WaitGroup
	for n := 0; n < min(*jobs, *games); n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range queue {
				agents := [2]search.Config{a, b}
				if i%2 == 1 {
					agents = [2]search.Config{b, a}
				}
				results <- play(ctx, i, *seed+int64(i)*7919, agents, *reuse)
			}
		}()
	}
	go func() {
		defer close(queue)
		for i := 0; i < *games; i++ {
			select {
			case queue <- i:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { wg.Wait(); close(results) }()
	wins, losses, draws, failures := 0, 0, 0, 0
	totals := [2]int64{} // simulations per seat
	moves := [2]int64{}
	for r := range results {
		if r.err != nil {
			failures++
			fmt.Printf("game %d: %v\n", r.index+1, r.err)
			continue
		}
		for seat := range totals {
			agent := seat // agent a occupies seat index%2 (arena swaps seats on odd games)
			if r.index%2 == 1 {
				agent = 1 - seat
			}
			totals[agent] += int64(r.sims[seat])
			moves[agent] += int64(r.turns+1) / 2
		}
		if r.draw {
			draws++
		} else if *r.winner == r.index%2 {
			wins++
		} else {
			losses++
		}
		// Agent a occupies seat index%2; report the winning agent, not the seat.
		label := "none"
		if !r.draw {
			label = "b"
			if *r.winner == r.index%2 {
				label = "a"
			}
		}
		fmt.Printf("game %d: winner=%s draw=%t turns=%d\n", r.index+1, label, r.draw, r.turns)
	}
	fmt.Printf("%s vs %s: %d wins, %d losses, %d draws, %d errors\n", *aSpec, *bSpec, wins, losses, draws, failures)
	if moves[0] > 0 && moves[1] > 0 {
		fmt.Printf("avg sims/move: %s=%.0f, %s=%.0f\n", *aSpec, float64(totals[0])/float64(moves[0]), *bSpec, float64(totals[1])/float64(moves[1]))
	}
	if failures > 0 {
		os.Exit(1)
	}
}
