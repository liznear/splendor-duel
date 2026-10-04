package search

import "testing"

func TestRefillConfiguration(t *testing.T) {
	for _, spec := range []string{"mcts", "mcts/8@1000", "par-mcts2@5000"} {
		c, err := Parse(spec)
		if err != nil || c.IncludeRefill {
			t.Fatalf("default refill config for %s: %+v, %v", spec, c, err)
		}
	}
	for _, spec := range []string{"mcts+refill", "mcts/8+refill@1000", "par-mcts2+refill@5000"} {
		c, err := Parse(spec)
		if err != nil || !c.IncludeRefill || c.Kind != "mcts" {
			t.Fatalf("enabled refill config for %s: %+v, %v", spec, c, err)
		}
	}
	for _, spec := range []string{"greedy+refill", "ab+refill", "mcts+unknown", "mcts+refill+refill"} {
		if _, err := Parse(spec); err == nil {
			t.Fatalf("accepted invalid refill config %s", spec)
		}
	}
	if _, err := Normalize(Config{Kind: "greedy", IncludeRefill: true}); err == nil {
		t.Fatal("accepted refill flag for a non-MCTS agent")
	}
}
