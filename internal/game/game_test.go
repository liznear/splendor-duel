package game

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"
)

func fixed() *State { first := 0; return New(42, [2]string{"A", "B"}, &first) }
func controlled() *State {
	s := fixed()
	s.Board = [25]Color{}
	s.Bag = []Color{}
	s.Pyramid = [12]*Card{}
	s.Decks = [3][]*Card{{}, {}, {}}
	s.Players[0].Privileges = 0
	s.Players[1].Privileges = 0
	return s
}
func freeCard(points, crowns int, color Color, abilityName string) *Card {
	var a *string
	if abilityName != "" {
		a = &abilityName
	}
	return &Card{ID: "test", Level: 1, Color: color, Points: points, Crowns: crowns, Bonus: 1, Ability: a, Cost: NewCounts(Colors[:6])}
}
func buy(slot int) Move {
	return Move{Action: Action{Kind: "buy", From: Source{Kind: "pyramid", Slot: slot}}}
}
func take(cells ...int) Move { return Move{Action: Action{Kind: "take", Cells: cells}} }
func apply(t *testing.T, s *State, m Move) *State {
	t.Helper()
	n, err := Apply(s, m)
	if err != nil {
		t.Fatal(err)
	}
	return n
}
func assert(t *testing.T, ok bool, message string) {
	t.Helper()
	if !ok {
		t.Fatal(message)
	}
}
func conservation(t *testing.T, s *State) {
	t.Helper()
	counts := Counts{}
	for _, c := range s.Board {
		if c != "" {
			counts[c]++
		}
	}
	for _, c := range s.Bag {
		counts[c]++
	}
	for _, p := range s.Players {
		for c, n := range p.Tokens {
			counts[c] += n
			assert(t, n >= 0, "negative tokens")
		}

		assert(t, p.Privileges >= 0 && p.Privileges <= 3, "privilege cap")
	}
	for _, g := range Gems {
		assert(t, counts[g] == 4, "gem conservation")
	}
	assert(t, counts[Pearl] == 2 && counts[Gold] == 3, "pearl/gold conservation")
	assert(t, s.Players[0].Privileges+s.Players[1].Privileges <= 3, "privilege pool")
	cards := map[string]bool{}
	add := func(c *Card) { assert(t, !cards[c.ID], "duplicate card"); cards[c.ID] = true }
	for _, d := range s.Decks {
		for _, c := range d {
			add(c)
		}
	}
	for _, c := range s.Pyramid {
		if c != nil {
			add(c)
		}
	}
	for _, p := range s.Players {
		for _, c := range p.Reserved {
			add(c)
		}
		for _, c := range p.Cards {
			add(c.Def)
		}
	}
	assert(t, len(cards) == 67, "card conservation")
}
func TestSetup(t *testing.T) {
	counts := [3]int{}
	ids := map[string]bool{}
	for _, c := range Cards {
		counts[c.Level-1]++
		assert(t, !ids[c.ID], "duplicate definition")
		ids[c.ID] = true
	}
	assert(t, counts == [3]int{30, 24, 13} && len(Royals) == 4, "card data")
	s := fixed()
	assert(t, len(s.Decks[0]) == 25 && len(s.Decks[1]) == 20 && len(s.Decks[2]) == 10, "deck sizes")
	assert(t, s.Current == 0 && s.Players[1].Privileges == 1, "starting privilege")
	conservation(t, s)
	assert(t, reflect.DeepEqual(s, fixed()), "seed not deterministic")
	seen := map[int]bool{}
	for _, cell := range Spiral {
		assert(t, !seen[cell] && cellValid(cell), "spiral duplicate")
		seen[cell] = true
	}
	assert(t, len(seen) == 25, "spiral size")
}
func TestTake(t *testing.T) {
	for _, cells := range [][]int{{0}, {0, 1}, {0, 1, 2}, {0, 5, 10}, {0, 6, 12}, {2, 6, 10}, {2, 1, 0}} {
		t.Run(fmt.Sprint(cells), func(t *testing.T) {
			s := controlled()
			for _, c := range cells {
				s.Board[c] = "red"
			}
			n := apply(t, s, take(cells...))
			assert(t, n.Players[0].Tokens["red"] == len(cells), "taken count")
			if len(cells) == 3 {
				assert(t, n.Players[1].Privileges == 1, "triple privilege")
			}
			assert(t, n.Current == 1 && s.Current == 0, "turn or input mutated")
		})
	}
	for _, cells := range [][]int{nil, {0, 0}, {0, 2}, {0, 1, 7}, {0, 6, 2}, {-1}, {25}, {0, 1, 2, 3}} {
		s := controlled()
		for i := range s.Board {
			s.Board[i] = "red"
		}
		_, err := Apply(s, take(cells...))
		assert(t, err != nil, "accepted illegal take")
	}
	s := controlled()
	s.Board[0] = Gold
	_, err := Apply(s, take(0))
	assert(t, err != nil, "take gold")
	s.Board[0] = ""
	_, err = Apply(s, take(0))
	assert(t, err != nil, "take empty")
	s.Board[0] = Pearl
	s.Board[1] = Pearl
	n := apply(t, s, take(0, 1))
	assert(t, n.Players[1].Privileges == 1, "two pearls privilege")
}
func TestLegalSegments(t *testing.T) {
	s := controlled()
	s.Board[1] = "white"
	s.Board[6] = "white"
	s.Board[11] = "white"
	s.Board[16] = Gold
	l := LegalMoves(s)
	triple := false
	for _, a := range l.Actions {
		if a.Kind == "take" {
			assert(t, !contains(a.Cells, 16), "gold did not block segment")
			if reflect.DeepEqual(a.Cells, []int{1, 6, 11}) {
				triple = true
			}
			_, err := Apply(s, Move{Action: a})
			assert(t, err == nil, "legal move rejected")
		}
	}
	assert(t, triple, "missing straight segment")
}
func contains(a []int, n int) bool {
	for _, x := range a {
		if x == n {
			return true
		}
	}
	return false
}
func TestPaymentAndPurchase(t *testing.T) {
	s := controlled()
	p := &s.Players[0]
	p.Bonuses["black"] = 2
	p.Tokens["black"] = 1
	p.Tokens["white"] = 1
	p.Tokens[Gold] = 1
	c := freeCard(2, 1, "black", "")
	c.Cost["black"] = 4
	c.Cost["white"] = 1
	s.Pyramid[7] = c
	assert(t, EffectiveCost(*p, c)["black"] == 2, "discount")
	assert(t, reflect.DeepEqual(Payment(*p, c), Counts{"black": 1, "white": 1, Gold: 1}), "gold payment")
	assert(t, CanBuy(*p, c), "canBuy")
	p.Tokens[Gold] = 0
	assert(t, !CanBuy(*p, c), "unaffordable")
	_, err := Apply(s, buy(7))
	assert(t, err != nil, "unaffordable purchase")
	p.Tokens[Gold] = 1
	n := apply(t, s, buy(7))
	assert(t, n.Players[0].Points == 2 && n.Players[0].Crowns == 1 && n.Players[0].Bonuses["black"] == 3, "purchase stats")
	assert(t, len(n.Bag) == 3 && n.Players[0].TotalTokens() == 0, "payment to bag")
	assert(t, s.Players[0].TotalTokens() == 3 && s.Pyramid[7] == c, "purchase mutated input")
	c.Cost = NewCounts(Colors[:6])
	assert(t, len(Payment(*p, c)) == 0, "free payment")
}
func TestReserve(t *testing.T) {
	for _, blind := range []bool{false, true} {
		s := controlled()
		s.Board[0] = Gold
		c := freeCard(0, 0, "red", "")
		refill := freeCard(1, 0, "blue", "")
		refill.ID = "refill"
		s.Pyramid[7] = c
		s.Decks[0] = []*Card{refill}
		from := Source{Kind: "pyramid", Slot: 7}
		if blind {
			from = Source{Kind: "deck", Level: 1}
		}
		n := apply(t, s, Move{Action: Action{Kind: "reserve", GoldCell: 0, From: from}})
		assert(t, n.Players[0].Tokens[Gold] == 1 && len(n.Players[0].Reserved) == 1, "reserve")
		assert(t, n.Players[0].Reserved[0].Blind == blind, "blind mark")
		view := n.View(1)
		assert(t, (view.Players[0].Reserved[0].ID == "hidden") == blind, "hidden reserve")
		assert(t, !c.Blind && !refill.Blind, "shared definition mutated")
		if !blind {
			assert(t, n.Pyramid[7] == refill, "reserve refill")
		}
		n.Current = 0
		m := Move{Action: Action{Kind: "buy", From: Source{Kind: "reserved", Index: 0}}}
		n = apply(t, n, m)
		assert(t, len(n.Players[0].Reserved) == 0 && len(n.Players[0].Cards) == 1, "buy reserved")
	}
	s := controlled()
	s.Board[0] = Gold
	s.Pyramid[0] = freeCard(0, 0, "red", "")
	for i := 0; i < 3; i++ {
		s.Players[0].Reserved = append(s.Players[0].Reserved, s.Pyramid[0])
	}
	_, err := Apply(s, Move{Action: Action{Kind: "reserve", GoldCell: 0, From: Source{Kind: "pyramid", Slot: 0}}})
	assert(t, err != nil, "fourth reserve allowed")
}
func TestOptionalAndReplenish(t *testing.T) {
	s := controlled()
	s.Board[0] = "blue"
	s.Board[5] = "blue"
	s.Board[1] = Gold
	s.Players[0].Privileges = 1
	m := take(5)
	m.Privileges = []int{0}
	n := apply(t, s, m)
	assert(t, n.Players[0].Tokens["blue"] == 2 && n.Players[0].Privileges == 0, "privilege")
	for _, cells := range [][]int{{1}, {0, 5}, {0, 0}, {-1}, {25}} {
		_, err := Option(s, Move{Privileges: cells})
		assert(t, err != nil, "invalid privilege accepted")
	}
	s.Bag = []Color{"red", "green", "white", "blue"}
	m = take(5)
	m.Privileges = []int{6}
	m.Replenish = true
	_, err := Apply(s, m)
	assert(t, err != nil, "privilege before refill on empty cell")
	m.ReplenishFirst = true
	n = apply(t, s, m)
	assert(t, n.Board[6] == "" && n.Players[0].TotalTokens() == 2 && n.Players[1].Privileges == 1, "replenishFirst")
	n, err = Replenish(s)
	assert(t, err == nil && len(n.Bag) == 0 && n.Current == s.Current && n.Turn == s.Turn, "forced replenish changes turn")
	s.Bag = nil
	_, err = Replenish(s)
	assert(t, err != nil, "empty bag replenish")
	s = controlled()
	s.Board[0] = "red"
	s.Board[1] = "red"
	s.Board[2] = "red"
	s.Players[0].Privileges = 3
	n = apply(t, s, take(0, 1, 2))
	assert(t, n.Players[0].Privileges == 2 && n.Players[1].Privileges == 1, "empty pool steals privilege")
}
func TestDiscard(t *testing.T) {
	s := controlled()
	s.Players[0].Tokens = Counts{"black": 4, "white": 3, Gold: 1}
	s.Board[0] = "red"
	s.Board[1] = "red"
	s.Board[2] = "red"
	m := take(0, 1, 2)
	m.Discard = Counts{"black": 1}
	n := apply(t, s, m)
	assert(t, n.Players[0].TotalTokens() == 10 && n.Players[0].Tokens["black"] == 3 && len(n.Bag) == 1, "explicit discard")
	m.Discard = nil
	n = apply(t, s, m)
	assert(t, n.Players[0].Tokens["black"] == 3, "default discard")
	m.Discard = Counts{"black": -1}
	_, err := Apply(s, m)
	assert(t, err != nil, "negative discard")
}
func TestAssociate(t *testing.T) {
	s := controlled()
	c := freeCard(4, 0, "", "")
	c.Associate = true
	s.Pyramid[0] = c
	assert(t, !CanBuy(s.Players[0], c), "associate needs owned color")
	s.Players[0].Cards = []Owned{{Def: freeCard(6, 0, "green", ""), Color: "green"}}
	m := buy(0)
	m.AssociateColor = "red"
	_, err := Apply(s, m)
	assert(t, err != nil, "unowned associate color")
	m.AssociateColor = "green"
	n := apply(t, s, m)
	assert(t, n.Players[0].Cards[1].Color == "green" && MaxColorPoints(n.Players[0]) == 10 && n.Winner != nil, "associate color points win")
}
func TestAbilitiesAndRoyals(t *testing.T) {
	for _, a := range []string{"turn", "privilege", "steal", "takeSame"} {
		t.Run(a, func(t *testing.T) {
			s := controlled()
			s.Pyramid[0] = freeCard(0, 0, "red", a)
			s.Board[7] = "red"
			s.Board[8] = "red"
			s.Players[1].Tokens[Pearl] = 1
			s.Players[1].Tokens["blue"] = 2
			m := buy(0)
			if a == "steal" {
				m.StealPick = "blue"
			}
			if a == "takeSame" {
				cell := 8
				m.TakeSameCell = &cell
			}
			n := apply(t, s, m)
			switch a {
			case "turn":
				assert(t, n.Current == 0 && n.ExtraTurns == 0, "extra turn")
			case "privilege":
				assert(t, n.Players[0].Privileges == 1, "privilege ability")
			case "steal":
				assert(t, n.Players[0].Tokens["blue"] == 1 && n.Players[1].Tokens["blue"] == 1, "steal choice")
			case "takeSame":
				assert(t, n.Board[8] == "" && n.Board[7] == "red", "same color choice")
			}
		})
	}
	s := controlled()
	s.Pyramid[0] = freeCard(0, 0, "red", "steal")
	s.Players[1].Tokens[Pearl] = 1
	n := apply(t, s, buy(0))
	assert(t, n.Players[0].Tokens[Pearl] == 1, "default steal pearl")
	s.Players[1].Tokens = NewCounts(Colors)
	n = apply(t, s, buy(0))
	assert(t, n.Players[0].TotalTokens() == 0, "empty steal")
	s = controlled()
	s.Players[0].Crowns = 2
	s.Pyramid[0] = freeCard(0, 3, "red", "")
	pick := 0
	m := buy(0)
	m.RoyalPick = &pick
	n = apply(t, s, m)
	assert(t, len(n.Players[0].Royals) == 1 && n.Players[0].RoyalsTaken == 1 && n.Players[0].Points == 2, "3 crown milestone")
	n.Current = 0
	n.Pyramid[0] = freeCard(0, 1, "red", "")
	n = apply(t, n, m)
	assert(t, len(n.Players[0].Royals) == 2 && n.Players[0].RoyalsTaken == 2 && len(n.Royals) == 2, "6 crown milestone")
	n.Current = 0
	n.Pyramid[0] = freeCard(0, 1, "red", "")
	n = apply(t, n, m)
	assert(t, len(n.Players[0].Royals) == 2, "milestone awarded twice")
	s = controlled()
	s.Pyramid[0] = freeCard(0, 6, "red", "")
	n = apply(t, s, buy(0))
	assert(t, len(n.Players[0].Royals) == 2, "cross both crown milestones")
}
func TestVictoryAndDeadState(t *testing.T) {
	for _, v := range [][3]int{{20, 0, 0}, {0, 10, 0}, {10, 0, 1}} {
		s := controlled()
		color := Color("")
		if v[2] == 1 {
			color = "red"
		}
		s.Pyramid[0] = freeCard(v[0], v[1], color, "")
		n := apply(t, s, buy(0))
		assert(t, n.Winner != nil && *n.Winner == 0 && n.Current == 0, "victory")
		_, err := Apply(n, take(0))
		assert(t, err != nil, "move after game over")
		_, err = Option(n, Move{})
		assert(t, err != nil, "option after game over")
	}
	s := controlled()
	l := LegalMoves(s)
	assert(t, l.MustReplenish && !l.CanReplenish, "dead state")
	s.Bag = []Color{"red"}
	assert(t, LegalMoves(s).CanReplenish, "forced refill possible")
}
func TestRandomGamesConserveAndDoNotMutate(t *testing.T) {
	r := rand.New(rand.NewPCG(17, 42))
	for seed := 0; seed < 30; seed++ {
		s := New(int64(seed), [2]string{"A", "B"}, nil)
		for step := 0; step < 120 && !s.Over(); step++ {
			l := LegalMoves(s)
			if l.MustReplenish {
				if !l.CanReplenish {
					break
				}
				var err error
				s, err = Replenish(s)
				if err != nil {
					t.Fatal(err)
				}
				continue
			}
			before, _ := json.Marshal(s)
			m := Move{Action: l.Actions[r.IntN(len(l.Actions))]}
			n := apply(t, s, m)
			after, _ := json.Marshal(s)
			assert(t, string(before) == string(after), "transition mutated input")
			s = n
			conservation(t, s)
			assert(t, s.Players[0].TotalTokens() <= 10 && s.Players[1].TotalTokens() <= 10, "token cap at end of turn")
		}
	}
}
func fingerprint(s *State) string {
	b, _ := json.Marshal(s)
	var value map[string]any
	_ = json.Unmarshal(b, &value)
	delete(value, "log")
	b, _ = json.Marshal(value)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func TestTypeScriptParity(t *testing.T) {
	data, err := os.ReadFile("testdata/typescript-traces.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Seed      int64  `json:"seed"`
		FirstSeat int    `json:"firstSeat"`
		Initial   string `json:"initial"`
		Events    []struct {
			Type       string `json:"t"`
			Move       Move   `json:"move"`
			Privileges []int  `json:"privileges"`
			Expected   string `json:"expected"`
		} `json:"events"`
	}
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(fmt.Sprint(f.Seed), func(t *testing.T) {
			s := New(f.Seed, [2]string{"A", "B"}, &f.FirstSeat)
			if got := fingerprint(s); got != f.Initial {
				t.Fatalf("initial state differs: %s != %s", got, f.Initial)
			}
			for i, e := range f.Events {
				switch e.Type {
				case "move":
					s, err = Apply(s, e.Move)
				case "option":
					s, err = Option(s, Move{Privileges: e.Privileges})
				case "replenish":
					s, err = Replenish(s)
				}
				if err != nil {
					t.Fatalf("event %d: %v", i, err)
				}
				if got := fingerprint(s); got != e.Expected {
					t.Fatalf("event %d (%s) differs: %s != %s", i, e.Type, got, e.Expected)
				}
				conservation(t, s)
			}
		})
	}
}
func TestPublicView(t *testing.T) {
	s := fixed()
	c := *s.Decks[0][0]
	c.Blind = true
	s.Players[1].Reserved = []*Card{&c}
	v := s.View(0)
	assert(t, v.Players[1].Reserved[0].ID == "hidden" && s.Players[1].Reserved[0].ID != "hidden", "view mutates state")
	b, _ := json.Marshal(s.PublicView(0))
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	_, seed := m["seed"]
	_, rng := m["rngState"]
	assert(t, !seed && !rng, "private randomness leaked")
	decks := m["decks"].([]any)
	assert(t, len(decks[0].([]any)) == len(s.Decks[0]), "deck counts missing")
	for _, card := range decks[0].([]any) {
		assert(t, len(card.(map[string]any)) == 0, "deck identity leaked")
	}
}

