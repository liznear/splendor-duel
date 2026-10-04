package search

import (
	"runtime"
	"testing"
)

func TestParallelAlphaBetaConfig(t *testing.T) {
	for _, spec := range []string{"ab/8@1000", "alpha-beta/8@1000", "par-ab@1000"} {
		c, err := Parse(spec)
		if err != nil {
			t.Fatalf("%s: %v", spec, err)
		}
		workers := 8
		if spec == "par-ab@1000" {
			workers = min(8, runtime.GOMAXPROCS(0))
		}
		if c.Kind != "alpha-beta" || c.Parallelism != workers || c.TimeMS != 1000 {
			t.Fatalf("unexpected config: %+v", c)
		}
	}
	for _, spec := range []string{"ab/0", "ab/33", "ab/no", "ab/1/2", "greedy/8"} {
		if _, err := Parse(spec); err == nil {
			t.Fatalf("accepted invalid spec %s", spec)
		}
	}
	if _, err := Normalize(Config{Kind: "alpha-beta", Parallelism: 8}); err != nil {
		t.Fatal(err)
	}
	if _, err := Normalize(Config{Kind: "greedy", Parallelism: 8}); err == nil {
		t.Fatal("greedy accepted parallelism")
	}
}
