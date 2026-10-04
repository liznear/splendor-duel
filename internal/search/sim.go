package search

import (
	"context"
	"math"
	"math/rand/v2"

	"splender/internal/game"
)

// The simulation kernel mirrors game rules for generated moves and their default
// choices. Cards and deck backing arrays are immutable; copying a position owns
// all mutable data. Bots provide the full server state, including private cards.
const (
	simEmpty = -1
	simPearl = 5
	simGold  = 6

	// Covers ordinary moves plus their replenishment-first alternatives.
	simMaxMoves = 1024
)

type simCard struct {
	cost                         [6]int
	color, points, bonus, crowns int
	ability                      string
	associate                    bool
}
type simRoyal struct {
	points  int
	ability string
}
type simPlayer struct {
	tokens                                             [7]int
	bonuses, colorPoints, colorCount                   [5]int
	reserved                                           [3]*simCard
	reservedN, privileges, points, crowns, royalsTaken int
}
type simState struct {
	board                             [25]int
	bag                               [25]int
	bagN                              int
	decks                             [3][]*simCard
	pyramid                           [12]*simCard
	royals                            [4]simRoyal
	royalN                            int
	players                           [2]simPlayer
	current, extraTurns, turn, winner int
	draw                              bool
	includeRefill                     bool
	rngState                          int32
}
type simMove struct {
	action     uint32
	privileges [3]int
	privilegeN int
	replenish  bool
}

func simColor(c game.Color) int {
	for i, g := range game.Colors {
		if c == g {
			return i
		}
	}
	return simEmpty
}
func importSim(s *game.State) *simState {
	v := &simState{current: s.Current, extraTurns: s.ExtraTurns, turn: s.Turn, winner: -1, draw: s.Draw, rngState: s.RNGState, bagN: len(s.Bag), royalN: len(s.Royals)}
	if s.Winner != nil {
		v.winner = *s.Winner
	}
	cards := map[*game.Card]*simCard{}
	convert := func(c *game.Card) *simCard {
		if c == nil || c.ID == "hidden" {
			return nil
		}
		if cached := cards[c]; cached != nil {
			return cached
		}
		sc := &simCard{color: simColor(c.Color), points: c.Points, bonus: c.Bonus, crowns: c.Crowns, associate: c.Associate}
		if c.Ability != nil {
			sc.ability = *c.Ability
		}
		for i, g := range game.Colors[:6] {
			sc.cost[i] = c.Cost[g]
		}
		cards[c] = sc
		return sc
	}
	for i, g := range s.Board {
		v.board[i] = simColor(g)
	}
	for i, g := range s.Bag {
		v.bag[i] = simColor(g)
	}
	for level, deck := range s.Decks {
		v.decks[level] = make([]*simCard, len(deck))
		for i, c := range deck {
			v.decks[level][i] = convert(c)
		}
	}
	for i, c := range s.Pyramid {
		v.pyramid[i] = convert(c)
	}
	for seat, p := range s.Players {
		q := &v.players[seat]
		q.reservedN, q.privileges, q.points, q.crowns, q.royalsTaken = len(p.Reserved), p.Privileges, p.Points, p.Crowns, p.RoyalsTaken
		for i, g := range game.Colors {
			q.tokens[i] = p.Tokens[g]
			if i < 5 {
				q.bonuses[i] = p.Bonuses[g]
			}
		}
		for _, c := range p.Cards {
			g := simColor(c.Color)
			if g >= 0 && g < 5 {
				q.colorCount[g]++
				q.colorPoints[g] += c.Def.Points
			}
		}
		for i, c := range p.Reserved {
			q.reserved[i] = convert(c)
		}
	}
	for i, r := range s.Royals {
		v.royals[i].points = r.Points
		if r.Ability != nil {
			v.royals[i].ability = *r.Ability
		}
	}
	return v
}
func (p *simPlayer) associateColor() int {
	best := 0
	for g := 1; g < 5; g++ {
		if p.colorCount[g] > p.colorCount[best] {
			best = g
		}
	}
	if p.colorCount[best] == 0 {
		return -1
	}
	return best
}
func (p *simPlayer) canBuy(c *simCard) bool {
	if c == nil || c.associate && p.associateColor() < 0 {
		return false
	}
	need := 0
	for g, n := range c.cost {
		if g < 5 {
			n = max(0, n-p.bonuses[g])
		}
		need += max(0, n-p.tokens[g])
	}
	return need <= p.tokens[simGold]
}
func (s *simState) card(action uint32) *simCard {
	idx := int(action >> 3 & 15)
	if action&4 != 0 {
		return s.players[s.current].reserved[idx]
	}
	return s.pyramid[idx]
}

