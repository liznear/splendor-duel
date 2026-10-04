package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"splender/internal/game"
	"splender/internal/search"
	"splender/internal/session"
)

type match struct {
	mu         sync.Mutex
	state      *game.State
	agents     [2]search.Config
	mode       string
	human      int
	feed       []Visual
	notice     *string
	noticeSeat *int
	recorder   *session.Recorder
	job        *job
}
type job struct {
	done chan struct{}
	err  error
}
type Service struct {
	mu       sync.RWMutex
	games    map[string]*match
	sessions session.Store
	ctx      context.Context
	cancel   context.CancelFunc
	slots    chan struct{}
}

func NewService(dir string, maxSearches int) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{games: map[string]*match{}, sessions: session.Store{Dir: dir}, ctx: ctx, cancel: cancel, slots: make(chan struct{}, max(1, maxSearches))}
}
func (s *Service) Close() { s.cancel() }

type CreateRequest struct {
	Mode      string           `json:"mode"`
	Players   [2]search.Config `json:"players"`
	HumanSeat *int             `json:"humanSeat,omitempty"`
	Seed      *int64           `json:"seed,omitempty"`
}

func (s *Service) create(req CreateRequest, record *session.Record, resumed string) (Snapshot, error) {
	if req.Mode != "human" && req.Mode != "agents" {
		return Snapshot{}, bad("mode must be human or agents")
	}
	human := 0
	if req.Mode == "human" {
		human = 1
		if req.HumanSeat != nil {
			human = *req.HumanSeat
		}
		if !seatValid(human) {
			return Snapshot{}, bad("invalid humanSeat")
		}
	}
	names := [2]string{}
	specs := [2]string{}
	for i := range req.Players {
		if req.Mode == "human" && i == human {
			names[i] = "你"
			specs[i] = "human"
			continue
		}
		c := req.Players[i]
		if c.Kind == "" {
			c.Kind = "greedy"
		}
		var err error
		c, err = search.Normalize(c)
		if err != nil {
			return Snapshot{}, bad(err.Error())
		}
		req.Players[i] = c
		names[i] = c.Name()
		specs[i] = spec(c)
	}
	seed := int64(0)
	if req.Seed != nil {
		seed = *req.Seed
	} else {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return Snapshot{}, err
		}
		for _, v := range b {
			seed = seed*256 + int64(v)
		}
	}
	first := 0
	meta := session.Meta{Seed: seed, Names: names, Specs: specs, Mode: req.Mode, FirstSeat: &first}
	if req.Mode == "human" {
		meta.HumanSeat = &human
	}
	state := game.New(seed, names, &first)
	if record != nil {
		var err error
		state, err = record.Replay()
		if err != nil {
			return Snapshot{}, bad(err.Error())
		}
		originalNames := record.Meta.Names
		originalSeed := record.Meta.Seed
		originalFirst := record.Meta.FirstSeat
		if record.Meta.Resume != nil {
			originalSeed = record.Meta.Resume.Seed
			originalFirst = record.Meta.Resume.FirstSeat
			if record.Meta.Resume.Names != nil {
				originalNames = *record.Meta.Resume.Names
			}
		}
		meta.Seed = originalSeed
		meta.FirstSeat = originalFirst
		meta.ResumedFrom = resumed
		meta.Resume = &session.Prefix{Seed: originalSeed, FirstSeat: originalFirst, Names: &originalNames, Events: record.Prefix()}
	}
	rec, err := s.sessions.Create(meta)
	if err != nil {
		return Snapshot{}, err
	}
	if record != nil && ([2]string{state.Players[0].Name, state.Players[1].Name} != names) {
		if err = rec.Write(session.Event{Type: "names", Names: &names}); err != nil {
			return Snapshot{}, err
		}
		for i := range names {
			state.Players[i].Name = names[i]
		}
	}
	m := &match{state: state, agents: req.Players, mode: req.Mode, human: human, feed: []Visual{}, recorder: rec}
	if err = m.ensurePlayable(); err != nil {
		return Snapshot{}, err
	}
	idBytes := make([]byte, 12)
	if _, err = rand.Read(idBytes); err != nil {
		return Snapshot{}, err
	}
	id := hex.EncodeToString(idBytes)
	s.mu.Lock()
	s.games[id] = m
	s.mu.Unlock()
	out := m.snapshot(human)
	out.ID = id
	out.Mode = req.Mode
	out.HumanSeat = &human
	out.File = rec.File()
	out.ResumedFile = resumed
	return out, nil
}
func spec(c search.Config) string {
	kind := c.Kind
	if kind == "alpha-beta" {
		kind = "ab"
	}
	if c.Kind == "mcts" && c.Parallelism > 1 {
		kind = fmt.Sprintf("mcts/%d", c.Parallelism)
	}
	if c.Kind == "greedy" {
		return kind
	}
	return fmt.Sprintf("%s@%d", kind, c.TimeMS)
}
func (s *Service) get(id string) (*match, error) {
	s.mu.RLock()
	m := s.games[id]
	s.mu.RUnlock()
	if m == nil {
		return nil, &apiError{404, "game_not_found", "对局不存在"}
	}
	return m, nil
}
func seatValid(seat int) bool { return seat == 0 || seat == 1 }
func (m *match) ensurePlayable() error {
	if m.state.Over() {
		return m.recordResult()
	}
	l := game.LegalMoves(m.state)
	if len(l.Actions) > 0 {
		return nil
	}
	if !l.CanReplenish {
		m.state = m.state.Clone()
		m.state.Draw = true
		return m.recordResult()
	}
	next, err := game.Replenish(m.state)
	if err != nil {
		return err
	}
	if err = m.recorder.Write(session.Event{Type: "replenish"}); err != nil {
		return err
	}
	m.state = next
	notice := "🔄 " + next.Log[len(next.Log)-1]
	seat := next.Current
	m.notice = &notice
	m.noticeSeat = &seat
	return nil
}
func (m *match) recordResult() error {
	if !m.state.Over() {
		return nil
	}
	outcome := "draw"
	if m.state.Winner != nil {
		outcome = fmt.Sprintf("p%d", *m.state.Winner)
	}
	return m.recorder.Write(session.Event{Type: "result", Outcome: outcome, Turns: m.state.Turn})
}
func (m *match) humanTurn(seat int) error {
	if m.mode != "human" {
		return bad("该对局不是人机模式")
	}
	if !seatValid(seat) || seat != m.human || seat != m.state.Current || m.state.Over() || m.job != nil {
		return bad("当前不是你的回合")
	}
	return nil
}
func (s *Service) State(id string, seat int) (Snapshot, error) {
	if !seatValid(seat) {
		return Snapshot{}, bad("invalid seat")
	}
	m, err := s.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshot(seat), nil
}
func (s *Service) Move(id string, seat int, move game.Move) (Snapshot, error) {
	m, err := s.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err = m.humanTurn(seat); err != nil {
		return Snapshot{}, err
	}
	next, err := game.Apply(m.state, move)
	if err != nil {
		return Snapshot{}, bad("走法无效: " + err.Error())
	}
	if err = m.recorder.Write(session.Event{Type: "move", Seat: seat, Turn: m.state.Turn, Move: &move}); err != nil {
		return Snapshot{}, err
	}
	m.state = next
	m.feed = []Visual{}
	m.notice = nil
	m.noticeSeat = nil
	if err = m.ensurePlayable(); err != nil {
		return Snapshot{}, err
	}
	return m.snapshot(m.human), nil
}
func (s *Service) Option(id string, seat int, move game.Move) (Snapshot, error) {
	m, err := s.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err = m.humanTurn(seat); err != nil {
		return Snapshot{}, err
	}
	if len(move.Privileges) == 0 && !move.Replenish {
		return Snapshot{}, bad("无可执行的可选行动")
	}
	next, err := game.Option(m.state, move)
	if err != nil {
		return Snapshot{}, bad("操作无效: " + err.Error())
	}
	if err = m.recorder.Write(session.Event{Type: "option", Seat: seat, Privileges: move.Privileges, Replenish: move.Replenish}); err != nil {
		return Snapshot{}, err
	}
	m.state = next
	if err = m.ensurePlayable(); err != nil {
		return Snapshot{}, err
	}
	return m.snapshot(m.human), nil
}

