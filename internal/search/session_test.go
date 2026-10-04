package search

import (
	"context"
	"testing"
	"time"

	"splender/internal/game"
)

func ctxMS(ms int) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), time.Duration(ms)*time.Millisecond)
}

// A session that has searched must retain, not rebuild, the subtree under the
// move it just played.
func TestSessionStepKeepsSubtree(t *testing.T) {
	s := newState()
	sess := NewSession(1)
	ctx, cancel := ctxMS(500)
	defer cancel()
	move, _, err := sess.Choose(ctx, s, Config{Kind: "mcts", TimeMS: 60})
	if err != nil {
		t.Fatal(err)
	}
	tr := sess.trees[0]
	if tr == nil || tr.root == nil {
		t.Fatal("no tree retained after search")
	}
	key := moveKey(move)
	var child *node
	for _, e := range tr.root.children {
		if e.child != nil && moveKey(decodeSimMove(e.move)) == key {
			child = e.child
			break
		}
	}
	if child == nil {
		t.Fatal("chosen move has no explored root child")
	}
	turn := tr.trunk.turn
	sess.Step(move)
	if sess.trees[0].root != child {
		t.Fatal("Step did not re-root to the played child")
	}
	if sess.trees[0].trunk.turn != turn+1 {
		t.Fatalf("trunk turn %d, want %d", sess.trees[0].trunk.turn, turn+1)
	}
}

// A move the tree never explored discards the tree.
func TestSessionStepMismatchResets(t *testing.T) {
	s := newState()
	sess := NewSession(1)
	trunk := importSim(s)
	var scratch [simMaxMoves]simMove
	m := trunk.ready(scratch[:0])[0]
	// The move is legal, but its child has never been explored.
	sess.trees[0] = &tree{trunk: trunk, root: &node{children: []*edge{{move: m}}}}
	sess.Step(decodeSimMove(m))
	if sess.trees[0] != nil {
		t.Fatal("mismatching Step must discard the tree")
	}
}

// A turn jump the tree did not follow (missed Step) must reset, not corrupt.
func TestSessionDriftGuardResets(t *testing.T) {
	s := newState()
	sess := NewSession(1)
	ctx, cancel := ctxMS(500)
	defer cancel()
	move, _, err := sess.Choose(ctx, s, Config{Kind: "mcts", TimeMS: 60})
	if err != nil {
		t.Fatal(err)
	}
	before := sess.trees[0].root
	next, err := game.Apply(s, move)
	if err != nil {
		t.Fatal(err)
	}
	// no Step: the tree is now one ply behind the real state
	ctx2, cancel2 := ctxMS(500)
	defer cancel2()
	if _, _, err := sess.Choose(ctx2, next, Config{Kind: "mcts", TimeMS: 60}); err != nil {
		t.Fatal(err)
	}
	if sess.trees[0].root == before {
		t.Fatal("stale tree survived the turn-drift guard")
	}
}

// Changes to private state invalidate the tree even without a turn change.
func TestSessionSameTurnStateChangeResets(t *testing.T) {
	s := newState()
	sess := NewSession(1)
	c := Config{Kind: "mcts", TimeMS: 20}
	if _, _, err := sess.Choose(context.Background(), s, c); err != nil {
		t.Fatal(err)
	}
	before := sess.trees[0].root
	s.RNGState++
	if _, _, err := sess.Choose(context.Background(), s, c); err != nil {
		t.Fatal(err)
	}
	if sess.trees[0].root == before || sess.trees[0].trunk.rngState != s.RNGState {
		t.Fatal("retained tree ignored a same-turn full-state change")
	}
}

// Full games through a retained session stay legal and terminate.
func TestSessionFullGamesLegal(t *testing.T) {
	for _, workers := range []int{1, 3} {
		sess := [2]*Session{NewSession(workers), nil}
		cfg := [2]Config{{Kind: "mcts", Parallelism: workers, TimeMS: 10}, {Kind: "greedy"}}
		first := 0
		s := game.New(7, [2]string{"A", "B"}, &first)
		for turns := 0; turns < 400 && !s.Over(); turns++ {
			l := game.LegalMoves(s)
			if l.MustReplenish {
				if !l.CanReplenish {
					s.Draw = true
					break
				}
				r, err := game.Replenish(s)
				if err != nil {
					t.Fatal(err)
				}
				sess[0].Reset()
				s = r
				continue
			}
			seat := s.Current
			ctx, cancel := ctxMS(cfg[seat].TimeMS + 100)
			move, _, err := sess[seat].Choose(ctx, s, cfg[seat])
			cancel()
			if err != nil {
				t.Fatalf("turn %d seat %d: %v", turns, seat, err)
			}
			next, err := game.Apply(s, move)
			if err != nil {
				t.Fatalf("turn %d seat %d illegal move %v: %v", turns, seat, move, err)
			}
			sess[0].Step(move)
			s = next
		}
		if !s.Over() {
			t.Fatalf("workers=%d: game did not terminate", workers)
		}
	}
}
