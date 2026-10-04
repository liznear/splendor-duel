package game

import (
	"errors"
	"fmt"
	"slices"
)

func EffectiveCost(p Player, c *Card) Counts {
	out := Counts{}
	for _, g := range Colors[:6] {
		out[g] = c.Cost[g]
		if g != Pearl {
			out[g] = max(0, out[g]-p.Bonuses[g])
		}
	}
	return out
}
func CanBuy(p Player, c *Card) bool {
	if c == nil || c.ID == "hidden" {
		return false
	}
	if c.Associate && len(OwnedColors(p)) == 0 {
		return false
	}
	need := 0
	for g, n := range EffectiveCost(p, c) {
		need += max(0, n-p.Tokens[g])
	}
	return need <= p.Tokens[Gold]
}
func Payment(p Player, c *Card) Counts {
	out := Counts{}
	gold := 0
	eff := EffectiveCost(p, c)
	for _, g := range Colors[:6] {
		use := min(p.Tokens[g], eff[g])
		if use > 0 {
			out[g] = use
		}
		gold += eff[g] - use
	}
	if gold > 0 {
		out[Gold] = gold
	}
	return out
}
func OwnedColors(p Player) []Color {
	out := []Color{}
	for _, g := range Gems {
		for _, c := range p.Cards {
			if c.Color == g {
				out = append(out, g)
				break
			}
		}
	}
	return out
}
func MaxColorPoints(p Player) int {
	pts := Counts{}
	best := 0
	for _, c := range p.Cards {
		if c.Color != "" {
			pts[c.Color] += c.Def.Points
			best = max(best, pts[c.Color])
		}
	}
	return best
}
func LegalMoves(s *State) Legal {
	l := Legal{Actions: []Action{}, PrivilegeCells: []int{}, CanReplenish: len(s.Bag) > 0}
	p := s.Players[s.Current]
	for cell, t := range s.Board {
		if t == "" || t == Gold {
			continue
		}
		l.PrivilegeCells = append(l.PrivilegeCells, cell)
		l.Actions = append(l.Actions, Action{Kind: "take", Cells: []int{cell}})
		for _, d := range [][2]int{{0, 1}, {1, 1}, {1, 0}, {1, -1}} {
			line := []int{cell}
			for n := 1; n <= 2; n++ {
				r, c := cell/5+d[0]*n, cell%5+d[1]*n
				if r < 0 || r >= 5 || c < 0 || c >= 5 {
					break
				}
				next := r*5 + c
				if s.Board[next] == "" || s.Board[next] == Gold {
					break
				}
				line = append(line, next)
				l.Actions = append(l.Actions, Action{Kind: "take", Cells: slices.Clone(line)})
			}
		}
	}
	if len(p.Reserved) < 3 {
		for cell, t := range s.Board {
			if t != Gold {
				continue
			}
			for slot, c := range s.Pyramid {
				if c != nil {
					l.Actions = append(l.Actions, Action{Kind: "reserve", GoldCell: cell, From: Source{Kind: "pyramid", Slot: slot}})
				}
			}
			for i, deck := range s.Decks {
				if len(deck) > 0 {
					l.Actions = append(l.Actions, Action{Kind: "reserve", GoldCell: cell, From: Source{Kind: "deck", Level: i + 1}})
				}
			}
		}
	}
	for slot, c := range s.Pyramid {
		if CanBuy(p, c) {
			l.Actions = append(l.Actions, Action{Kind: "buy", From: Source{Kind: "pyramid", Slot: slot}})
		}
	}
	for i, c := range p.Reserved {
		if CanBuy(p, c) {
			l.Actions = append(l.Actions, Action{Kind: "buy", From: Source{Kind: "reserved", Index: i}})
		}
	}
	l.MustReplenish = len(l.Actions) == 0
	return l
}
func gainPrivilege(s *State, who int) {
	p, o := &s.Players[who], &s.Players[1-who]
	if p.Privileges >= 3 {
		return
	}
	if p.Privileges+o.Privileges < 3 {
		p.Privileges++
	} else if o.Privileges > 0 {
		o.Privileges--
		p.Privileges++
	}
}
func cellValid(cell int) bool { return cell >= 0 && cell < 25 }
func cellName(cell int) string {
	if !cellValid(cell) {
		return fmt.Sprint(cell)
	}
	return fmt.Sprintf("%c%d", 'A'+cell%5, cell/5+1)
}