func TestWireActionsPreserveZeroIndices(t *testing.T) {
	for _, m := range []Move{take(0), {Action: Action{Kind: "reserve", GoldCell: 0, From: Source{Kind: "pyramid", Slot: 0}}}, buy(0), {Action: Action{Kind: "buy", From: Source{Kind: "reserved", Index: 0}}}, {Action: Action{Kind: "reserve", GoldCell: 0, From: Source{Kind: "deck", Level: 1}}}} {
		data, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		var roundTrip Move
		if err = json.Unmarshal(data, &roundTrip); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(m, roundTrip) {
			t.Fatalf("wire action differs: %s", data)
		}
		var raw map[string]any
		_ = json.Unmarshal(data, &raw)
		a := raw["action"].(map[string]any)
		if m.Action.Kind == "reserve" {
			if _, ok := a["goldCell"]; !ok {
				t.Fatal("zero gold cell omitted")
			}
		}
		if m.Action.From.Kind == "pyramid" {
			if _, ok := a["from"].(map[string]any)["slot"]; !ok {
				t.Fatal("zero slot omitted")
			}
		}
		if m.Action.From.Kind == "reserved" {
			if _, ok := a["from"].(map[string]any)["index"]; !ok {
				t.Fatal("zero index omitted")
			}
		}
	}
	var color Color
	if err := json.Unmarshal([]byte(`7`), &color); err == nil {
		t.Fatal("accepted numeric color")
	}
}
func TestDescriptionsAndPrivateLogs(t *testing.T) {
	s := fixed()
	for _, a := range LegalMoves(s).Actions {
		assert(t, ActionText(s, a) != "", "empty description")
	}
	s.Players[0].Reserved = []*Card{Cards[0]}
	s.Players[0].Tokens[Gold] = 10
	assert(t, ActionText(s, Action{Kind: "buy", From: Source{Kind: "reserved", Index: 0}}) != "", "reserved description")
	assert(t, ActionText(s, Action{Kind: "buy", From: Source{Kind: "pyramid", Slot: -1}}) == "购买", "invalid description")
	assert(t, cellName(-1) == "-1" && cellName(0) == "A1", "cell description")
	assert(t, CardAt(s, 0, Source{Kind: "pyramid", Slot: 12}) == nil && CardAt(s, 0, Source{Kind: "reserved", Index: -1}) == nil, "invalid source")
	c := *s.Decks[0][0]
	c.Blind = true
	s.Players[1].Reserved = []*Card{&c}
	s.Log = append(s.Log, "B 预留 "+c.ID)
	b, _ := json.Marshal(s.PublicView(0))
	var v map[string]any
	_ = json.Unmarshal(b, &v)
	log := v["log"].([]any)
	assert(t, log[len(log)-1] == "B 预留 牌库顶(保密)", "blind identity leaked in log")
}
func TestInvalidSourcesAndEndedRefill(t *testing.T) {
	s := controlled()
	s.Board[0] = Gold
	for _, from := range []Source{{Kind: "pyramid", Slot: -1}, {Kind: "pyramid", Slot: 12}, {Kind: "deck", Level: 0}, {Kind: "deck", Level: 4}, {Kind: "deck", Level: 1}, {Kind: "unknown"}} {
		_, err := Apply(s, Move{Action: Action{Kind: "reserve", GoldCell: 0, From: from}})
		assert(t, err != nil, "invalid reserve source")
	}
	for _, from := range []Source{{Kind: "pyramid", Slot: 0}, {Kind: "reserved", Index: 0}, {Kind: "unknown"}} {
		_, err := Apply(s, Move{Action: Action{Kind: "buy", From: from}})
		assert(t, err != nil, "invalid buy source")
	}
	_, err := Apply(s, Move{Action: Action{Kind: "unknown"}})
	assert(t, err != nil, "unknown action")
	s.Draw = true
	_, err = Replenish(s)
	assert(t, err != nil, "refill after game over")
}