// Advance coalesces duplicate requests. The shared operation is owned by the
// service context; one disconnected HTTP caller cannot cancel another's turn.
func (s *Service) Advance(ctx context.Context, id string, human bool) (Snapshot, error) {
	m, err := s.get(id)
	if err != nil {
		return Snapshot{}, err
	}
	m.mu.Lock()
	if (m.mode == "human") != human {
		m.mu.Unlock()
		return Snapshot{}, bad("对局模式不匹配")
	}
	j := m.job
	if j == nil {
		j = &job{done: make(chan struct{})}
		m.job = j
		go s.run(m, j, human)
	}
	m.mu.Unlock()
	select {
	case <-ctx.Done():
		return Snapshot{}, ctx.Err()
	case <-j.done:
		if j.err != nil {
			return Snapshot{}, j.err
		}
		seat := 0
		if human {
			seat = m.human
		}
		return s.State(id, seat)
	}
}
func (s *Service) run(m *match, j *job, human bool) {
	var err error
	defer func() { m.mu.Lock(); j.err = err; m.job = nil; close(j.done); m.mu.Unlock() }()
	for turns := 0; turns < 200; turns++ {
		m.mu.Lock()
		err = m.ensurePlayable()
		if err != nil || m.state.Over() || human && m.state.Current == m.human {
			m.mu.Unlock()
			return
		}
		state := m.state
		agent := m.agents[state.Current]
		m.mu.Unlock()
		select {
		case s.slots <- struct{}{}:
		case <-s.ctx.Done():
			err = s.ctx.Err()
			return
		}
		move, chooseErr := search.Choose(s.ctx, state, agent)
		<-s.slots
		if chooseErr != nil {
			err = chooseErr
			return
		}
		next, applyErr := game.Apply(state, move)
		if applyErr != nil {
			err = applyErr
			return
		}
		m.mu.Lock()
		err = m.recorder.Write(session.Event{Type: "move", Seat: state.Current, Turn: state.Turn, Move: &move})
		if err == nil {
			m.feed = append(m.feed, visual(state, next, move))
			if len(m.feed) > 20 {
				m.feed = m.feed[len(m.feed)-20:]
			}
			m.state = next
			err = m.ensurePlayable()
		}
		m.mu.Unlock()
		if err != nil || !human {
			return
		}
	}
	err = errors.New("bot turn limit exceeded")
}
