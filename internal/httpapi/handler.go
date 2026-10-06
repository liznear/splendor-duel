// Package httpapi exposes a stable v1 JSON contract and the existing browser routes.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"

	"splender/internal/game"
	"splender/internal/search"
)

type apiError struct {
	status        int
	code, message string
}

func (e *apiError) Error() string { return e.message }
func bad(message string) error    { return &apiError{400, "invalid_request", message} }
func write(w http.ResponseWriter, v any, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	status, code, message := 500, "internal_error", "服务器错误"
	var e *apiError
	if errors.As(err, &e) {
		status, code, message = e.status, e.code, e.message
	}
	if os.IsNotExist(err) {
		status, code, message = 404, "session_not_found", "会话不存在"
	}
	write(w, map[string]any{"error": message, "code": code}, status)
}
func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return bad("invalid JSON: " + err.Error())
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return bad("expected one JSON object")
	}
	return nil
}
func NewHandler(s *Service, publicDir string) http.Handler {
	return NewHandlerFS(s, os.DirFS(publicDir))
}

func NewHandlerFS(s *Service, publicFiles fs.FS) http.Handler {
	mux := http.NewServeMux()
	files := http.FileServerFS(publicFiles)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-cache") // 每次重验证, 静态资源永远拿最新, 无需 ?v= 版本号
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"status": "ok", "version": 1}, 200)
	})
	mux.HandleFunc("GET /api/v1/agents", func(w http.ResponseWriter, r *http.Request) { write(w, []string{"greedy", "alpha-beta", "mcts"}, 200) })
	create := func(legacy bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var req CreateRequest
			if legacy {
				var body legacyCreate
				if err := decode(w, r, &body); err != nil {
					failure(w, err)
					return
				}
				var err error
				req, err = body.convert()
				if err != nil {
					failure(w, err)
					return
				}
			} else if err := decode(w, r, &req); err != nil {
				failure(w, err)
				return
			}
			out, err := s.create(req, nil, "")
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, out, legacy)
		}
	}
	mux.HandleFunc("POST /api/new", create(true))
	mux.HandleFunc("POST /api/v1/games", create(false))
	sessions := func(w http.ResponseWriter, r *http.Request) {
		out, err := s.sessions.List()
		if err != nil {
			failure(w, err)
			return
		}
		write(w, out, 200)
	}
	mux.HandleFunc("GET /api/sessions", sessions)
	mux.HandleFunc("GET /api/v1/sessions", sessions)
	resume := func(legacy bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				File      string            `json:"file"`
				Mode      string            `json:"mode,omitempty"`
				P1        string            `json:"p1,omitempty"`
				P2        string            `json:"p2,omitempty"`
				HumanSeat *int              `json:"humanSeat,omitempty"`
				Players   *[2]search.Config `json:"players,omitempty"`
			}
			if err := decode(w, r, &body); err != nil {
				failure(w, err)
				return
			}
			record, err := s.sessions.Read(body.File)
			if err != nil {
				if !os.IsNotExist(err) {
					err = bad(err.Error())
				}
				failure(w, err)
				return
			}
			mode := body.Mode
			if mode == "" {
				mode = record.Meta.Mode
			}
			if mode == "" {
				mode = "agents"
			}
			seat := body.HumanSeat
			if seat == nil {
				seat = record.Meta.HumanSeat
			}
			req := CreateRequest{Mode: mode, HumanSeat: seat}
			for i, spec := range record.Meta.Specs {
				override := body.P1
				if i == 1 {
					override = body.P2
				}
				if override != "" {
					spec = override
				}
				if spec == "human" || spec == "" {
					spec = "greedy"
				}
				c, parseErr := search.Parse(spec)
				if parseErr != nil && override != "" {
					failure(w, bad(parseErr.Error()))
					return
				}
				if parseErr != nil {
					c, _ = search.Parse("greedy")
				}
				req.Players[i] = c
			}
			if body.Players != nil {
				req.Players = *body.Players
			}
			out, err := s.create(req, &record, body.File)
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, out, legacy)
		}
	}
	mux.HandleFunc("POST /api/resume", resume(true))
	mux.HandleFunc("POST /api/v1/sessions/resume", resume(false))
	state := func(legacy bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			seat := 0
			if raw := r.URL.Query().Get("seat"); raw != "" {
				var err error
				seat, err = strconv.Atoi(raw)
				if err != nil {
					failure(w, bad("invalid seat"))
					return
				}
			}
			out, err := s.State(r.PathValue("id"), seat)
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, out, legacy)
		}
	}
	mux.HandleFunc("GET /api/state/{id}", state(true))
	mux.HandleFunc("GET /api/v1/games/{id}", state(false))
	mutation := func(option, legacy bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Seat       *int      `json:"seat"`
				Move       game.Move `json:"move"`
				Privileges []int     `json:"privileges,omitempty"`
				Replenish  bool      `json:"replenish,omitempty"`
			}
			if err := decode(w, r, &body); err != nil {
				failure(w, err)
				return
			}
			if body.Seat == nil {
				failure(w, bad("seat is required"))
				return
			}
			var out Snapshot
			var err error
			if option {
				out, err = s.Option(r.PathValue("id"), *body.Seat, game.Move{Privileges: body.Privileges, Replenish: body.Replenish})
			} else {
				out, err = s.Move(r.PathValue("id"), *body.Seat, body.Move)
			}
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, out, legacy)
		}
	}
	mux.HandleFunc("POST /api/move/{id}", mutation(false, true))
	mux.HandleFunc("POST /api/option/{id}", mutation(true, true))
	mux.HandleFunc("POST /api/v1/games/{id}/moves", mutation(false, false))
	mux.HandleFunc("POST /api/v1/games/{id}/options", mutation(true, false))
	advance := func(human, legacy bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			out, err := s.Advance(r.Context(), r.PathValue("id"), human)
			if err != nil {
				failure(w, err)
				return
			}
			respond(w, out, legacy)
		}
	}
	mux.HandleFunc("POST /api/bot/{id}", advance(true, true))
	mux.HandleFunc("POST /api/step/{id}", advance(false, true))
	mux.HandleFunc("POST /api/v1/games/{id}/bot", advance(true, false))
	mux.HandleFunc("POST /api/v1/games/{id}/step", advance(false, false))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, &apiError{404, "endpoint_not_found", "未知接口"})
	})
	return mux
}
func respond(w http.ResponseWriter, out Snapshot, legacy bool) {
	if !legacy {
		write(w, out, 200)
		return
	}
	write(w, struct {
		Snapshot
		OK bool `json:"ok"`
	}{out, true}, 200)
}

type legacyCreate struct {
	Mode      string `json:"mode"`
	P1        string `json:"p1"`
	P2        string `json:"p2"`
	HumanSeat *int   `json:"humanSeat"`
	Seed      *int64 `json:"seed"`
}

func (b legacyCreate) convert() (CreateRequest, error) {
	req := CreateRequest{Mode: b.Mode, HumanSeat: b.HumanSeat, Seed: b.Seed}
	human := 1
	if b.HumanSeat != nil {
		human = *b.HumanSeat
	}
	for i, spec := range []string{b.P1, b.P2} {
		if b.Mode == "human" && i == human {
			continue
		}
		if spec == "" {
			spec = "greedy"
		}
		c, err := search.Parse(spec)
		if err != nil {
			return req, bad(err.Error())
		}
		req.Players[i] = c
	}
	return req, nil
}
