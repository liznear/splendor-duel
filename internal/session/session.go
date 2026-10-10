// Package session stores append-only game events compatible with existing JSONL sessions.
package session

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"splender/internal/game"
)

type Prefix struct {
	Seed      int64      `json:"seed"`
	FirstSeat *int       `json:"firstSeat,omitempty"`
	Names     *[2]string `json:"names,omitempty"`
	Events    []Event    `json:"events"`
}
type Meta struct {
	Type        string    `json:"t"`
	Started     string    `json:"started"`
	Seed        int64     `json:"seed"`
	Names       [2]string `json:"names"`
	Specs       [2]string `json:"specs"`
	Mode        string    `json:"mode"`
	FirstSeat   *int      `json:"firstSeat,omitempty"`
	HumanSeat   *int      `json:"humanSeat,omitempty"`
	ResumedFrom string    `json:"resumedFrom,omitempty"`
	Resume      *Prefix   `json:"resume,omitempty"`
}

// SearchStats records completed MCTS rollouts from the acting player's perspective.
// WinRate is an average rollout reward, not a calibrated win probability.
type SearchStats struct {
	Simulations     int      `json:"simulations"`
	MoveSimulations int      `json:"moveSimulations"`
	WinRate         *float64 `json:"winRate"`
}

type Event struct {
	Type       string       `json:"t"`
	Seat       int          `json:"seat,omitempty"`
	Turn       int          `json:"turn,omitempty"`
	Move       *game.Move   `json:"move,omitempty"`
	Search     *SearchStats `json:"search,omitempty"`
	Privileges []int        `json:"privileges,omitempty"`
	Replenish  bool         `json:"replenish,omitempty"`
	Outcome    string       `json:"outcome,omitempty"`
	Turns      int          `json:"turns,omitempty"`
	Names      *[2]string   `json:"names,omitempty"`
}
type Record struct {
	Meta   Meta
	Events []Event
}
type Store struct{ Dir string }
type Recorder struct {
	path string
	done bool
}

