// Parallel MCTS uses independent trees owned by goroutines and combines root statistics.
package search

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sync"

	"splender/internal/game"
)

type node struct {
	state    *game.State
	children []*edge
	visits   int
}
type edge struct {
	move   game.Move
	child  *node
	visits int
	wins   float64
}
type rootStat struct {
	move   game.Move
	visits int
	wins   float64
}

func expand(n *node) {
	n.state = ready(n.state)
	if n.state.Over() {
		return
	}
	moves := orderedMoves(n.state)
	for _, m := range moves {
		n.children = append(n.children, &edge{move: m})
	}
}
func rollout(ctx context.Context, s *game.State, seat int, r *rand.Rand) float64 {
	for i := 0; i < 160 && !s.Over(); i++ {
		if ctx.Err() != nil {
			break
		}
		s = ready(s)
		if s.Over() {
			break
		}
		moves := candidates(s)
		if len(moves) == 0 {
			break
		}
		best := moves[0]
		v := math.Inf(-1)
		for _, m := range moves {
			if ctx.Err() != nil {
				break
			}
			n := score(s, m) + r.Float64()*4
			if n > v {
				v = n
				best = m
			}
		}
		next, err := game.Apply(s, best)
		if err != nil {
			break
		}
		next.Log = nil
		s = next
	}
	if s.Winner != nil {
		if *s.Winner == seat {
			return 1
		}
		return 0
	}
	if s.Draw {
		return .5
	}
	return .5 + .45*math.Tanh(symmetric(s, seat)/600)
}
func mcts(ctx context.Context, s *game.State, seed uint64) []rootStat {
	r := rand.New(rand.NewPCG(seed, seed+71))
	root := &node{state: s}
	expand(root)
	for ctx.Err() == nil {
		n := root
		path := []*edge{}
		nodes := []*node{root}
		for !n.state.Over() {
			if n.children == nil {
				expand(n)
			}
			if len(n.children) == 0 {
				break
			}
			var pick *edge
			best := math.Inf(-1)
			for _, e := range n.children {
				uct := math.Inf(1)
				if e.visits > 0 {
					value := e.wins / float64(e.visits)
					if n.state.Current != s.Current {
						value = 1 - value
					}
					uct = value + 1.4*math.Sqrt(math.Log(float64(n.visits+1))/float64(e.visits))
				}
				if uct > best {
					best = uct
					pick = e
				}
			}
			path = append(path, pick)
			fresh := pick.child == nil
			if fresh {
				next, err := game.Apply(n.state, pick.move)
				if err != nil {
					break
				}
				next.Log = nil
				pick.child = &node{state: next}
			}
			n = pick.child
			nodes = append(nodes, n)
			if fresh {
				break
			}
			if ctx.Err() != nil {
				break
			}
		}
		value := rollout(ctx, n.state, s.Current, r)
		if ctx.Err() != nil {
			break
		}
		for _, n := range nodes {
			n.visits++
		}
		for _, e := range path {
			e.visits++
			e.wins += value
		}
	}
	out := []rootStat{}
	for _, e := range root.children {
		out = append(out, rootStat{e.move, e.visits, e.wins})
	}
	return out
}
func parallelMCTS(ctx context.Context, s *game.State, workers int, fallback game.Move) game.Move {
	results := make(chan []rootStat, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := rand.New(rand.NewPCG(uint64(s.Seed)+uint64(i)+1, uint64(s.Turn)+77))
			v := position(s, r)
			results <- mcts(ctx, v, uint64(i)+uint64(s.Turn)*100+3)
		}(i)
	}
	wg.Wait()
	close(results)
	merged := map[string]*rootStat{}
	order := []string{}
	for result := range results {
		for _, r := range result {
			key := moveKey(r.move)
			if merged[key] == nil {
				merged[key] = &rootStat{move: r.move}
				order = append(order, key)
			}
			merged[key].visits += r.visits
			merged[key].wins += r.wins
		}
	}
	visits := 0
	wins := float64(-1)
	for _, key := range order {
		r := merged[key]
		if r.visits > visits || r.visits == visits && r.wins > wins {
			visits = r.visits
			wins = r.wins
			if visits > 0 {
				fallback = r.move
			}
		}
	}
	return fallback
}
func moveKey(m game.Move) string {
	return fmt.Sprintf("%s:%v:%d:%s:%d:%d:%d:%v", m.Action.Kind, m.Action.Cells, m.Action.GoldCell, m.Action.From.Kind, m.Action.From.Slot, m.Action.From.Index, m.Action.From.Level, m.Privileges)
}