// Same encoding as the TypeScript kernel: take has three 5-bit cells (+1),
// reserve has a gold cell/source, and buy has a source/index.
func (s *simState) moves(out []simMove) []simMove {
	out = out[:0]
	for cell, g := range s.board {
		if g == simEmpty || g == simGold {
			continue
		}
		out = append(out, simMove{action: uint32(cell+1) << 2})
		for _, d := range [4][2]int{{0, 1}, {1, 1}, {1, 0}, {1, -1}} {
			action := uint32(cell+1) << 2
			for n := 1; n <= 2; n++ {
				r, c := cell/5+d[0]*n, cell%5+d[1]*n
				if r < 0 || r >= 5 || c < 0 || c >= 5 {
					break
				}
				next := r*5 + c
				if s.board[next] == simEmpty || s.board[next] == simGold {
					break
				}
				action |= uint32(next+1) << uint(2+5*n)
				out = append(out, simMove{action: action})
			}
		}
	}
	p := &s.players[s.current]
	if p.reservedN < 3 {
		for cell, g := range s.board {
			if g != simGold {
				continue
			}
			for slot, c := range s.pyramid {
				if c != nil {
					out = append(out, simMove{action: 1 | uint32(cell+1)<<2 | uint32(slot)<<8})
				}
			}
			for level, deck := range s.decks {
				if len(deck) > 0 {
					out = append(out, simMove{action: 1 | uint32(cell+1)<<2 | 1<<7 | uint32(level+1)<<8})
				}
			}
		}
	}
	for i := 0; i < 12+p.reservedN; i++ {
		action := uint32(2) | uint32(i)<<3
		var c *simCard
		if i < 12 {
			c = s.pyramid[i]
		} else {
			c = p.reserved[i-12]
			action = 2 | 4 | uint32(i-12)<<3
		}
		if c == nil || c.associate && p.associateColor() < 0 {
			continue
		}
		if p.canBuy(c) {
			out = append(out, simMove{action: action})
			continue
		}
		if p.privileges == 0 {
			continue
		}
		gaps := [6]int{}
		need := -p.tokens[simGold]
		for g, n := range c.cost {
			if g < 5 {
				n -= p.bonuses[g]
			}
			gaps[g] = max(0, n-p.tokens[g])
			need += gaps[g]
		}
		if need < 1 || need > p.privileges {
			continue
		}
		m := simMove{action: action}
		for _, g := range [6]int{simPearl, 0, 1, 2, 3, 4} {
			for cell, t := range s.board {
				if need > 0 && gaps[g] > 0 && t == g {
					m.privileges[m.privilegeN] = cell
					m.privilegeN++
					gaps[g]--
					need--
				}
			}
		}
		if need == 0 {
			out = append(out, m)
		}
	}
	return out
}
func (s *simState) gainPrivilege(who int) {
	p, o := &s.players[who], &s.players[1-who]
	if p.privileges >= 3 {
		return
	}
	if p.privileges+o.privileges < 3 {
		p.privileges++
	} else if o.privileges > 0 {
		o.privileges--
		p.privileges++
	}
}
func (s *simState) ability(who int, a string, color int) {
	p, o := &s.players[who], &s.players[1-who]
	switch a {
	case "turn":
		s.extraTurns++
	case "privilege":
		s.gainPrivilege(who)
	case "steal":
		pick := simPearl
		if o.tokens[pick] == 0 {
			pick = -1
			for g := 0; g < 5; g++ {
				if o.tokens[g] > 0 && (pick < 0 || o.tokens[g] > o.tokens[pick]) {
					pick = g
				}
			}
		}
		if pick >= 0 {
			o.tokens[pick]--
			p.tokens[pick]++
		}
	case "takeSame":
		if color < 0 {
			return
		}
		for cell, g := range s.board {
			if g == color {
				s.board[cell] = simEmpty
				p.tokens[g]++
				break
			}
		}
	}
}
func (s *simState) royal(who int) {
	if s.royalN == 0 {
		return
	}
	idx := -1
	for _, a := range [3]string{"turn", "privilege", "steal"} {
		for i := 0; i < s.royalN; i++ {
			if s.royals[i].ability == a {
				idx = i
				break
			}
		}
		if idx >= 0 {
			break
		}
	}
	if idx < 0 {
		idx = 0
	}
	r := s.royals[idx]
	copy(s.royals[idx:], s.royals[idx+1:s.royalN])
	s.royalN--
	s.royals[s.royalN] = simRoyal{}
	s.players[who].points += r.points
	s.ability(who, r.ability, -1)
}
func (s *simState) pushBag(g, n int) {
	for i := 0; i < n; i++ {
		s.bag[s.bagN] = g
		s.bagN++
	}
}
func (s *simState) popDeck(level int) *simCard {
	deck := s.decks[level]
	if len(deck) == 0 {
		return nil
	}
	c := deck[len(deck)-1]
	s.decks[level] = deck[:len(deck)-1]
	return c
}
func (s *simState) apply(m simMove) {
	if m.replenish {
		s.replenish()
	}
	who := s.current
	p := &s.players[who]
	for i := 0; i < m.privilegeN; i++ {
		cell := m.privileges[i]
		p.tokens[s.board[cell]]++
		s.board[cell] = simEmpty
		p.privileges--
	}
	action := m.action
	switch action & 3 {
	case 0:
		n, pearls, first, same := 0, 0, -1, true
		for shift := uint(2); shift <= 12; shift += 5 {
			cell := int(action>>shift&31) - 1
			if cell < 0 {
				break
			}
			g := s.board[cell]
			s.board[cell] = simEmpty
			p.tokens[g]++
			n++
			if g == simPearl {
				pearls++
			}
			if first < 0 {
				first = g
			} else if g != first {
				same = false
			}
		}
		if n == 3 && same || pearls >= 2 {
			s.gainPrivilege(1 - who)
		}
	case 1:
		cell := int(action>>2&31) - 1
		idx := int(action >> 8 & 15)
		s.board[cell] = simEmpty
		p.tokens[simGold]++
		var c *simCard
		if action&128 != 0 {
			c = s.popDeck(idx - 1)
		} else {
			c = s.pyramid[idx]
			s.pyramid[idx] = s.popDeck(game.SlotLevel(idx) - 1)
		}
		p.reserved[p.reservedN] = c
		p.reservedN++
	case 2:
		c := s.card(action)
		color := c.color
		if c.associate {
			color = p.associateColor()
		}
		gold := 0
		for g, n := range c.cost {
			if g < 5 {
				n = max(0, n-p.bonuses[g])
			}
			use := min(n, p.tokens[g])
			p.tokens[g] -= use
			s.pushBag(g, use)
			gold += n - use
		}
		p.tokens[simGold] -= gold
		s.pushBag(simGold, gold)
		idx := int(action >> 3 & 15)
		if action&4 != 0 {
			copy(p.reserved[idx:], p.reserved[idx+1:p.reservedN])
			p.reservedN--
			p.reserved[p.reservedN] = nil
		} else {
			s.pyramid[idx] = s.popDeck(game.SlotLevel(idx) - 1)
		}
		if color >= 0 {
			p.bonuses[color] += c.bonus
			p.colorPoints[color] += c.points
			p.colorCount[color]++
		}
		p.points += c.points
		p.crowns += c.crowns
		s.ability(who, c.ability, color)
		if p.royalsTaken == 0 && p.crowns >= 3 {
			p.royalsTaken = 1
			s.royal(who)
		}
		if p.royalsTaken == 1 && p.crowns >= 6 {
			p.royalsTaken = 2
			s.royal(who)
		}
	}
	total := 0
	for _, n := range p.tokens {
		total += n
	}
	left := total - 10
	for g, n := range p.tokens {
		if left <= 0 {
			break
		}
		use := min(left, n)
		p.tokens[g] -= use
		s.pushBag(g, use)
		left -= use
	}
	if p.points >= 20 || p.crowns >= 10 || p.maxColorPoints() >= 10 {
		s.winner = who
		return
	}
	if s.extraTurns > 0 {
		s.extraTurns--
	} else {
		s.current = 1 - who
	}
	s.turn++
}
func (p *simPlayer) maxColorPoints() int {
	best := 0
	for _, n := range p.colorPoints {
		best = max(best, n)
	}
	return best
}
func (s *simState) replenish() {
	for i := s.bagN - 1; i > 0; i-- {
		s.rngState = int32(uint32(s.rngState) + 0x6d2b79f5)
		t := uint32(s.rngState)
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		j := int(float64(t^(t>>14)) / 4294967296 * float64(i+1))
		s.bag[i], s.bag[j] = s.bag[j], s.bag[i]
	}
	for _, cell := range game.Spiral {
		if s.bagN == 0 {
			break
		}
		if s.board[cell] == simEmpty {
			s.bagN--
			s.board[cell] = s.bag[s.bagN]
			s.bag[s.bagN] = 0
		}
	}
	s.gainPrivilege(1 - s.current)
}
func (s *simState) ready(out []simMove) []simMove {
	moves := s.moves(out)
	if s.bagN > 0 && (s.includeRefill || len(moves) == 0) {
		// Replenishment is optional even when an ordinary action is available.
		// Generate on a copy so unchosen branches retain the original board/RNG.
		next := *s
		next.replenish()
		alternatives := next.moves(moves[len(moves):])
		for i := range alternatives {
			alternatives[i].replenish = true
		}
		moves = append(moves, alternatives...)
	}
	if len(moves) == 0 {
		s.draw = true
	}
	return moves
}

