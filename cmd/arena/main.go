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
	err    error
}

func play(ctx context.Context, index int, seed int64, agents [2]search.Config, reuse bool) result {
	first := 0
	s := game.New(seed, [2]string{"A", "B"}, &first)
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
		var err error
		if sess[s.Current] != nil {
			m, _, err = sess[s.Current].Choose(ctx, s, agents[s.Current])
		} else {
			m, err = search.Choose(ctx, s, agents[s.Current])
		}
		if err != nil {
			return result{index: index, err: err}
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
	return result{index, s.Winner, s.Draw || s.Winner == nil, s.Turn, nil}
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
	for r := range results {
		if r.err != nil {
			failures++
			fmt.Printf("game %d: %v\n", r.index+1, r.err)
			continue
		}
		if r.draw {
			draws++
		} else if *r.winner == r.index%2 {
			wins++
		} else {
			losses++
		}
		fmt.Printf("game %d: winner=%v draw=%t turns=%d\n", r.index+1, winnerText(r.winner), r.draw, r.turns)
	}
	fmt.Printf("%s vs %s: %d wins, %d losses, %d draws, %d errors\n", *aSpec, *bSpec, wins, losses, draws, failures)
	if failures > 0 {
		os.Exit(1)
	}
}
func winnerText(winner *int) any {
	if winner == nil {
		return "none"
	}
	return *winner
}