func (s Store) Create(meta Meta) (*Recorder, error) {
	if err := os.MkdirAll(s.Dir, 0755); err != nil {
		return nil, err
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	meta.Type = "meta"
	meta.Started = time.Now().UTC().Format(time.RFC3339Nano)
	name := time.Now().UTC().Format("2006-01-02-15-04-05") + "-" + hex.EncodeToString(b) + ".jsonl"
	r := &Recorder{path: filepath.Join(s.Dir, name)}
	data, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	if err = os.WriteFile(r.path, append(data, '\n'), 0600); err != nil {
		return nil, err
	}
	return r, nil
}
func (r *Recorder) File() string { return filepath.Base(r.path) }

// Rewrite atomically replaces the session file with rec and revives a
// recorder that had stopped on a recorded result.
func (r *Recorder) Rewrite(rec Record) error {
	var b bytes.Buffer
	meta := rec.Meta
	meta.Type = "meta"
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	b.Write(data)
	b.WriteByte('\n')
	for _, e := range rec.Events {
		data, err := json.Marshal(e)
		if err != nil {
			return err
		}
		b.Write(data)
		b.WriteByte('\n')
	}
	tmp := r.path + ".tmp"
	if err = os.WriteFile(tmp, b.Bytes(), 0600); err != nil {
		return err
	}
	if err = os.Rename(tmp, r.path); err != nil {
		return err
	}
	r.done = false
	return nil
}
func (r *Recorder) Write(e Event) error {
	if r.done {
		return nil
	}
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(append(data, '\n'))
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if e.Type == "result" {
		r.done = true
	}
	return nil
}
func (s Store) Read(file string) (Record, error) {
	var r Record
	if file == "" || filepath.Base(file) != file || !strings.HasSuffix(file, ".jsonl") {
		return r, errors.New("invalid session filename")
	}
	f, err := os.Open(filepath.Join(s.Dir, file))
	if err != nil {
		return r, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 16<<20)
	if !scanner.Scan() {
		return r, errors.New("session has no metadata")
	}
	if err = json.Unmarshal(scanner.Bytes(), &r.Meta); err != nil {
		return r, err
	}
	if r.Meta.Type != "meta" {
		return r, errors.New("session has no metadata")
	}
	r.Events = []Event{}
	for scanner.Scan() {
		var e Event
		if err = json.Unmarshal(scanner.Bytes(), &e); err != nil {
			return r, err
		}
		r.Events = append(r.Events, e)
	}
	return r, scanner.Err()
}
func (r Record) Prefix() []Event {
	out := []Event{}
	if r.Meta.Resume != nil {
		out = append(out, r.Meta.Resume.Events...)
	}
	for _, e := range r.Events {
		if e.Type != "result" {
			out = append(out, e)
		}
	}
	return out
}
func (r Record) initial() (*game.State, error) {
	seed, first, names := r.Meta.Seed, r.Meta.FirstSeat, r.Meta.Names
	if r.Meta.Resume != nil {
		seed = r.Meta.Resume.Seed
		first = r.Meta.Resume.FirstSeat
		if r.Meta.Resume.Names != nil {
			names = *r.Meta.Resume.Names
		}
	}
	if first != nil && (*first < 0 || *first > 1) {
		return nil, errors.New("invalid first seat")
	}
	return game.New(seed, names, first), nil
}

// Step applies one recorded event, mirroring the live game transitions.
func Step(s *game.State, e Event) (*game.State, error) {
	switch e.Type {
	case "names":
		if e.Names == nil {
			return nil, errors.New("missing recorded names")
		}
		for i, name := range *e.Names {
			s.Players[i].Name = name
		}
		return s, nil
	case "move":
		if e.Move == nil {
			return nil, errors.New("missing recorded move")
		}
		return game.Apply(s, *e.Move)
	case "option":
		return game.Option(s, game.Move{Privileges: e.Privileges, Replenish: e.Replenish})
	case "replenish":
		return game.Replenish(s)
	}
	return nil, fmt.Errorf("unknown event: %s", e.Type)
}

func (r Record) Replay() (*game.State, error) {
	s, err := r.initial()
	if err != nil {
		return nil, err
	}
	for i, e := range r.Prefix() {
		if s.Over() {
			break
		}
		s, err = Step(s, e)
		if err != nil {
			return nil, fmt.Errorf("event %d: %w", i, err)
		}
	}
	return s, nil
}

// Rewind truncates the record to just before seat's most recent decision
// (their last recorded move or option) and replays the kept events. Events
// past that point, including the opponent's reply and a trailing result,
// are dropped. ok is false when seat has no recorded decision to undo.
func (r Record) Rewind(seat int) (Record, *game.State, bool, error) {
	events := r.Prefix()
	resume := 0
	if r.Meta.Resume != nil {
		resume = len(r.Meta.Resume.Events)
	}
	cut := -1
	for i := len(events) - 1; i >= 0; i-- {
		e := events[i]
		if (e.Type == "move" || e.Type == "option") && e.Seat == seat {
			cut = i
			break
		}
	}
	if cut < 0 {
		return Record{}, nil, false, nil
	}
	kept := events[:cut]
	out := Record{Meta: r.Meta, Events: []Event{}}
	if r.Meta.Resume != nil && cut < resume {
		// The cut reaches into the resumed prefix: shrink it instead of the
		// session's own events, which are dropped entirely.
		res := *r.Meta.Resume
		res.Events = append([]Event{}, kept...)
		out.Meta.Resume = &res
	} else {
		out.Events = append([]Event{}, kept[resume:]...)
	}
	state, err := out.Replay()
	if err != nil {
		return Record{}, nil, false, err
	}
	return out, state, true, nil
}

type Summary struct {
	File    string    `json:"file"`
	Started string    `json:"started"`
	Names   [2]string `json:"names"`
	Specs   [2]string `json:"specs"`
	Mode    string    `json:"mode"`
	Moves   int       `json:"moves"`
	Outcome string    `json:"outcome"`
	Turns   int       `json:"turns,omitempty"`
}

func (s Store) List() ([]Summary, error) {
	files, err := os.ReadDir(s.Dir)
	if os.IsNotExist(err) {
		return []Summary{}, nil
	}
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, f := range files {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".jsonl") {
			names = append(names, f.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	out := []Summary{}
	for _, name := range names {
		if len(out) >= 50 {
			break
		}
		r, err := s.Read(name)
		if err != nil {
			continue
		}
		v := Summary{File: name, Started: r.Meta.Started, Names: r.Meta.Names, Specs: r.Meta.Specs, Mode: r.Meta.Mode, Outcome: "未完"}
		for _, e := range r.Events {
			if e.Type == "move" {
				v.Moves++
			}
			if e.Type == "result" {
				v.Outcome = e.Outcome
				v.Turns = e.Turns
			}
		}
		out = append(out, v)
	}
	return out, nil
}
