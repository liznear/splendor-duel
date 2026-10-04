package httpapi

import "splender/internal/game"

type BotSearch struct {
	Simulations     int      `json:"simulations"`
	MoveSimulations int      `json:"moveSimulations"`
	WinRate         *float64 `json:"winRate"`
	Turn            int      `json:"turn"`
}

// These DTOs define the versioned wire contract independently of storage and search.
type LegalAction struct {
	Index       int         `json:"i"`
	Action      game.Action `json:"action"`
	Description string      `json:"desc"`
}
type Legal struct {
	Actions        []LegalAction `json:"actions"`
	CanReplenish   bool          `json:"canReplenish"`
	MustReplenish  bool          `json:"mustReplenish"`
	PrivilegeCells []int         `json:"privilegeCells"`
}
type Snapshot struct {
	ID           string        `json:"id,omitempty"`
	Mode         string        `json:"mode,omitempty"`
	HumanSeat    *int          `json:"humanSeat,omitempty"`
	File         string        `json:"file,omitempty"`
	ResumedFile  string        `json:"resumedFile,omitempty"`
	View         any           `json:"view"`
	Seat         int           `json:"seat"`
	Current      int           `json:"current"`
	Turn         int           `json:"turn"`
	Over         bool          `json:"over"`
	Winner       *int          `json:"winner"`
	Draw         bool          `json:"draw"`
	WinReason    *string       `json:"winReason"`
	Legal        *Legal        `json:"legal"`
	Names        [2]string     `json:"names"`
	RecentMoves  []Visual      `json:"recentMoves"`
	BotSearch    [2]*BotSearch `json:"botSearch"`
	BotTimeoutMS [2]int        `json:"botTimeoutMs"`
	Notice       *string       `json:"notice"`
	NoticeSeat   *int          `json:"noticeSeat"`
	Pending      bool          `json:"pending"`
}
type Delta struct {
	Points     int `json:"points"`
	Crowns     int `json:"crowns"`
	Privileges int `json:"privileges"`
	Tokens     int `json:"tokens"`
	Cards      int `json:"cards"`
}
type Visual struct {
	Action         game.Action  `json:"action"`
	TakeGems       []game.Color `json:"takeGems,omitempty"`
	PrivGems       []game.Color `json:"privGems,omitempty"`
	Card           *game.Card   `json:"card,omitempty"`
	Royal          *game.Royal  `json:"royal,omitempty"`
	Royals         []game.Royal `json:"royals,omitempty"`
	StealGem       game.Color   `json:"stealGem,omitempty"`
	StealGems      []game.Color `json:"stealGems,omitempty"`
	AssociateGem   game.Color   `json:"associateGem,omitempty"`
	TakeSameGem    game.Color   `json:"takeSameGem,omitempty"`
	Refill         *game.Card   `json:"refill,omitempty"`
	Deltas         Delta        `json:"deltas"`
	Payment        game.Counts  `json:"payment,omitempty"`
	TokenChanges   game.Counts  `json:"tokenChanges,omitempty"`
	Replenished    bool         `json:"replenished,omitempty"`
	ReplenishFirst bool         `json:"replenishFirst,omitempty"`
}

func (m *match) snapshot(seat int) Snapshot {
	s := m.state
	out := Snapshot{View: s.PublicView(seat), Seat: seat, Current: s.Current, Turn: s.Turn, Over: s.Over(), Winner: s.Winner, Draw: s.Draw, Names: [2]string{s.Players[0].Name, s.Players[1].Name}, RecentMoves: append([]Visual{}, m.feed...), Notice: m.notice, NoticeSeat: m.noticeSeat, Pending: m.mode == "human" && !s.Over() && s.Current != m.human}
	out.BotSearch = m.botSearch
	for i, agent := range m.agents {
		out.BotTimeoutMS[i] = agent.TimeMS
	}
	if s.Winner != nil {
		p := s.Players[*s.Winner]
		reason := "同色10分"
		if p.Points >= 20 {
			reason = "20分"
		} else if p.Crowns >= 10 {
			reason = "10皇冠"
		}
		out.WinReason = &reason
	}
	if !s.Over() && s.Current == seat {
		l := game.LegalMoves(s)
		out.Legal = &Legal{Actions: []LegalAction{}, CanReplenish: l.CanReplenish, MustReplenish: l.MustReplenish, PrivilegeCells: l.PrivilegeCells}
		for i, a := range l.Actions {
			out.Legal.Actions = append(out.Legal.Actions, LegalAction{i, a, game.ActionText(s, a)})
		}
	}
	return out
}
func visual(before, after *game.State, m game.Move) Visual {
	a := m.Action
	v := Visual{Action: a, Replenished: m.Replenish, ReplenishFirst: m.ReplenishFirst}
	// Optional actions can fill previously empty cells before privileges or the main move.
	privBoard := before
	if m.ReplenishFirst && m.Replenish {
		if next, err := game.Option(before, game.Move{Replenish: true}); err == nil {
			privBoard = next
		}
	}
	for _, cell := range m.Privileges {
		v.PrivGems = append(v.PrivGems, privBoard.Board[cell])
	}
	mainBoard := privBoard
	if len(m.Privileges) > 0 || m.Replenish && !m.ReplenishFirst {
		if next, err := game.Option(privBoard, game.Move{Privileges: m.Privileges, Replenish: m.Replenish && !m.ReplenishFirst}); err == nil {
			mainBoard = next
		}
	}
	for _, cell := range a.Cells {
		v.TakeGems = append(v.TakeGems, mainBoard.Board[cell])
	}
	if a.Kind == "buy" || a.Kind == "reserve" {
		if a.From.Kind != "deck" {
			v.Card = game.CardAt(before, before.Current, a.From)
		}
		if a.From.Kind == "pyramid" {
			v.Refill = after.Pyramid[a.From.Slot]
		}
	}
	p, n := before.Players[before.Current], after.Players[before.Current]
	if len(n.Royals) > len(p.Royals) {
		v.Royals = append([]game.Royal{}, n.Royals[len(p.Royals):]...)
		v.Royal = &v.Royals[0]
	}
	for _, color := range game.Colors {
		lost := before.Players[1-before.Current].Tokens[color] - after.Players[1-before.Current].Tokens[color]
		for i := 0; i < lost; i++ {
			v.StealGems = append(v.StealGems, color)
		}
	}
	if len(v.StealGems) > 0 {
		v.StealGem = v.StealGems[0]
	}
	if a.Kind == "buy" && len(n.Cards) > len(p.Cards) {
		owned := n.Cards[len(n.Cards)-1]
		v.Payment = game.Payment(mainBoard.Players[before.Current], owned.Def)
		if owned.Def.Associate {
			v.AssociateGem = owned.Color
		}
		if owned.Def.Ability != nil && *owned.Def.Ability == "takeSame" {
			for _, color := range mainBoard.Board {
				if color != "" && color == owned.Color {
					v.TakeSameGem = color
					break
				}
			}
		}
	}
	v.TokenChanges = game.Counts{}
	for _, color := range game.Colors {
		if change := n.Tokens[color] - p.Tokens[color]; change != 0 {
			v.TokenChanges[color] = change
		}
	}
	v.Deltas = Delta{n.Points - p.Points, n.Crowns - p.Crowns, n.Privileges - p.Privileges, n.TotalTokens() - p.TotalTokens(), len(n.Cards) - len(p.Cards)}
	return v
}
