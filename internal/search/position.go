package search

import "splender/internal/game"

// Bots search a private copy of the full server state, including deck order,
// shuffle RNG, bag order, and both players' blind reservations.
func position(s *game.State) *game.State {
	v := s.Clone()
	v.Log = []string{}
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
