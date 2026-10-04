package search

import (
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
)

type Config struct {
	Kind        string `json:"kind"`
	TimeMS      int    `json:"timeMs,omitempty"`
	Parallelism int    `json:"parallelism,omitempty"`
}

func Parse(spec string) (Config, error) {
	parts := strings.Split(spec, "@")
	if len(parts) > 2 {
		return Config{}, errors.New("invalid agent spec")
	}
	c := Config{Kind: parts[0]}
	if kind, count, hasWorkers := strings.Cut(c.Kind, "/"); hasWorkers {
		switch kind {
		case "mcts":
			c.Kind = "mcts"
		case "ab", "alpha-beta":
			c.Kind = "alpha-beta"
		default:
			return c, errors.New("unsupported parallel agent")
		}
		workers, err := strconv.Atoi(count)
		if err != nil || workers < 1 {
			return c, errors.New("invalid parallelism")
		}
		c.Parallelism = workers
	}
	switch c.Kind {
	case "ab":
		c.Kind = "alpha-beta"
	case "par-ab":
		c.Kind = "alpha-beta"
		c.Parallelism = min(8, runtime.GOMAXPROCS(0))
	case "mcts2":
		c.Kind = "mcts"
	case "par-mcts2":
		c.Kind = "mcts"
		c.Parallelism = min(8, runtime.GOMAXPROCS(0))
	}
	if len(parts) == 2 {
		ms, err := strconv.Atoi(parts[1])
		if err != nil {
			return c, errors.New("invalid search time")
		}
		c.TimeMS = ms
	}
	return Normalize(c)
}
func Normalize(c Config) (Config, error) {
	if c.Kind != "greedy" && c.Kind != "alpha-beta" && c.Kind != "mcts" {
		return c, fmt.Errorf("unsupported agent: %s", c.Kind)
	}
	if c.TimeMS == 0 {
		c.TimeMS = 4000
	}
	if c.TimeMS < 1 || c.TimeMS > 120000 {
		return c, errors.New("timeMs must be 1..120000")
	}
	if c.Parallelism == 0 {
		c.Parallelism = 1
	}
	if c.Parallelism < 1 || c.Parallelism > 32 {
		return c, errors.New("parallelism must be 1..32")
	}
	if c.Kind == "greedy" && c.Parallelism != 1 {
		return c, errors.New("greedy does not support parallelism")
	}
	return c, nil
}
func (c Config) Name() string {
	switch c.Kind {
	case "greedy":
		return "贪心bot"
	case "alpha-beta":
		if c.Parallelism > 1 {
			return fmt.Sprintf("αβbot(%d goroutines)", c.Parallelism)
		}
		return "αβbot"
	default:
		if c.Parallelism > 1 {
			return fmt.Sprintf("MCTSbot(%d goroutines)", c.Parallelism)
		}
		return "MCTSbot"
	}
}