type simScorer struct {
	state       *simState
	replenished simState
	prepared    bool
}

// All replenishment alternatives at a position share one shuffled board.
// Prepare it once for move ordering or a rollout's candidate scan.
func (s *simState) scorer() simScorer {
	return simScorer{state: s}
}
func (v *simScorer) score(m simMove) float64 {
	if m.replenish {
		if !v.prepared {
			v.replenished = *v.state
			v.replenished.replenish()
			v.prepared = true
		}
		m.replenish = false
		return scoreMove(&v.replenished, m) - .01
	}
	return scoreMove(v.state, m)
}

// Direct TS-style heuristic: no successor allocation or full-board affordability
// scan for every candidate. Only the chosen move is applied.
// scoreMove is a free function so neither scorer's receiver can force the
// other to escape; a leaking receiver here would heap-allocate a simScorer
// (with an embedded simState) on every rollout ply.
func scoreMove(s *simState, m simMove) float64 {
	p := &s.players[s.current]
	switch m.action & 3 {
	case 2:
		c := s.card(m.action)
		color := c.color
		if c.associate {
			color = p.associateColor()
		}
		if p.points+c.points >= 20 || p.crowns+c.crowns >= 10 || color >= 0 && p.colorPoints[color]+c.points >= 10 {
			return 10000
		}
		cost := 0
		for g, n := range c.cost {
			if g < 5 {
				n = max(0, n-p.bonuses[g])
			}
			cost += n
		}
		ability := 0
		switch c.ability {
		case "turn":
			ability = 40
		case "takeSame", "steal":
			ability = 10
		case "privilege":
			ability = 20
		}
		return float64(c.points*100+c.crowns*35+c.bonus*14+ability) - float64(cost)*1.2 - float64(m.privilegeN)*.01
	case 1:
		return 0
	default:
		value := 0.0
		for shift := uint(2); shift <= 12; shift += 5 {
			cell := int(m.action>>shift&31) - 1
			if cell < 0 {
				break
			}
			if s.board[cell] == simPearl {
				value += 8
			} else {
				value += 1.5
			}
		}
		return value
	}
}
func (s *simState) score(m simMove) float64 {
	if m.replenish {
		// Prefer avoiding replenishment when its immediate benefit is identical.
		sc := s.scorer()
		return sc.score(m)
	}
	return scoreMove(s, m)
}
func (s *simState) playerValue(seat int) float64 {
	p := &s.players[seat]
	value := float64(p.points*100 + p.crowns*35 + p.maxColorPoints()*14 + p.privileges*9 + p.reservedN)
	for g := 0; g < 5; g++ {
		value += float64(p.bonuses[g]*14) + float64(p.tokens[g])*1.1
	}
	value += float64(p.tokens[simPearl])*3.2 + float64(p.tokens[simGold])*3.5
	for _, c := range s.pyramid {
		if p.canBuy(c) {
			value += 2
		}
	}
	for i := 0; i < p.reservedN; i++ {
		if p.canBuy(p.reserved[i]) {
			value += 3
		}
	}
	return value
}
func simRollout(ctx context.Context, start *simState, seat int, r *rand.Rand) float64 {
	s := *start
	var scratch [simMaxMoves]simMove
	for i := 0; i < 160 && s.winner < 0 && !s.draw; i++ {
		if ctx.Err() != nil {
			break
		}
		moves := s.ready(scratch[:0])
		if s.draw {
			break
		}
		best := moves[0]
		value := math.Inf(-1)
		scorer := s.scorer()
		for _, m := range moves {
			v := scorer.score(m) + r.Float64()*4
			if v > value {
				value = v
				best = m
			}
		}
		s.apply(best)
	}
	if s.winner >= 0 {
		if s.winner == seat {
			return 1
		}
		return 0
	}
	if s.draw {
		return .5
	}
	return .5 + .45*math.Tanh((s.playerValue(seat)-s.playerValue(1-seat))/600)
}
func decodeSimMove(m simMove) game.Move {
	move := game.Move{Replenish: m.replenish, ReplenishFirst: m.replenish}
	if m.privilegeN > 0 {
		move.Privileges = append([]int(nil), m.privileges[:m.privilegeN]...)
	}
	a := m.action
	switch a & 3 {
	case 0:
		move.Action.Kind = "take"
		for shift := uint(2); shift <= 12; shift += 5 {
			cell := int(a>>shift&31) - 1
			if cell < 0 {
				break
			}
			move.Action.Cells = append(move.Action.Cells, cell)
		}
	case 1:
		move.Action.Kind = "reserve"
		move.Action.GoldCell = int(a>>2&31) - 1
		if a&128 != 0 {
			move.Action.From = game.Source{Kind: "deck", Level: int(a >> 8 & 15)}
		} else {
			move.Action.From = game.Source{Kind: "pyramid", Slot: int(a >> 8 & 15)}
		}
	case 2:
		move.Action.Kind = "buy"
		if a&4 != 0 {
			move.Action.From = game.Source{Kind: "reserved", Index: int(a >> 3 & 15)}
		} else {
			move.Action.From = game.Source{Kind: "pyramid", Slot: int(a >> 3 & 15)}
		}
	}
	return move
}

func (s *simState) over() bool { return s.winner >= 0 || s.draw }
