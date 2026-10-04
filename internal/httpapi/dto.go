package httpapi

import "splender/internal/game"

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
	ID          string    `json:"id,omitempty"`
	Mode        string    `json:"mode,omitempty"`
	HumanSeat   *int      `json:"humanSeat,omitempty"`
	File        string    `json:"file,omitempty"`
	ResumedFile string    `json:"resumedFile,omitempty"`
	View        any       `json:"view"`
	Seat        int       `json:"seat"`
	Current     int       `json:"current"`
	Turn        int       `json:"turn"`
	Over        bool      `json:"over"`
	Winner      *int      `json:"winner"`
	Draw        bool      `json:"draw"`
	WinReason   *string   `json:"winReason"`
	Legal       *Legal    `json:"legal"`
	Names       [2]string `json:"names"`
	RecentMoves []Visual  `json:"recentMoves"`
	Notice      *string   `json:"notice"`
	NoticeSeat  *int      `json:"noticeSeat"`
	Pending     bool      `json:"pending"`
}
type Delta struct {
	Points     int `json:"points"`
	Crowns     int `json:"crowns"`
	Privileges int `json:"privileges"`
	Tokens     int `json:"tokens"`
	Cards      int `json:"cards"`
}
type Visual struct {
	Action       game.Action  `json:"action"`
	TakeGems     []game.Color `json:"takeGems,omitempty"`
	PrivGems     []game.Color `json:"privGems,omitempty"`
	Card         *game.Card   `json:"card,omitempty"`
	Royal        *game.Royal  `json:"royal,omitempty"`
	StealGem     game.Color   `json:"stealGem,omitempty"`
	AssociateGem game.Color   `json:"associateGem,omitempty"`
	TakeSameGem  game.Color   `json:"takeSameGem,omitempty"`
	Refill       *game.Card   `json:"refill,omitempty"`
	Deltas       Delta        `json:"deltas"`
	Replenished  bool         `json:"replenished,omitempty"`
}

func (m *match) snapshot(seat int) Snapshot {
	s := m.state
	out := Snapshot{View: s.PublicView(seat), Seat: seat, Current: s.Current, Turn: s.Turn, Over: s.Over(), Winner: s.Winner, Draw: s.Draw, Names: [2]string{s.Players[0].Name, s.Players[1].Name}, RecentMoves: append([]Visual{}, m.feed...), Notice: m.notice, NoticeSeat: m.noticeSeat, Pending: m.mode == "human" && !s.Over() && s.Current != m.human}
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
	v := Visual{Action: a, Replenished: m.Replenish}
	for _, cell := range a.Cells {
		v.TakeGems = append(v.TakeGems, before.Board[cell])
	}
	for _, cell := range m.Privileges {
		v.PrivGems = append(v.PrivGems, before.Board[cell])
	}
	if a.Kind == "buy" || a.Kind == "reserve" {
		if a.From.Kind != "deck" {
			v.Card = game.CardAt(before, before.Current, a.From)
		}
		if a.From.Kind == "pyramid" {
			v.Refill = after.Pyramid[a.From.Slot]
		}
	}
	if m.RoyalPick != nil && *m.RoyalPick >= 0 && *m.RoyalPick < len(before.Royals) {
		v.Royal = &before.Royals[*m.RoyalPick]
	}
	v.StealGem = m.StealPick
	v.AssociateGem = m.AssociateColor
	if m.TakeSameCell != nil && *m.TakeSameCell >= 0 && *m.TakeSameCell < 25 {
		v.TakeSameGem = before.Board[*m.TakeSameCell]
	}
	p, n := before.Players[before.Current], after.Players[before.Current]
	v.Deltas = Delta{n.Points - p.Points, n.Crowns - p.Crowns, n.Privileges - p.Privileges, n.TotalTokens() - p.TotalTokens(), len(n.Cards) - len(p.Cards)}
	return v
}