var colorZH = map[Color]string{"black": "黑", "red": "红", "green": "绿", "blue": "蓝", "white": "白", Pearl: "珠", Gold: "金"}

func optional(s *State, m Move, forced bool) error {
	p := &s.Players[s.Current]
	if len(m.Privileges) > p.Privileges {
		return errors.New("特权数量不足: 每枚特权只能拿 1 格")
	}
	got := []string{}
	for _, cell := range m.Privileges {
		if !cellValid(cell) || s.Board[cell] == "" || s.Board[cell] == Gold {
			return errors.New("特权不能拿该格")
		}
		g := s.Board[cell]
		p.Tokens[g]++
		s.Board[cell] = ""
		p.Privileges--
		got = append(got, colorZH[g])
	}
	if len(got) > 0 {
		s.Log = append(s.Log, fmt.Sprintf("%s 用特权拿 %v", p.Name, got))
	}
	if m.Replenish {
		if len(s.Bag) == 0 {
			return errors.New("袋中没有 token, 无法补充棋盘")
		}
		shuffle(s.Bag, s)
		for _, cell := range Spiral {
			if len(s.Bag) == 0 {
				break
			}
			if s.Board[cell] == "" {
				s.Board[cell] = pop(&s.Bag)
			}
		}
		gainPrivilege(s, 1-s.Current)
		verb := "补充了棋盘"
		if forced {
			verb = "被迫补充棋盘"
		}
		s.Log = append(s.Log, fmt.Sprintf("%s %s, %s 获得 1 特权", p.Name, verb, s.Players[1-s.Current].Name))
	}
	return nil
}
func Option(prev *State, m Move) (*State, error) {
	if prev.Over() {
		return nil, errors.New("对局已结束")
	}
	s := prev.Clone()
	if err := optional(s, m, false); err != nil {
		return nil, err
	}
	return s, nil
}
func Replenish(prev *State) (*State, error) {
	if prev.Over() {
		return nil, errors.New("对局已结束")
	}
	s := prev.Clone()
	if err := optional(s, Move{Replenish: true}, true); err != nil {
		return nil, err
	}
	return s, nil
}
func ability(s *State, who int, a *string, color Color, m Move) {
	if a == nil {
		return
	}
	p, o := &s.Players[who], &s.Players[1-who]
	switch *a {
	case "turn":
		s.ExtraTurns++
		s.Log = append(s.Log, p.Name+" 获得额外回合")
	case "privilege":
		gainPrivilege(s, who)
		s.Log = append(s.Log, p.Name+" 获得 1 特权")
	case "steal":
		pick := m.StealPick
		if pick == Gold || o.Tokens[pick] <= 0 {
			pick = ""
			if o.Tokens[Pearl] > 0 {
				pick = Pearl
			} else {
				for _, g := range Gems {
					if o.Tokens[g] > o.Tokens[pick] {
						pick = g
					}
				}
			}
		}
		if pick != "" {
			o.Tokens[pick]--
			p.Tokens[pick]++
			s.Log = append(s.Log, p.Name+" 偷取对手 "+colorZH[pick])
		}
	case "takeSame":
		if color == "" {
			return
		}
		cell := -1
		if m.TakeSameCell != nil && cellValid(*m.TakeSameCell) && s.Board[*m.TakeSameCell] == color {
			cell = *m.TakeSameCell
		} else {
			for i, g := range s.Board {
				if g == color {
					cell = i
					break
				}
			}
		}
		if cell >= 0 {
			s.Board[cell] = ""
			p.Tokens[color]++
			s.Log = append(s.Log, p.Name+" 拿同色 "+colorZH[color])
		}
	}
}
func royal(s *State, who int, m Move) {
	if len(s.Royals) == 0 {
		return
	}
	idx := -1
	if m.RoyalPick != nil && *m.RoyalPick >= 0 && *m.RoyalPick < len(s.Royals) {
		idx = *m.RoyalPick
	}
	for _, a := range []string{"turn", "privilege", "steal"} {
		if idx >= 0 {
			break
		}
		for i, r := range s.Royals {
			if r.Ability != nil && *r.Ability == a {
				idx = i
				break
			}
		}
	}
	if idx < 0 {
		idx = 0
	}
	r := s.Royals[idx]
	s.Royals = slices.Delete(s.Royals, idx, idx+1)
	p := &s.Players[who]
	p.Royals = append(p.Royals, r)
	p.Points += r.Points
	s.Log = append(s.Log, fmt.Sprintf("%s 领取皇家卡 %s(+%d分)", p.Name, r.ID, r.Points))
	ability(s, who, r.Ability, "", m)
}
func discard(s *State, who int, m Move) error {
	p := &s.Players[who]
	for c, n := range m.Discard {
		if !slices.Contains(Colors, c) || n < 0 || n > p.Tokens[c] {
			return errors.New("弃置数量无效")
		}
	}
	excess := p.TotalTokens() - 10
	if excess <= 0 {
		return nil
	}
	plan := m.Discard
	total := 0
	for _, n := range plan {
		total += n
	}
	if total != excess {
		plan = Counts{}
		left := excess
		for _, g := range Colors {
			n := min(left, p.Tokens[g])
			plan[g] = n
			left -= n
		}
	}
	for _, g := range Colors {
		n := plan[g]
		p.Tokens[g] -= n
		for i := 0; i < n; i++ {
			s.Bag = append(s.Bag, g)
		}
	}
	s.Log = append(s.Log, fmt.Sprintf("%s 弃置 %d 枚 token", p.Name, excess))
	return nil
}
func Apply(prev *State, m Move) (*State, error) {
	if prev.Over() {
		return nil, errors.New("对局已结束")
	}
	s := prev.Clone()
	who := s.Current
	p := &s.Players[who]
	s.Log = append(s.Log, fmt.Sprintf("—— 第 %d 回合 %s ——", s.Turn+1, p.Name))
	if m.ReplenishFirst {
		if m.Replenish {
			if err := optional(s, Move{Replenish: true}, false); err != nil {
				return nil, err
			}
		}
		if err := optional(s, Move{Privileges: m.Privileges}, false); err != nil {
			return nil, err
		}
	} else {
		if err := optional(s, m, false); err != nil {
			return nil, err
		}
	}
	a := m.Action
	switch a.Kind {
	case "take":
		if len(a.Cells) < 1 || len(a.Cells) > 3 {
			return nil, errors.New("只能拿 1-3 个 token")
		}
		dr, dc := 0, 0
		if len(a.Cells) > 1 {
			dr = a.Cells[1]/5 - a.Cells[0]/5
			dc = a.Cells[1]%5 - a.Cells[0]%5
			if dr < -1 || dr > 1 || dc < -1 || dc > 1 || (dr == 0 && dc == 0) {
				return nil, errors.New("token 必须连续相邻")
			}
		}
		got := []Color{}
		for i, cell := range a.Cells {
			if !cellValid(cell) || cell/5 != a.Cells[0]/5+dr*i || cell%5 != a.Cells[0]%5+dc*i || s.Board[cell] == "" || s.Board[cell] == Gold {
				return nil, errors.New("token 必须直线连续相邻且非黄金")
			}
			g := s.Board[cell]
			p.Tokens[g]++
			s.Board[cell] = ""
			got = append(got, g)
		}
		if (len(got) == 3 && got[0] == got[1] && got[1] == got[2]) || count(got, Pearl) >= 2 {
			gainPrivilege(s, 1-who)
		}
		s.Log = append(s.Log, fmt.Sprintf("%s 拿取 %v", p.Name, got))
	case "reserve":
		if len(p.Reserved) >= 3 || !cellValid(a.GoldCell) || s.Board[a.GoldCell] != Gold {
			return nil, errors.New("预留必须拿黄金且最多预留 3 张卡")
		}
		var c *Card
		switch a.From.Kind {
		case "pyramid":
			if a.From.Slot < 0 || a.From.Slot >= 12 || s.Pyramid[a.From.Slot] == nil {
				return nil, errors.New("金字塔该位置没有卡")
			}
			c = s.Pyramid[a.From.Slot]
			s.Pyramid[a.From.Slot] = pop(&s.Decks[SlotLevel(a.From.Slot)-1])
		case "deck":
			if a.From.Level < 1 || a.From.Level > 3 || len(s.Decks[a.From.Level-1]) == 0 {
				return nil, errors.New("该等级牌库已空")
			}
			copyCard := *pop(&s.Decks[a.From.Level-1])
			copyCard.Blind = true
			c = &copyCard
		default:
			return nil, errors.New("预留来源无效")
		}
		s.Board[a.GoldCell] = ""
		p.Tokens[Gold]++
		p.Reserved = append(p.Reserved, c)
		s.Log = append(s.Log, p.Name+" 预留 "+c.ID)
	case "buy":
		c := CardAt(s, who, a.From)
		if c == nil || !CanBuy(*p, c) {
			return nil, errors.New("没有该卡或买不起")
		}
		color := c.Color
		if c.Associate {
			colors := OwnedColors(*p)
			if m.AssociateColor != "" && !slices.Contains(colors, m.AssociateColor) {
				return nil, errors.New("只能叠放在自己已有的折扣卡颜色上")
			}
			color = m.AssociateColor
			if color == "" {
				counts := Counts{}
				for _, c := range p.Cards {
					counts[c.Color]++
				}
				for _, g := range Gems {
					if color == "" || counts[g] > counts[color] {
						color = g
					}
				}
			}
		}
		pay := Payment(*p, c)
		for _, g := range Colors {
			n := pay[g]
			p.Tokens[g] -= n
			for i := 0; i < n; i++ {
				s.Bag = append(s.Bag, g)
			}
		}
		if a.From.Kind == "pyramid" {
			s.Pyramid[a.From.Slot] = pop(&s.Decks[SlotLevel(a.From.Slot)-1])
		} else {
			p.Reserved = slices.Delete(p.Reserved, a.From.Index, a.From.Index+1)
		}
		p.Cards = append(p.Cards, Owned{Def: c, Color: color})
		if color != "" {
			p.Bonuses[color] += c.Bonus
		}
		p.Points += c.Points
		p.Crowns += c.Crowns
		s.Log = append(s.Log, p.Name+" 购买 "+c.ID)
		ability(s, who, c.Ability, color, m)
		if p.RoyalsTaken == 0 && p.Crowns >= 3 {
			p.RoyalsTaken = 1
			royal(s, who, m)
		}
		if p.RoyalsTaken == 1 && p.Crowns >= 6 {
			p.RoyalsTaken = 2
			royal(s, who, m)
		}
	default:
		return nil, errors.New("未知行动")
	}
	if err := discard(s, who, m); err != nil {
		return nil, err
	}
	if p.Points >= 20 || p.Crowns >= 10 || MaxColorPoints(*p) >= 10 {
		s.Winner = &who
		s.Log = append(s.Log, p.Name+" 达成胜利条件")
		return s, nil
	}
	if s.ExtraTurns > 0 {
		s.ExtraTurns--
	} else {
		s.Current = 1 - who
	}
	s.Turn++
	return s, nil
}
func count(a []Color, c Color) int {
	n := 0
	for _, v := range a {
		if v == c {
			n++
		}
	}
	return n
}
func CardAt(s *State, seat int, from Source) *Card {
	switch from.Kind {
	case "pyramid":
		if from.Slot >= 0 && from.Slot < 12 {
			return s.Pyramid[from.Slot]
		}
	case "reserved":
		if from.Index >= 0 && from.Index < len(s.Players[seat].Reserved) {
			return s.Players[seat].Reserved[from.Index]
		}
	}
	return nil
}
func ActionText(s *State, a Action) string {
	switch a.Kind {
	case "take":
		text := "拿取"
		for _, c := range a.Cells {
			text += " " + cellName(c) + colorZH[s.Board[c]]
		}
		return text
	case "reserve":
		if a.From.Kind == "deck" {
			return fmt.Sprintf("黄金+预留 L%d牌库顶", a.From.Level)
		}
		return fmt.Sprintf("黄金+预留 金字塔%d号", a.From.Slot+1)
	default:
		c := CardAt(s, s.Current, a.From)
		if c == nil {
			return "购买"
		}
		if a.From.Kind == "reserved" {
			return fmt.Sprintf("购买 预留%d %s", a.From.Index+1, c.ID)
		}
		return fmt.Sprintf("购买 金字塔%d号 %s", a.From.Slot+1, c.ID)
	}
}
