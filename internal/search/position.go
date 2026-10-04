package search

import (
	"math/rand/v2"

	"splender/internal/game"
)

// Position hides the real deck order/RNG and samples unknown cards. No search
// may predict the actual future shuffle or inspect an opponent's blind reserve.
func position(s *game.State, r *rand.Rand) *game.State {
	v := s.View(s.Current)
	v.Log = []string{}
	v.RNGState = int32(r.Uint32())
	known := map[string]bool{}
	for _, c := range v.Pyramid {
		if c != nil {
			known[c.ID] = true
		}
	}
	for _, p := range v.Players {
		for _, c := range p.Cards {
			known[c.Def.ID] = true
		}
		for _, c := range p.Reserved {
			if c.ID != "hidden" {
				known[c.ID] = true
			}
		}
	}
	for level := 1; level <= 3; level++ {
		pool := []*game.Card{}
		for _, c := range game.Cards {
			if c.Level == level && !known[c.ID] {
				pool = append(pool, c)
			}
		}
		r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
		for seat := range v.Players {
			for i, c := range v.Players[seat].Reserved {
				if c.ID == "hidden" && c.Level == level && len(pool) > 0 {
					card := *pool[len(pool)-1]
					card.Blind = true
					v.Players[seat].Reserved[i] = &card
					pool = pool[:len(pool)-1]
				}
			}
		}
		v.Decks[level-1] = pool
	}
	r.Shuffle(len(v.Bag), func(i, j int) { v.Bag[i], v.Bag[j] = v.Bag[j], v.Bag[i] })
	return v
}
func ready(s *game.State) *game.State {
	if s.Over() {
		return s
	}
	lm := game.LegalMoves(s)
	if len(lm.Actions) > 0 {
		return s
	}
	if !lm.CanReplenish {
		n := s.Clone()
		n.Draw = true
		return n
	}
	n, err := game.Replenish(s)
	if err != nil {
		return s
	}
	return n
}
