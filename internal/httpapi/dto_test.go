package httpapi

import (
	"context"
	"testing"

	"splender/internal/game"
	"splender/internal/search"
)

func TestVisualIncludesDefaultAbilityResults(t *testing.T) {
	for _, kind := range []string{"takeSame", "steal", "turn", "privilege"} {
		t.Run(kind, func(t *testing.T) {
			first := 0
			s := game.New(42, [2]string{"Bot", "Human"}, &first)
			s.Pyramid[0] = &game.Card{ID: "test", Color: "blue", Ability: &kind, Cost: game.Counts{}, Crowns: 3}
			s.Board[0] = "blue"
			s.Players[1].Tokens[game.Pearl] = 1
			m := game.Move{Action: game.Action{Kind: "buy", From: game.Source{Kind: "pyramid", Slot: 0}}}
			n, err := game.Apply(s, m)
			if err != nil {
				t.Fatal(err)
			}
			v := visual(s, n, m)
			if v.Royal == nil {
				t.Fatal("default royal selection missing from recap")
			}
			if kind == "takeSame" && v.TakeSameGem != "blue" {
				t.Fatal("default same-color ability missing from recap")
			}
			if kind == "steal" && v.StealGem != game.Pearl {
				t.Fatal("default stolen gem missing from recap")
			}
		})
	}
}

func TestVisualUsesBoardAfterOptionalActions(t *testing.T) {
	for _, replenishFirst := range []bool{false, true} {
		first := 0
		s := game.New(42, [2]string{"Bot", "Human"}, &first)
		for i := range s.Board {
			s.Board[i] = "blue"
		}
		s.Board[0] = ""
		s.Bag = []game.Color{"red"}
		m := game.Move{Replenish: true, ReplenishFirst: replenishFirst, Action: game.Action{Kind: "take", Cells: []int{0}}}
		if replenishFirst {
			s.Players[0].Privileges = 1
			m.Privileges = []int{0}
			m.Action.Cells = []int{1}
		}
		n, err := game.Apply(s, m)
		if err != nil {
			t.Fatal(err)
		}
		v := visual(s, n, m)
		if replenishFirst {
			if !v.ReplenishFirst || len(v.PrivGems) != 1 || v.PrivGems[0] != "red" {
				t.Fatalf("wrong optional order/snapshot: %+v", v)
			}
		} else if len(v.TakeGems) != 1 || v.TakeGems[0] != "red" {
			t.Fatalf("wrong taken gem snapshot: %+v", v)
		}
	}
}

func TestSnapshotReportsLatestBotSearch(t *testing.T) {
	s, _ := harness(t)
	seed := int64(42)
	out, err := s.create(CreateRequest{Mode: "agents", Seed: &seed, Players: [2]search.Config{{Kind: "mcts", TimeMS: 100, Parallelism: 2}, {Kind: "greedy"}}}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if out.BotSearch[0] != nil {
		t.Fatal("new game must not invent search statistics")
	}
	if out.BotTimeoutMS[0] != 100 {
		t.Fatalf("configured timeout missing from snapshot: %v", out.BotTimeoutMS)
	}
	id := out.ID
	out, err = s.Advance(context.Background(), id, false)
	if err != nil {
		t.Fatal(err)
	}
	stats := out.BotSearch[0]
	if stats == nil || stats.Simulations <= 0 || stats.WinRate == nil || stats.Turn != 1 {
		t.Fatalf("missing completed bot search: %+v", stats)
	}
	current, err := s.State(id, 0)
	if err != nil || current.BotSearch[0] != stats || current.BotSearch[1] != nil {
		t.Fatal("state endpoint lost search stats or invented stats for greedy agent", err)
	}
}
