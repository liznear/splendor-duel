// Replay a session file and print per-turn player summaries (points, crowns,
// per-color points, tokens, bonuses) to locate how a game was decided.
//
// Usage: go run ./cmd/replay -f sessions/2026-xx.jsonl
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"splender/internal/game"
	"splender/internal/session"
)

func jshort(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "?"
	}
	if len(b) > 300 {
		return string(b[:300]) + "..."
	}
	return string(b)
}

func cardStr(c *game.Card) string {
	if c == nil {
		return "nil"
	}
	if c.ID == "hidden" {
		return "hidden"
	}
	ab := ""
	if c.Ability != nil {
		ab = *c.Ability
	}
	return fmt.Sprintf("L%d %s pts=%d bonus=%d crowns=%d ab=%s cost=%v assoc=%v", c.Level, c.Color, c.Points, c.Bonus, c.Crowns, ab, c.Cost, c.Associate)
}

func dumpFull(s *game.State, ev int, e *session.Event) {
	fmt.Printf("===== STATE BEFORE event %d (t=%s turn=%d seat=%d) =====\n", ev, e.Type, e.Turn, e.Seat)
	fmt.Printf("current=%d turn=%d extraTurns=%d draw=%v winner=%v rngState=%d bagN=%d\n", s.Current, s.Turn, s.ExtraTurns, s.Draw, s.Winner, s.RNGState, len(s.Bag))
	fmt.Printf("board:\n")
	for r := 0; r < 5; r++ {
		fmt.Printf("  %s %s %s %s %s\n", cellName(s.Board[r*5]), cellName(s.Board[r*5+1]), cellName(s.Board[r*5+2]), cellName(s.Board[r*5+3]), cellName(s.Board[r*5+4]))
	}
	fmt.Printf("bag counts: %v\n", bagCounts(s.Bag))
	fmt.Printf("royals: %v\n", s.Royals)
	for lvl, d := range s.Decks {
		fmt.Printf("deck L%d n=%d top=%s\n", lvl+1, len(d), cardStr(top(d)))
	}
	fmt.Printf("pyramid:\n")
	for i, c := range s.Pyramid {
		fmt.Printf("  slot%-2d %s\n", i, cardStr(c))
	}
	for seat, p := range s.Players {
		fmt.Printf("seat%d %s: pts=%d crowns=%d priv=%d tokens=%v royals=%d\n", seat, p.Name, p.Points, p.Crowns, p.Privileges, p.Tokens, len(p.Royals))
		colorN := map[string]int{}
		for _, c := range p.Cards {
			fmt.Printf("    card %s (def color %s)\n", cardStr(c.Def), c.Color)
			colorN[string(c.Color)]++
		}
		fmt.Printf("    owned color counts: %v\n", colorN)
		for i, c := range p.Reserved {
			fmt.Printf("    reserved[%d] %s\n", i, cardStr(c))
		}
	}
}

func top(d []*game.Card) *game.Card {
	if len(d) == 0 {
		return nil
	}
	return d[len(d)-1]
}

var cellCodes = map[game.Color]string{
	"black": "bk", "red": "rd", "green": "gr", "blue": "bl", "white": "wh",
	game.Pearl: "pe", game.Gold: "au", "": " .",
}

func cellName(g game.Color) string { return cellCodes[g] }

func bagCounts(bag []game.Color) map[string]int {
	m := map[string]int{}
	for _, g := range bag {
		m[string(g)]++
	}
	return m
}

// boardSummary counts cells by color and lists pearl/gold cell positions.
func boardSummary(s *game.State) string {
	counts := map[string]int{}
	pearls, golds, empty := []int{}, []int{}, 0
	for i, g := range s.Board {
		switch g {
		case "":
			empty++
		case game.Pearl:
			counts["pearl"]++
			pearls = append(pearls, i)
		case game.Gold:
			counts["gold"]++
			golds = append(golds, i)
		default:
			counts[string(g)]++
		}
	}
	return fmt.Sprintf("%v pearls@%v gold@%v empty=%d bag=%v", counts, pearls, golds, empty, bagCounts(s.Bag))
}

func dump(s *game.State, tag string) {
	for seat, p := range s.Players {
		colorPts, maxPts := map[string]int{}, 0
		for _, c := range p.Cards {
			colorPts[string(c.Color)] += c.Def.Points
		}
		for _, n := range colorPts {
			maxPts = max(maxPts, n)
		}
		royals := 0
		for _, r := range p.Royals {
			royals += r.Points
		}
		fmt.Printf("%s seat%d %-12s pts=%2d crowns=%2d priv=%d tokens=%v reserved=%d royals=%d colorPts=%v(max %d)\n",
			tag, seat, p.Name, p.Points, p.Crowns, p.Privileges, p.Tokens, len(p.Reserved), royals, colorPts, maxPts)
	}
}

func main() {
	file := flag.String("f", "", "session file")
	stop := flag.Int("stop", -1, "dump full state before applying this event index, then exit")
	flag.Parse()
	if *file == "" {
		fmt.Fprintln(os.Stderr, "usage: replay -f sessions/<file>.jsonl [-stop N]")
		os.Exit(1)
	}
	rec, err := (session.Store{Dir: filepath.Dir(*file)}).Read(filepath.Base(*file))
	if err != nil {
		panic(err)
	}
	fmt.Printf("seed=%d first=%v names=%v specs=%v\n", rec.Meta.Seed, rec.Meta.FirstSeat, rec.Meta.Names, rec.Meta.Specs)
	s := game.New(rec.Meta.Seed, rec.Meta.Names, rec.Meta.FirstSeat)
	for i, e := range rec.Prefix() {
		if i == *stop {
			dumpFull(s, i, &e)
			return
		}
		if s.Over() {
			fmt.Printf("\n*** GAME OVER at event %d before applying more events\n", i)
			break
		}
		switch e.Type {
		case "move":
			s, err = game.Apply(s, *e.Move)
			if err != nil {
				panic(fmt.Sprintf("event %d: %v", i, err))
			}
			wr := ""
			if e.Search != nil && e.Search.WinRate != nil {
				wr = fmt.Sprintf(" sims=%d wr=%.3f", e.Search.Simulations, *e.Search.WinRate)
			}
			fmt.Printf("\n== ev%-3d turn=%-3d seat=%d %s%s\n", i, e.Turn, e.Seat, jshort(e.Move), wr)
			dump(s, "  after")
		case "option":
			s, err = game.Option(s, game.Move{Privileges: e.Privileges, Replenish: e.Replenish})
			if err != nil {
				panic(fmt.Sprintf("event %d: %v", i, err))
			}
			fmt.Printf("== ev%-3d OPTION seat=%d replenish=%v privileges=%v board: %s\n", i, e.Seat, e.Replenish, e.Privileges, boardSummary(s))
		}
	}
	if *stop >= 0 {
		fmt.Println("(stop past end)")
		return
	}
	if s.Over() {
		w := "draw"
		if s.Winner != nil {
			w = fmt.Sprintf("seat%d (%s)", *s.Winner, s.Players[*s.Winner].Name)
		}
		fmt.Printf("\n*** GAME OVER: %s after %d turns\n", w, s.Turn)
		dump(s, "  final")
	} else {
		fmt.Println("\n(game not over)")
	}
}
