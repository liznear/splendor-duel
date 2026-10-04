package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"splender/internal/game"
	"splender/internal/search"
	"splender/internal/session"
)

func harness(t *testing.T) (*Service, http.Handler) {
	t.Helper()
	s := NewService(t.TempDir(), 2)
	t.Cleanup(s.Close)
	return s, NewHandler(s, "../../public")
}
func request(t *testing.T, h http.Handler, method, path string, body any) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	out := map[string]any{}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(w.Body.String(), err)
	}
	return w.Code, out
}
func created(t *testing.T, h http.Handler, legacy bool, mode string, seat int, agent string) map[string]any {
	t.Helper()
	path := "/api/v1/games"
	body := any(map[string]any{"mode": mode, "humanSeat": seat, "seed": 42, "players": []any{map[string]any{"kind": agent, "timeMs": 100}, map[string]any{"kind": "greedy"}}})
	if legacy {
		path = "/api/new"
		body = map[string]any{"mode": mode, "humanSeat": seat, "seed": 42, "p1": "greedy", "p2": "greedy"}
	}
	status, out := request(t, h, "POST", path, body)
	if status != 200 {
		t.Fatal(out)
	}
	return out
}
func TestHumanContract(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprint(legacy), func(t *testing.T) {
			_, h := harness(t)
			out := created(t, h, legacy, "human", 1, "greedy")
			id := out["id"].(string)
			base := "/api/v1/games/" + id
			bot := base + "/bot"
			state := base + "?seat=1"
			option := base + "/options"
			move := base + "/moves"
			if legacy {
				bot = "/api/bot/" + id
				state = "/api/state/" + id + "?seat=1"
				option = "/api/option/" + id
				move = "/api/move/" + id
			}
			if out["pending"] != true {
				t.Fatal("missing pending")
			}
			status, out := request(t, h, "POST", bot, map[string]any{})
			if status != 200 || out["current"] != float64(1) {
				t.Fatal("bot did not yield", out)
			}
			if _, exists := out["botMessage"]; exists {
				t.Fatal("LLM field remains")
			}
			legal := out["legal"].(map[string]any)
			cell := int(legal["privilegeCells"].([]any)[0].(float64))
			status, out = request(t, h, "POST", option, map[string]any{"seat": 1, "privileges": []int{cell}})
			if status != 200 {
				t.Fatal(out)
			}
			view := out["view"].(map[string]any)
			if view["board"].([]any)[cell] != nil {
				t.Fatal("privilege not immediate")
			}
			if _, exists := view["seed"]; exists {
				t.Fatal("private seed leaked")
			}
			actions := out["legal"].(map[string]any)["actions"].([]any)
			action := actions[0].(map[string]any)["action"]
			status, _ = request(t, h, "POST", move, map[string]any{"seat": 0, "move": map[string]any{"action": action}})
			if status != 400 {
				t.Fatal("opponent seat accepted")
			}
			status, out = request(t, h, "POST", move, map[string]any{"seat": 1, "move": map[string]any{"action": action}})
			if status != 200 || out["pending"] != true {
				t.Fatal(out)
			}
			status, out = request(t, h, "GET", state, nil)
			if status != 200 {
				t.Fatal(out)
			}
			status, _ = request(t, h, "POST", base+"/step", map[string]any{})
			if status != 400 {
				t.Fatal("human step accepted")
			}
		})
	}
}
func TestAgentsFinishAndSessionResume(t *testing.T) {
	s, h := harness(t)
	out := created(t, h, false, "agents", 0, "greedy")
	id := out["id"].(string)
	file := out["file"].(string)
	for i := 0; i < 600 && out["over"] != true; i++ {
		status, next := request(t, h, "POST", "/api/v1/games/"+id+"/step", map[string]any{})
		if status != 200 {
			t.Fatal(next)
		}
		out = next
	}
	if out["over"] != true {
		t.Fatal("game never finished")
	}
	m, err := s.get(id)
	if err != nil {
		t.Fatal(err)
	}
	record, err := s.sessions.Read(file)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := record.Replay()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replayed, m.state) {
		t.Fatal("session replay mismatch")
	}
	status, resumed := request(t, h, "POST", "/api/v1/sessions/resume", map[string]any{"file": file})
	if status != 200 || resumed["over"] != true {
		t.Fatal(resumed)
	}
	if resumed["resumedFile"] != file {
		t.Fatal("missing resume file")
	}
}
func TestValidation(t *testing.T) {
	_, h := harness(t)
	for _, body := range []any{map[string]any{"mode": "oops"}, map[string]any{"mode": "human", "humanSeat": 2}, map[string]any{"mode": "agents", "players": []any{map[string]any{"kind": "llm"}}}, map[string]any{"mode": "agents", "surprise": true}} {
		status, out := request(t, h, "POST", "/api/v1/games", body)
		if status != 400 || out["code"] != "invalid_request" {
			t.Fatal("accepted invalid request", out)
		}
	}
	out := created(t, h, false, "human", 0, "greedy")
	id := out["id"].(string)
	for _, path := range []string{"/api/v1/games/" + id + "?seat=2", "/api/v1/games/" + id + "?seat=NaN"} {
		status, _ := request(t, h, "GET", path, nil)
		if status != 400 {
			t.Fatal("accepted invalid seat")
		}
	}
	status, _ := request(t, h, "POST", "/api/v1/games/"+id+"/moves", map[string]any{"move": map[string]any{"action": map[string]any{"kind": "take", "cells": []int{0}}}})
	if status != 400 {
		t.Fatal("missing seat accepted")
	}
	status, _ = request(t, h, "POST", "/api/v1/games/"+id+"/moves", map[string]any{"seat": 0, "move": map[string]any{"action": map[string]any{"kind": "take", "cells": []int{-1}}}})
	if status != 400 {
		t.Fatal("invalid move accepted")
	}
	status, _ = request(t, h, "POST", "/api/v1/sessions/resume", map[string]any{"file": "../secret.jsonl"})
	if status != 400 {
		t.Fatal("path traversal accepted")
	}
	status, _ = request(t, h, "GET", "/api/v1/games/missing", nil)
	if status != 404 {
		t.Fatal("missing game status")
	}
	for _, body := range []string{"{", "{} {}"} {
		r := httptest.NewRequest("POST", "/api/v1/games", bytes.NewBufferString(body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("bad JSON accepted")
		}
	}
}
func TestConcurrentAdvanceAndResponsiveReads(t *testing.T) {
	s, h := harness(t)
	out := created(t, h, false, "agents", 0, "mcts")
	id := out["id"].(string)
	m, _ := s.get(id)
	m.agents[0].TimeMS = 180
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; _, err := s.Advance(context.Background(), id, false); errs <- err }()
	}
	close(start)
	deadline := time.Now().Add(time.Second)
	for {
		m.mu.Lock()
		running := m.job != nil
		m.mu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("search never started")
		}
		time.Sleep(time.Millisecond)
	}
	before := time.Now()
	status, _ := request(t, h, "GET", "/api/v1/games/"+id, nil)
	if status != 200 || time.Since(before) > 100*time.Millisecond {
		t.Fatal("read blocked on search")
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	m.mu.Lock()
	turn := m.state.Turn
	m.mu.Unlock()
	if turn != 1 {
		t.Fatalf("duplicate requests advanced %d turns", turn)
	}
	record, err := s.sessions.Read(out["file"].(string))
	if err != nil {
		t.Fatal(err)
	}
	moves := 0
	for _, e := range record.Events {
		if e.Type == "move" {
			moves++
		}
	}
	if moves != 1 {
		t.Fatalf("recorded %d moves", moves)
	}
}
func TestLegacyLLMResumeFallsBackToGreedy(t *testing.T) {
	s, h := harness(t)
	first := 0
	human := 1
	rec, err := s.sessions.Create(session.Meta{Seed: 42, Names: [2]string{"LLM", "你"}, Specs: [2]string{"llm:old/model", "human"}, Mode: "human", HumanSeat: &human, FirstSeat: &first})
	if err != nil {
		t.Fatal(err)
	}
	status, out := request(t, h, "POST", "/api/resume", map[string]any{"file": rec.File()})
	if status != 200 {
		t.Fatal(out)
	}
	names := out["names"].([]any)
	if names[0] != "贪心bot" {
		t.Fatal("LLM session was not migrated")
	}
}
func TestStaticAndHealth(t *testing.T) {
	_, h := harness(t)
	for _, path := range []string{"/", "/app.js", "/api.js", "/preview.js", "/style.css", "/cards/1-1.png", "/api/v1/health", "/api/v1/agents"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
}
func TestCanceledCallerDoesNotCancelSharedSearch(t *testing.T) {
	s, _ := harness(t)
	seed := int64(42)
	out, err := s.create(CreateRequest{Mode: "agents", Seed: &seed, Players: [2]search.Config{{Kind: "mcts", TimeMS: 100}, {Kind: "greedy"}}}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.Advance(ctx, out.ID, false)
	if err != context.Canceled {
		t.Fatal(err)
	}
	_, err = s.Advance(context.Background(), out.ID, false)
	if err != nil {
		t.Fatal(err)
	}
}
func TestMutationDoesNotChangeStateOnFailure(t *testing.T) {
	s, _ := harness(t)
	seed := int64(42)
	human := 0
	out, err := s.create(CreateRequest{Mode: "human", Seed: &seed, HumanSeat: &human}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	m, _ := s.get(out.ID)
	before := m.state
	_, err = s.Move(out.ID, 0, game.Move{Action: game.Action{Kind: "take", Cells: []int{0, 12}}})
	if err == nil || m.state != before {
		t.Fatal("invalid move altered state")
	}
}

func TestResumedNamesAndParallelSettingsReplay(t *testing.T) {
	s, h := harness(t)
	out := created(t, h, false, "agents", 0, "greedy")
	file := out["file"].(string)
	for i := 0; i < 2; i++ {
		status, next := request(t, h, "POST", "/api/v1/sessions/resume", map[string]any{"file": file, "players": []any{map[string]any{"kind": "mcts", "timeMs": 80, "parallelism": 2}, map[string]any{"kind": "greedy"}}})
		if status != 200 {
			t.Fatal(next)
		}
		id := next["id"].(string)
		m, err := s.get(id)
		if err != nil {
			t.Fatal(err)
		}
		if m.agents[0].Parallelism != 2 {
			t.Fatal("lost parallelism")
		}
		_, err = s.Advance(context.Background(), id, false)
		if err != nil {
			t.Fatal(err)
		}
		file = next["file"].(string)
		record, err := s.sessions.Read(file)
		if err != nil {
			t.Fatal(err)
		}
		replayed, err := record.Replay()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(replayed, m.state) {
			t.Fatal("changed names not replayable")
		}
		cfg, err := search.Parse(record.Meta.Specs[0])
		if err != nil || cfg.Parallelism != 2 {
			t.Fatal("settings not persisted", err)
		}
	}
}
