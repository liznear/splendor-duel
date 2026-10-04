package search

import (
	"context"
	"errors"
	"math"
	"slices"

	"splender/internal/game"
)

func playerValue(p game.Player, s *game.State) float64 {
	v := float64(p.Points*100 + p.Crowns*35 + game.MaxColorPoints(p)*14 + p.Privileges*9 + len(p.Reserved))
	for _, g := range game.Gems {
		v += float64(p.Bonuses[g]*14) + float64(p.Tokens[g])*1.1
	}
	v += float64(p.Tokens[game.Pearl])*3.2 + float64(p.Tokens[game.Gold])*3.5
	for _, c := range s.Pyramid {
		if game.CanBuy(p, c) {
			v += 2
		}
	}
	for _, c := range p.Reserved {
		if game.CanBuy(p, c) {
			v += 3
		}
	}
	return v
}
func Evaluate(s *game.State, seat int) float64 {
	if s.Winner != nil {
		if *s.Winner == seat {
			return 1e9
		}
		return -1e9
	}
	if s.Draw {
		return 0
	}
	return playerValue(s.Players[seat], s) - 0.75*playerValue(s.Players[1-seat], s)
}
func symmetric(s *game.State, seat int) float64 {
	if s.Over() {
		return Evaluate(s, seat)
	}
	return playerValue(s.Players[seat], s) - playerValue(s.Players[1-seat], s)
}
func score(s *game.State, m game.Move) float64 {
	n, err := game.Apply(s, m)
	if err != nil {
		return math.Inf(-1)
	}
	return Evaluate(n, s.Current)
}

// Candidates also include privilege plans that unlock a purchase this turn.
func candidates(s *game.State) []game.Move {
	lm := game.LegalMoves(s)
	out := make([]game.Move, 0, len(lm.Actions)+15)
	for _, a := range lm.Actions {
		out = append(out, game.Move{Action: a})
	}
	p := s.Players[s.Current]
	if p.Privileges == 0 {
		return out
	}
	cards := append(slices.Clone(s.Pyramid[:]), p.Reserved...)
	for i, c := range cards {
		if c == nil || c.ID == "hidden" || game.CanBuy(p, c) || c.Associate && len(game.OwnedColors(p)) == 0 {
			continue
		}
		gaps := game.EffectiveCost(p, c)
		need := -p.Tokens[game.Gold]
		for g, n := range gaps {
			gaps[g] = max(0, n-p.Tokens[g])
			need += gaps[g]
		}
		if need < 1 || need > p.Privileges {
			continue
		}
		cells := []int{}
		for _, g := range append([]game.Color{game.Pearl}, game.Gems...) {
			for cell, t := range s.Board {
				if need > 0 && gaps[g] > 0 && t == g {
					cells = append(cells, cell)
					gaps[g]--
					need--
				}
			}
		}
		if need > 0 {
			continue
		}
		from := game.Source{Kind: "pyramid", Slot: i}
		if i >= 12 {
			from = game.Source{Kind: "reserved", Index: i - 12}
		}
		out = append(out, game.Move{Action: game.Action{Kind: "buy", From: from}, Privileges: cells})
	}
	return out
}

// orderedMoves evaluates each candidate once before sorting. Rule transitions
// are substantially more expensive than comparing the cached scores.
func orderedMoves(s *game.State) []game.Move {
	type rankedMove struct {
		move  game.Move
		value float64
	}
	moves := candidates(s)
	ranked := make([]rankedMove, len(moves))
	for i, m := range moves {
		ranked[i] = rankedMove{m, score(s, m)}
	}
	slices.SortStableFunc(ranked, func(a, b rankedMove) int { return cmpScore(b.value, a.value) })
	for i, r := range ranked {
		moves[i] = r.move
	}
	return moves
}

func refine(ctx context.Context, s *game.State, m game.Move) game.Move {
	best := score(s, m)
	try := func(n game.Move) {
		if ctx.Err() != nil {
			return
		}
		v := score(s, n)
		if v > best {
			best = v
			m = n
		}
	}
	if m.Action.Kind == "buy" {
		c := game.CardAt(s, s.Current, m.Action.From)
		if c != nil {
			if c.Associate {
				for _, g := range game.OwnedColors(s.Players[s.Current]) {
					n := m
					n.AssociateColor = g
					try(n)
				}
			}
			for i := range s.Royals {
				n := m
				j := i
				n.RoyalPick = &j
				try(n)
			}
			if c.Ability != nil && *c.Ability == "steal" {
				for _, g := range game.Colors[:6] {
					n := m
					n.StealPick = g
					try(n)
				}
			}
			if c.Ability != nil && *c.Ability == "takeSame" {
				for cell, g := range s.Board {
					if g == c.Color {
						n := m
						j := cell
						n.TakeSameCell = &j
						try(n)
					}
				}
			}
		}
	}
	for k := len(m.Privileges); k < s.Players[s.Current].Privileges; k++ {
		old := len(m.Privileges)
		for _, cell := range game.LegalMoves(s).PrivilegeCells {
			if slices.Contains(m.Privileges, cell) {
				continue
			}
			n := m
			n.Privileges = append(slices.Clone(m.Privileges), cell)
			try(n)
		}
		if len(m.Privileges) == old {
			break
		}
	}
	return m
}
func greedy(ctx context.Context, s *game.State) (game.Move, error) {
	moves := candidates(s)
	if len(moves) == 0 {
		return game.Move{}, errors.New("no legal move")
	}
	best := moves[0]
	v := math.Inf(-1)
	for _, m := range moves {
		if ctx.Err() != nil {
			break
		}
		n := score(s, m)
		if n > v {
			v = n
			best = m
		}
	}
	return refine(ctx, s, best), nil
}
