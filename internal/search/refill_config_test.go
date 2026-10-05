package search

import "testing"

func TestRefillConfiguration(t *testing.T) {
	for _, spec := range []string{"mcts", "mcts/8@1000", "par-mcts2@5000", "mcts+refill", "mcts/8+refill@1000", "par-mcts2+refill@5000"} {
		c, err := Parse(spec)
		if err != nil || c.RefillTurn != DefaultRefillTurn {
			t.Fatalf("default refill turn for %s: %+v, %v", spec, c, err)
		}
	}
	for _, spec := range []string{"greedy+refill", "ab+refill", "mcts+unknown", "mcts+refill+refill", "greedy+refill:30", "ab/8+refill:30"} {
		if _, err := Parse(spec); err == nil {
			t.Fatalf("accepted invalid refill config %s", spec)
		}
	}
}

func TestRefillTurnConfiguration(t *testing.T) {
	c, err := Parse("mcts/8+refill:1000@5000")
	if err != nil || c.RefillTurn != 1000 {
		t.Fatalf("refill:1000 config: %+v, %v", c, err)
	}
	for _, spec := range []string{"mcts", "mcts/8+refill@1000"} {
		c, err := Parse(spec)
		if err != nil || c.RefillTurn != DefaultRefillTurn {
			t.Fatalf("default refill turn for %s: %+v, %v", spec, c, err)
		}
	}
	for _, spec := range []string{"mcts+refill:0@1000", "mcts+refill:1001@1000", "mcts+refill:x@1000", "mcts+refill:30+refill:40"} {
		if _, err := Parse(spec); err == nil {
			t.Fatalf("accepted invalid refill turn %s", spec)
		}
	}
}
