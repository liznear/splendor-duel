package session

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"splender/internal/game"
)

func TestRecordReplayAndResumeChain(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	first := 0
	seat := 1
	meta := Meta{Seed: 42, Names: [2]string{"A", "B"}, Specs: [2]string{"greedy", "greedy"}, Mode: "human", FirstSeat: &first, HumanSeat: &seat}
	rec, err := store.Create(meta)
	if err != nil {
		t.Fatal(err)
	}
	s := game.New(42, meta.Names, &first)
	rate := .625
	stats := &SearchStats{Simulations: 100, MoveSimulations: 40, WinRate: &rate}
	for i := 0; i < 8; i++ {
		m := game.Move{Action: game.LegalMoves(s).Actions[0]}
		event := Event{Type: "move", Seat: s.Current, Turn: s.Turn, Move: &m}
		if i == 0 {
			event.Search = stats
		}
		if err = rec.Write(event); err != nil {
			t.Fatal(err)
		}
		s, err = game.Apply(s, m)
		if err != nil {
			t.Fatal(err)
		}
	}
	r, err := store.Read(rec.File())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.Events[0].Search, stats) || r.Events[1].Search != nil {
		t.Fatal("search statistics did not round-trip")
	}
	replayed, err := r.Replay()
	if err != nil || !reflect.DeepEqual(replayed, s) {
		t.Fatal("replay differs", err)
	}
	for i := 0; i < 2; i++ {
		meta.Resume = &Prefix{Seed: 42, FirstSeat: &first, Events: r.Prefix()}
		rec, err = store.Create(meta)
		if err != nil {
			t.Fatal(err)
		}
		m := game.Move{Action: game.LegalMoves(s).Actions[0]}
		err = rec.Write(Event{Type: "move", Move: &m})
		if err != nil {
			t.Fatal(err)
		}
		s, err = game.Apply(s, m)
		if err != nil {
			t.Fatal(err)
		}
		r, err = store.Read(rec.File())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(r.Prefix()[0].Search, stats) {
			t.Fatal("resume prefix lost search statistics")
		}
		replayed, err = r.Replay()
		if err != nil || !reflect.DeepEqual(replayed, s) {
			t.Fatal("nested resume differs", err)
		}
	}
	err = rec.Write(Event{Type: "result", Outcome: "draw", Turns: 10})
	if err != nil {
		t.Fatal(err)
	}
	err = rec.Write(Event{Type: "result", Outcome: "draw", Turns: 10})
	if err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil || len(list) != 3 {
		t.Fatal("session list", err)
	}
	r, err = store.Read(rec.File())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range r.Events {
		if e.Type == "result" {
			n++
		}
	}
	if n != 1 {
		t.Fatal("duplicate result")
	}
}
func TestOptionAndForcedRefillReplay(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	first := 0
	meta := Meta{Seed: 9, Names: [2]string{"A", "B"}, FirstSeat: &first}
	s := game.New(9, meta.Names, &first)
	move := game.Move{Action: game.LegalMoves(s).Actions[0]}
	s, err := game.Apply(s, move)
	if err != nil {
		t.Fatal(err)
	}
	cell := game.LegalMoves(s).PrivilegeCells[0]
	events := []Event{{Type: "move", Move: &move}, {Type: "option", Privileges: []int{cell}}}
	s, err = game.Option(s, game.Move{Privileges: []int{cell}})
	if err != nil {
		t.Fatal(err)
	}
	for len(s.Bag) == 0 {
		m := game.Move{Action: game.LegalMoves(s).Actions[0]}
		events = append(events, Event{Type: "move", Move: &m})
		s, err = game.Apply(s, m)
		if err != nil {
			t.Fatal(err)
		}
	}
	events = append(events, Event{Type: "replenish"})
	s, err = game.Replenish(s)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := store.Create(meta)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if err = rec.Write(e); err != nil {
			t.Fatal(err)
		}
	}
	r, err := store.Read(rec.File())
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.Replay()
	if err != nil || !reflect.DeepEqual(s, out) {
		t.Fatal("option/refill replay", err)
	}
}
func TestInvalidSessions(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	for _, name := range []string{"../secret.jsonl", "/secret.jsonl", "", "secret.txt"} {
		if _, err := store.Read(name); err == nil {
			t.Fatal("accepted invalid filename")
		}
	}
	if _, err := store.Read("missing.jsonl"); err == nil {
		t.Fatal("missing file")
	}
	if err := os.WriteFile(store.Dir+"/bad.jsonl", []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read("bad.jsonl"); err == nil {
		t.Fatal("accepted missing meta")
	}
	r := Record{Meta: Meta{Seed: 1}, Events: []Event{{Type: "move"}}}
	if _, err := r.Replay(); err == nil {
		t.Fatal("accepted missing move")
	}
	r.Events = []Event{{Type: "surprise"}}
	if _, err := r.Replay(); err == nil {
		t.Fatal("accepted unknown event")
	}
	bad := 2
	r.Meta.FirstSeat = &bad
	if _, err := r.Replay(); err == nil {
		t.Fatal("accepted invalid seat")
	}
	_, err := json.Marshal(Event{Type: "move", Move: &game.Move{Action: game.Action{Kind: "take", Cells: []int{0}}}})
	if err != nil {
		t.Fatal(err)
	}
}
