package httpapi

import (
	"splender/internal/search"
	"testing"
)

func TestParallelAlphaBetaSpecRoundTrip(t *testing.T) {
	original := search.Config{Kind: "alpha-beta", Parallelism: 8, TimeMS: 1000}
	recorded := spec(original)
	if recorded != "ab/8@1000" {
		t.Fatalf("lost parallelism: %s", recorded)
	}
	parsed, err := search.Parse(recorded)
	if err != nil || parsed != original {
		t.Fatalf("round trip: %+v %v", parsed, err)
	}
}
