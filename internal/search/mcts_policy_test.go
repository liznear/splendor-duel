package search

import (
	"context"
	"testing"

	"splender/internal/game"
)

func TestMCTSRestrictedVoluntaryRefill(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cells int
		buy   string
		want  bool
	}{
		{"three tokens", 3, "", true},
		{"four tokens", 4, "", false},
		{"ordinary purchase", 3, "ordinary", false},
		{"reserved purchase", 3, "reserved", false},
		{"privilege purchase", 3, "privilege", false},
		{"forced despite purchase restriction", 0, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := importSim(replenishmentWinPosition())
			for i := range s.board {
				s.board[i] = simEmpty
			}
			for i := 0; i < tc.cells; i++ {
				s.board[i] = 0
			}
			// Gold does not count toward the refill threshold.
			if tc.cells > 0 {
				s.board[24] = simGold
			}
			s.players[0].privileges = 0
			s.pyramid[0].cost = [6]int{1}
			switch tc.buy {
			case "ordinary":
				s.players[0].tokens[0] = 1
			case "reserved":
				s.players[0].reserved[0] = s.pyramid[0]
				s.players[0].reservedN = 1
				s.pyramid[0] = nil
				s.players[0].tokens[simGold] = 1
			case "privilege":
				s.players[0].privileges = 1
			}
			var scratch [simMaxMoves]simMove
			found := false
			for _, m := range s.ready(scratch[:0]) {
				found = found || m.replenish
			}
			if found != tc.want {
				t.Fatalf("refill=%v, want %v", found, tc.want)
			}
		})
	}
}

func TestSimVoluntaryRefillOpensAfterTurn30(t *testing.T) {
	base := func() *simState {
		s := importSim(replenishmentWinPosition())
		for i := range s.board {
			s.board[i] = simEmpty
		}
		for i := 0; i < 10; i++ {
			s.board[i] = i % 5
		}
		s.pyramid[0].cost = [6]int{} // an ordinary buy stays available
		return s
	}
	var scratch [simMaxMoves]simMove
	for _, tc := range []struct {
		turn int
		want bool
	}{{29, false}, {30, true}} {
		s := base()
		s.turn = tc.turn
		found := false
		for _, m := range s.ready(scratch[:0]) {
			found = found || m.replenish
		}
		if found != tc.want {
			t.Fatalf("turn %d: refill=%v, want %v", tc.turn, found, tc.want)
		}
	}
}

func TestMCTSOnlyTakesMaximumAvailableTokens(t *testing.T) {
	for _, cells := range [][]int{{0, 1, 2, 24}, {0, 1, 24}, {0, 24}} {
		s := importSim(replenishmentWinPosition())
		for i := range s.board {
			s.board[i] = simEmpty
		}
		for i, cell := range cells {
			s.board[cell] = i % 5
		}
		s.bagN = 0
		want := len(cells) - 1
		var scratch [simMaxMoves]simMove
		moves := s.ready(scratch[:0])
		found := false
		for _, m := range moves {
			a := decodeSimMove(m).Action
			if a.Kind == "take" {
				found = true
				if len(a.Cells) != want {
					t.Fatalf("board %v: take %v, want %d tokens", cells, a.Cells, want)
				}
			}
		}
		if !found {
			t.Fatal("removed every take action")
		}
		root := &node{}
		expand(root, s)
		for _, e := range root.children {
			a := decodeSimMove(e.move).Action
			if a.Kind == "take" && len(a.Cells) != want {
				t.Fatalf("tree retained a short take: %+v", a)
			}
		}
	}
}

func TestMCTSFiltersTakesOnEachReplenishmentBoard(t *testing.T) {
	s := replenishmentWinPosition()
	s.Board = [25]game.Color{}
	s.Board[24] = "blue"
	s.Bag = []game.Color{"red", "green", "black", "white", "blue"}
	s.Players[0].Privileges = 0
	sim := importSim(s)
	var scratch [simMaxMoves]simMove
	ordinary, replenished := false, false
	for _, m := range sim.ready(scratch[:0]) {
		a := decodeSimMove(m).Action
		if a.Kind != "take" {
			continue
		}
		want := 1
		if m.replenish {
			want = 3
			replenished = true
		} else {
			ordinary = true
		}
		if len(a.Cells) != want {
			t.Fatalf("refill=%v: take %v, want %d", m.replenish, a.Cells, want)
		}
	}
	if !ordinary || !replenished {
		t.Fatal("missing ordinary or replenished takes")
	}
}

func TestMCTSZeroSimulationFallbackUsesMaximumTake(t *testing.T) {
	s := replenishmentWinPosition()
	s.Board = [25]game.Color{}
	for i, cell := range []int{0, 1, 2, 24} {
		s.Board[cell] = game.Colors[i]
	}
	s.Bag = nil
	s.Players[0].Privileges = 0
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fallback := game.Move{Action: game.Action{Kind: "take", Cells: []int{24}}}
	m, stats := NewSession(1).searchMCTS(ctx, s, DefaultRefillTurn, fallback)
	if m.Action.Kind != "take" || len(m.Action.Cells) != 3 || stats.Simulations != 0 {
		t.Fatalf("invalid zero-simulation fallback: %+v, %+v", m, stats)
	}
	if _, err := game.Apply(s, m); err != nil {
		t.Fatal(err)
	}
}

func TestMCTSSmallerTakesAvoidPrivilege(t *testing.T) {
	for _, tc := range []struct {
		name      string
		colors    []int
		wantSmall bool
	}{
		{"three matching colors", []int{0, 0, 0}, true},
		{"two pearls", []int{simPearl, simPearl}, true},
		{"two pearls in triple", []int{simPearl, simPearl, 0}, true},
		{"mixed triple", []int{0, 1, 2}, false},
		{"safe maximum also available", []int{0, 0, 0, 1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := importSim(replenishmentWinPosition())
			s.bagN = 0
			for i := range s.board {
				s.board[i] = simEmpty
			}
			for i, color := range tc.colors {
				s.board[i] = color
			}
			root := &node{}
			expand(root, s)
			maximum := min(3, len(tc.colors))
			small, large := false, false
			for _, e := range root.children {
				a := decodeSimMove(e.move).Action
				if a.Kind != "take" {
					continue
				}
				small = small || len(a.Cells) < maximum
				large = large || len(a.Cells) == maximum
			}
			if small != tc.wantSmall || !large {
				t.Fatalf("smaller takes=%v, want %v; maximum takes=%v", small, tc.wantSmall, large)
			}
		})
	}
}

func TestMCTSReplenishedSmallerTakesAvoidPrivilege(t *testing.T) {
	s := replenishmentWinPosition()
	s.Board = [25]game.Color{}
	s.Board[24] = "blue"
	s.Bag = []game.Color{"red", "red", "red", "red", "red"}
	s.Players[0].Privileges = 0
	sim := importSim(s)
	var scratch [simMaxMoves]simMove
	sizes := [4]bool{}
	for _, m := range sim.ready(scratch[:0]) {
		a := decodeSimMove(m).Action
		if m.replenish && a.Kind == "take" {
			sizes[len(a.Cells)] = true
		}
	}
	if !sizes[1] || !sizes[2] || !sizes[3] {
		t.Fatalf("replenished board lost take sizes: %v", sizes)
	}
}
