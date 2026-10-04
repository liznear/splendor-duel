package game

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
)

//go:embed cards.json
var cardsJSON []byte

//go:embed royals.json
var royalsJSON []byte
var Cards []*Card
var Royals []Royal

func init() {
	if err := json.Unmarshal(cardsJSON, &Cards); err != nil {
		panic(err)
	}
	if err := json.Unmarshal(royalsJSON, &Royals); err != nil {
		panic(err)
	}
}

var Spiral = []int{12, 6, 7, 8, 13, 18, 17, 16, 11, 0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5}

func SlotLevel(slot int) int {
	if slot < 3 {
		return 3
	}
	if slot < 7 {
		return 2
	}
	return 1
}
func (s *State) Random() float64 {
	s.RNGState = int32(uint32(s.RNGState) + 0x6d2b79f5)
	t := uint32(s.RNGState)
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return float64(t^(t>>14)) / 4294967296
}
func shuffle[T any](a []T, s *State) {
	for i := len(a) - 1; i > 0; i-- {
		j := int(s.Random() * float64(i+1))
		a[i], a[j] = a[j], a[i]
	}
}
func pop[T any](a *[]T) T {
	var zero T
	if len(*a) == 0 {
		return zero
	}
	i := len(*a) - 1
	v := (*a)[i]
	*a = (*a)[:i]
	return v
}
func New(seed int64, names [2]string, first *int) *State {
	s := &State{Seed: seed, RNGState: int32(seed), Bag: []Color{}, Royals: slices.Clone(Royals), Log: []string{}}
	for i, name := range names {
		s.Players[i] = Player{Name: name, Tokens: NewCounts(Colors), Bonuses: NewCounts(Gems), Cards: []Owned{}, Reserved: []*Card{}, Royals: []Royal{}}
	}
	bag := []Color{}
	for _, g := range Gems {
		for i := 0; i < 4; i++ {
			bag = append(bag, g)
		}
	}
	bag = append(bag, Pearl, Pearl, Gold, Gold, Gold)
	shuffle(bag, s)
	for _, cell := range Spiral {
		s.Board[cell] = pop(&bag)
	}
	for level := 1; level <= 3; level++ {
		s.Decks[level-1] = []*Card{}
		for _, c := range Cards {
			if c.Level == level {
				s.Decks[level-1] = append(s.Decks[level-1], c)
			}
		}
		shuffle(s.Decks[level-1], s)
	}
	for slot := range s.Pyramid {
		s.Pyramid[slot] = pop(&s.Decks[SlotLevel(slot)-1])
	}
	if s.Random() < 0.5 {
		s.Current = 1
	}
	if first != nil {
		s.Current = *first
	}
	s.Players[1-s.Current].Privileges = 1
	return s
}
func cloneCounts(m Counts) Counts {
	n := Counts{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func (s *State) Clone() *State {
	n := *s
	n.Bag = slices.Clone(s.Bag)
	n.Royals = slices.Clone(s.Royals)
	n.Log = slices.Clone(s.Log)
	for i := range s.Decks {
		n.Decks[i] = slices.Clone(s.Decks[i])
	}
	for i, p := range s.Players {
		n.Players[i] = p
		n.Players[i].Tokens = cloneCounts(p.Tokens)
		n.Players[i].Bonuses = cloneCounts(p.Bonuses)
		n.Players[i].Cards = slices.Clone(p.Cards)
		n.Players[i].Reserved = slices.Clone(p.Reserved)
		n.Players[i].Royals = slices.Clone(p.Royals)
	}
	return &n
}
func (s *State) View(seat int) *State {
	v := s.Clone()
	for i, c := range v.Players[1-seat].Reserved {
		if c.Blind {
			v.Players[1-seat].Reserved[i] = &Card{ID: "hidden", Level: c.Level, Cost: NewCounts(Colors[:6])}
		}
	}
	return v
}

// PublicView exposes bag colors and private deck counts, with no RNG state or seed.
// Search determinization is separate from the client representation.
func (s *State) PublicView(seat int) any {
	v := s.View(seat)
	for _, c := range s.Players[1-seat].Reserved {
		if c.Blind {
			for i, line := range v.Log {
				v.Log[i] = strings.ReplaceAll(line, c.ID, "牌库顶(保密)")
			}
		}
	}
	type view struct {
		Board      [25]Color     `json:"board"`
		Bag        []Color       `json:"bag"`
		Decks      [3][]struct{} `json:"decks"`
		Pyramid    [12]*Card     `json:"pyramid"`
		Royals     []Royal       `json:"royals"`
		Players    [2]Player     `json:"players"`
		Current    int           `json:"current"`
		ExtraTurns int           `json:"extraTurns"`
		Turn       int           `json:"turnCount"`
		Winner     *int          `json:"winner"`
		Draw       bool          `json:"draw"`
		Log        []string      `json:"log"`
	}
	out := view{Board: v.Board, Bag: slices.Clone(v.Bag), Pyramid: v.Pyramid, Royals: v.Royals, Players: v.Players, Current: v.Current, ExtraTurns: v.ExtraTurns, Turn: v.Turn, Winner: v.Winner, Draw: v.Draw, Log: v.Log}
	for i := range v.Decks {
		out.Decks[i] = make([]struct{}, len(v.Decks[i]))
	}
	return out
}
