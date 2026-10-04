// Package game implements the rules as immutable state transitions.
package game

import "encoding/json"

type Color string

const Gold Color = "gold"
const Pearl Color = "pearl"

var Gems = []Color{"black", "red", "green", "blue", "white"}
var Colors = []Color{"black", "red", "green", "blue", "white", Pearl, Gold}

// Empty colors are encoded as null for card colors and board cells.
func (c Color) MarshalJSON() ([]byte, error) {
	if c == "" {
		return []byte("null"), nil
	}
	return json.Marshal(string(c))
}
func (c *Color) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*c = ""
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	*c = Color(s)
	return nil
}

type Counts map[Color]int
type Card struct {
	ID        string  `json:"id"`
	Level     int     `json:"level"`
	Color     Color   `json:"color"`
	Associate bool    `json:"isAssociate"`
	Points    int     `json:"points"`
	Bonus     int     `json:"bonus"`
	Ability   *string `json:"ability"`
	Crowns    int     `json:"crowns"`
	Cost      Counts  `json:"cost"`
	Blind     bool    `json:"blind,omitempty"`
}
type Royal struct {
	ID      string  `json:"id"`
	Points  int     `json:"points"`
	Ability *string `json:"ability"`
}
type Owned struct {
	Def   *Card `json:"def"`
	Color Color `json:"color"`
}
type Player struct {
	Name        string  `json:"name"`
	Tokens      Counts  `json:"tokens"`
	Bonuses     Counts  `json:"bonuses"`
	Cards       []Owned `json:"cards"`
	Reserved    []*Card `json:"reserved"`
	Royals      []Royal `json:"royals"`
	Privileges  int     `json:"privileges"`
	Crowns      int     `json:"crowns"`
	Points      int     `json:"points"`
	RoyalsTaken int     `json:"royalsTaken"`
}
type State struct {
	Board      [25]Color  `json:"board"`
	Bag        []Color    `json:"bag"`
	Decks      [3][]*Card `json:"decks"`
	Pyramid    [12]*Card  `json:"pyramid"`
	Royals     []Royal    `json:"royals"`
	Players    [2]Player  `json:"players"`
	Current    int        `json:"current"`
	ExtraTurns int        `json:"extraTurns"`
	Turn       int        `json:"turnCount"`
	Winner     *int       `json:"winner"`
	Draw       bool       `json:"draw"`
	Seed       int64      `json:"seed"`
	RNGState   int32      `json:"rngState"`
	Log        []string   `json:"log"`
}
type Source struct {
	Kind  string `json:"kind"`
	Slot  int    `json:"slot,omitempty"`
	Index int    `json:"index,omitempty"`
	Level int    `json:"level,omitempty"`
}

// Zero is a valid slot/index/cell. Explicitly serialize fields by action variant.
func (s Source) MarshalJSON() ([]byte, error) {
	switch s.Kind {
	case "pyramid":
		return json.Marshal(struct {
			Kind string `json:"kind"`
			Slot int    `json:"slot"`
		}{s.Kind, s.Slot})
	case "reserved":
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			Index int    `json:"index"`
		}{s.Kind, s.Index})
	default:
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			Level int    `json:"level"`
		}{s.Kind, s.Level})
	}
}

type Action struct {
	Kind     string `json:"kind"`
	Cells    []int  `json:"cells,omitempty"`
	GoldCell int    `json:"goldCell,omitempty"`
	From     Source `json:"from"`
}

func (a Action) MarshalJSON() ([]byte, error) {
	switch a.Kind {
	case "take":
		return json.Marshal(struct {
			Kind  string `json:"kind"`
			Cells []int  `json:"cells"`
		}{a.Kind, a.Cells})
	case "reserve":
		return json.Marshal(struct {
			Kind     string `json:"kind"`
			GoldCell int    `json:"goldCell"`
			From     Source `json:"from"`
		}{a.Kind, a.GoldCell, a.From})
	default:
		return json.Marshal(struct {
			Kind string `json:"kind"`
			From Source `json:"from"`
		}{a.Kind, a.From})
	}
}

type Move struct {
	Privileges     []int  `json:"privileges,omitempty"`
	Replenish      bool   `json:"replenish,omitempty"`
	ReplenishFirst bool   `json:"replenishFirst,omitempty"`
	Action         Action `json:"action"`
	AssociateColor Color  `json:"associateColor,omitempty"`
	RoyalPick      *int   `json:"royalPick,omitempty"`
	StealPick      Color  `json:"stealPick,omitempty"`
	TakeSameCell   *int   `json:"takeSameCell,omitempty"`
	Discard        Counts `json:"discard,omitempty"`
}
type Legal struct {
	Actions        []Action `json:"actions"`
	CanReplenish   bool     `json:"canReplenish"`
	MustReplenish  bool     `json:"mustReplenish"`
	PrivilegeCells []int    `json:"privilegeCells"`
}

func NewCounts(colors []Color) Counts {
	m := Counts{}
	for _, c := range colors {
		m[c] = 0
	}
	return m
}
func (p Player) TotalTokens() int {
	n := 0
	for _, c := range Colors {
		n += p.Tokens[c]
	}
	return n
}
func (s *State) Over() bool { return s.Winner != nil || s.Draw }
