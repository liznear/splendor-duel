package search

import (
	"context"
	"math"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
	"time"

	"splender/internal/game"
	"splender/internal/session"
)

func singleTokenPosition(t testing.TB) *game.State {
	t.Helper()
	record, err := (session.Store{Dir: "testdata"}).Read("single-token.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	record.Events = record.Events[:len(record.Events)-1]
	s, err := record.Replay()
	if err != nil {
		t.Fatal(err)
	}
	return position(s)
}

func TestRolloutAllocationBudget(t *testing.T) {
	s := singleTokenPosition(t)
	allocations := testing.AllocsPerRun(3, func() {
		simRollout(context.Background(), importSim(s), s.Current, rand.New(rand.NewPCG(3, 4)))
	})
	if allocations > 1000 {
		t.Fatalf("rollout allocates %.0f objects; budget is 1000", allocations)
	}
}

func BenchmarkRollout(b *testing.B) {
	s := singleTokenPosition(b)
	r := rand.New(rand.NewPCG(3, 4))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		simRollout(context.Background(), importSim(s), s.Current, r)
	}
}

func assertSimEqual(t *testing.T, actual *simState, reference *game.State) {
	t.Helper()
	expected := importSim(reference)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("simulation diverged at turn %d\nactual: %+v\nexpected: %+v", reference.Turn, actual, expected)
	}
}

func TestSimMatchesEngine(t *testing.T) {
	r := rand.New(rand.NewPCG(31, 71))
	for seed := int64(0); seed < 12; seed++ {
		reference := game.New(seed, [2]string{"A", "B"}, nil)
		sim := importSim(reference)
		var scratch [simMaxMoves]simMove
		for step := 0; step < 160 && !reference.Over(); step++ {
			moves := sim.moves(scratch[:0])
			referenceMoves := candidates(reference)
			actualKeys := map[string]bool{}
			for _, m := range moves {
				actualKeys[moveKey(decodeSimMove(m))] = true
			}
			if len(moves) != len(referenceMoves) {
				t.Fatalf("seed %d step %d: %d simulated moves vs %d engine moves", seed, step, len(moves), len(referenceMoves))
			}
			for _, m := range referenceMoves {
				if !actualKeys[moveKey(m)] {
					t.Fatalf("missing engine move %+v", m)
				}
			}
			if len(moves) == 0 {
				if len(reference.Bag) == 0 {
					break
				}
				sim.replenish()
				var err error
				reference, err = game.Replenish(reference)
				if err != nil {
					t.Fatal(err)
				}
				assertSimEqual(t, sim, reference)
				continue
			}
			// Check every generated transition, including privilege purchase plans.
			for _, m := range moves {
				next := *sim
				next.apply(m)
				expected, err := game.Apply(reference, decodeSimMove(m))
				if err != nil {
					t.Fatal(err)
				}
				assertSimEqual(t, &next, expected)
			}
			pick := r.IntN(len(moves))
			if seed%2 == 0 {
				best := math.Inf(-1)
				for i, m := range moves {
					value := sim.score(m) + r.Float64()*4
					if value > best {
						best = value
						pick = i
					}
				}
			}
			sim.apply(moves[pick])
			var err error
			reference, err = game.Apply(reference, decodeSimMove(moves[pick]))
			if err != nil {
				t.Fatal(err)
			}
			assertSimEqual(t, sim, reference)
		}
	}
}

func TestSimAbilitiesAndMilestones(t *testing.T) {
	for _, ability := range []string{"turn", "privilege", "steal", "takeSame"} {
		t.Run(ability, func(t *testing.T) {
			s := newState()
			s.Players[0].Crowns = 2
			s.Players[0].Tokens = game.Counts{"black": 4, "red": 3, "green": 2, "gold": 1}
			s.Players[1].Tokens = game.Counts{game.Pearl: 1, "black": 2}
			s.Pyramid[0] = &game.Card{ID: "ability", Color: "green", Bonus: 1, Points: 1, Crowns: 4, Ability: &ability, Cost: game.Counts{}}
			sim := importSim(s)
			m := simMove{action: 2}
			sim.apply(m)
			expected, err := game.Apply(s, decodeSimMove(m))
			if err != nil {
				t.Fatal(err)
			}
			assertSimEqual(t, sim, expected)
		})
	}
}

func TestSimDoesNotMutateInput(t *testing.T) {
	s := singleTokenPosition(t)
	before := s.Clone()
	sim := importSim(s)
	snapshot := *sim
	r := rand.New(rand.NewPCG(3, 4))
	simRollout(context.Background(), sim, s.Current, r)
	if !reflect.DeepEqual(s, before) || !reflect.DeepEqual(sim, &snapshot) {
		t.Fatal("rollout mutated its input")
	}
}

func BenchmarkMCTS(b *testing.B) {
	s := singleTokenPosition(b)
	b.ReportAllocs()
	b.ResetTimer()
	totalVisits := 0
	start := time.Now()
	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		stats := mcts(ctx, s, 3)
		cancel()
		visits := 0
		for _, stat := range stats {
			visits += stat.visits
		}
		totalVisits += visits
	}
	b.ReportMetric(float64(totalVisits)/time.Since(start).Seconds(), "playouts/s")
}

func TestSimPurchases(t *testing.T) {
	for _, scenario := range []string{"pointsWin", "crownsWin", "colorWin", "associate", "goldPayment"} {
		t.Run(scenario, func(t *testing.T) {
			s := newState()
			card := &game.Card{ID: "purchase", Color: "red", Bonus: 1, Points: 1, Cost: game.Counts{}}
			p := &s.Players[0]
			switch scenario {
			case "pointsWin":
				p.Points = 19
			case "crownsWin":
				p.Crowns = 9
				card.Crowns = 1
			case "colorWin":
				p.Cards = []game.Owned{{Def: &game.Card{Points: 9}, Color: "red"}}
			case "associate":
				card.Associate = true
				card.Color = ""
				p.Cards = []game.Owned{{Def: &game.Card{}, Color: "red"}, {Def: &game.Card{}, Color: "green"}}
			case "goldPayment":
				card.Cost = game.Counts{"red": 3, game.Pearl: 2}
				p.Tokens = game.Counts{"red": 1, game.Pearl: 1, game.Gold: 2}
				p.Bonuses["red"] = 1
			}
			s.Pyramid[0] = card
			sim := importSim(s)
			m := simMove{action: 2}
			if !sim.players[0].canBuy(sim.card(m.action)) {
				t.Fatal("simulation rejected affordable purchase")
			}
			if strings.HasSuffix(scenario, "Win") && sim.score(m) != 10000 {
				t.Fatal("immediate win was not prioritized")
			}
			sim.apply(m)
			expected, err := game.Apply(s, decodeSimMove(m))
			if err != nil {
				t.Fatal(err)
			}
			assertSimEqual(t, sim, expected)
		})
	}
}
