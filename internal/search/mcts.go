// Parallel MCTS uses independent trees owned by goroutines and combines root statistics.
package search

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"slices"
	"sync"

	"splender/internal/game"
)

// Nodes store no state: every simulation replays the root-to-leaf path on a
// scratch simState copy, keeping node memory independent of position size.
type node struct {
	children []*edge
	visits   int
}
type edge struct {
	move   simMove
	child  *node
	visits int
	wins   float64
}
type rootStat struct {
	move   game.Move
	visits int
	wins   float64
}

func expand(n *node, s *simState) {
	if s.over() {
		return
	}
	var scratch [simMaxMoves]simMove
	moves := s.ready(scratch[:0])
	scorer := s.scorer()
	slices.SortStableFunc(moves, func(a, b simMove) int { return cmpScore(scorer.score(b), scorer.score(a)) })
	for _, m := range moves {
		n.children = append(n.children, &edge{move: m})
	}
}
func mcts(ctx context.Context, s *game.State, seed uint64) []rootStat {
	return runMCTS(ctx, &node{}, importSim(s), s.Current, rand.New(rand.NewPCG(seed, seed+71)))
}

func runMCTS(ctx context.Context, root *node, trunk *simState, seat int, r *rand.Rand) []rootStat {
	if root.children == nil {
		expand(root, trunk)
	}
	path := []*edge{}
	nodes := []*node{root}
	for ctx.Err() == nil {
		n := root
		state := *trunk
		path = path[:0]
		nodes = nodes[:1]
		for !state.over() {
			if n.children == nil {
				expand(n, &state)
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
					if state.current != seat {
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
			state.apply(pick.move)
			if fresh {
				pick.child = &node{}
			}
			n = pick.child
			nodes = append(nodes, n)
			if fresh || ctx.Err() != nil {
				break
			}
		}
		value := simRollout(ctx, &state, seat, r)
		if ctx.Err() == nil {
			for _, n := range nodes {
				n.visits++
			}
			for _, e := range path {
				e.visits++
				e.wins += value
			}
		}
	}
	out := []rootStat{}
	for _, e := range root.children {
		out = append(out, rootStat{decodeSimMove(e.move), e.visits, e.wins})
	}
	return out
}

// Session retains one MCTS tree per worker across turns of one match. Workers
// use the actual full state, and retained trees are reused only while their
// state and refill policy match the live game.
//
// A Session belongs to one agent seat of one match. Callers must serialize
// Choose/Step/Reset per seat.
type Session struct {
	workers int
	trees   []*tree
	seat    int
}
type tree struct {
	root  *node
	trunk *simState
}

func NewSession(workers int) *Session {
	if workers < 1 {
		workers = 1
	}
	return &Session{workers: workers, trees: make([]*tree, workers), seat: -1}
}

// Choose is also valid on a nil session, which performs a fresh search.
func (sess *Session) Choose(ctx context.Context, s *game.State, c Config) (game.Move, *Stats, error) {
	return chooseWithStats(ctx, s, c, sess)
}

// initTree restores worker i's tree, discarding any that drifted from the
// live state (a move or option that Step never observed).
func (sess *Session) initTree(i int, s *game.State, includeRefill bool) {
	live := importSim(s)
	live.includeRefill = includeRefill
	t := sess.trees[i]
	if t != nil && !reflect.DeepEqual(t.trunk, live) {
		t = nil
	}
	if t == nil {
		t = &tree{root: &node{}, trunk: live}
		sess.trees[i] = t
	}
}

// Step advances retained trees along an applied move. A tree that never
// explored the move is discarded; its next search starts fresh.
func (sess *Session) Step(m game.Move) {
	key := moveKey(m)
	for i, t := range sess.trees {
		if t == nil {
			continue
		}
		var match *edge
		for _, e := range t.root.children {
			if e.child != nil && moveKey(decodeSimMove(e.move)) == key {
				match = e
				break
			}
		}
		if match == nil {
			sess.trees[i] = nil
			continue
		}
		t.trunk.apply(match.move)
		t.root = match.child
	}
}

// Reset discards all retained trees (used after replenishment and options,
// which change the state without a move the trees could follow).
func (sess *Session) Reset() {
	for i := range sess.trees {
		sess.trees[i] = nil
	}
}
func (sess *Session) searchMCTS(ctx context.Context, s *game.State, includeRefill bool, fallback game.Move) (game.Move, *Stats) {
	if sess.seat != s.Current {
		sess.Reset()
		sess.seat = s.Current
	}
	results := make(chan []rootStat, sess.workers)
	var wg sync.WaitGroup
	for i := 0; i < sess.workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sess.initTree(i, s, includeRefill)
			sd := uint64(i) + uint64(s.Turn)*100 + 3
			results <- runMCTS(ctx, sess.trees[i].root, sess.trees[i].trunk, s.Current, rand.New(rand.NewPCG(sd, sd+71)))
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
	stats := &Stats{}
	if len(order) > 0 {
		// Root moves are score ordered and obey the MCTS action policy even
		// when the deadline leaves no time to complete a simulation.
		fallback = merged[order[0]].move
	}
	for _, key := range order {
		r := merged[key]
		stats.Simulations += r.visits
		if r.visits > visits || r.visits == visits && r.wins > wins {
			visits = r.visits
			wins = r.wins
			if visits > 0 {
				fallback = r.move
			}
		}
	}
	stats.MoveSimulations = visits
	if visits > 0 {
		rate := wins / float64(visits)
		stats.WinRate = &rate
	}
	return fallback, stats
}
func moveKey(m game.Move) string {
	return fmt.Sprintf("%s:%v:%d:%s:%d:%d:%d:%v:%t:%t", m.Action.Kind, m.Action.Cells, m.Action.GoldCell, m.Action.From.Kind, m.Action.From.Slot, m.Action.From.Index, m.Action.From.Level, m.Privileges, m.Replenish, m.ReplenishFirst)
}
