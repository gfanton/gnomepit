package bridge

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func decode[T any](t *testing.T, s string) T {
	t.Helper()
	var v T
	require.NoError(t, json.Unmarshal([]byte(s), &v), s)
	return v
}

func encode(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

type errorView struct{ Error string }

func loaded(t *testing.T) (*Bridge, RulesetView) {
	t.Helper()
	data, err := os.ReadFile("../web/cards.json")
	require.NoError(t, err)
	b := New()
	out := b.Load(string(data))
	require.NotContains(t, out, `"error"`)
	return b, decode[RulesetView](t, out)
}

func card(t *testing.T, view RulesetView, name string) CardView {
	t.Helper()
	for _, c := range view.Cards {
		if c.Name == name {
			return c
		}
	}
	require.Failf(t, "unknown card", "%q", name)
	return CardView{}
}

func ids(t *testing.T, view RulesetView, names ...string) []int {
	t.Helper()
	out := make([]int, 0, len(names))
	for _, n := range names {
		out = append(out, card(t, view, n).ID)
	}
	return out
}

func clan(t *testing.T, view RulesetView, name string) ClanView {
	t.Helper()
	for _, c := range view.Clans {
		if c.Name == name {
			return c
		}
	}
	require.Failf(t, "unknown clan", "%q", name)
	return ClanView{}
}

// starterDecks are the duel spec's 8-card starter decks: each pool minus its two pack cards.
func starterDecks(t *testing.T, view RulesetView) [2][]int {
	t.Helper()
	without := func(pool, drop []int) []int {
		var out []int
		for _, id := range pool {
			if !slices.Contains(drop, id) {
				out = append(out, id)
			}
		}
		return out
	}
	return [2][]int{
		without(clan(t, view, "Pickers").Cards, ids(t, view, "Hunker Down", "Boot and Heel")),
		without(clan(t, view, "Ironhide").Cards, ids(t, view, "Shield Catch", "Loose Timbers")),
	}
}

func start(hp int) StateView {
	return StateView{Round: 1, Gnomes: [2]GnomeView{{HP: hp}, {HP: hp}}}
}

func TestLoadView(t *testing.T) {
	_, view := loaded(t)
	assert.Equal(t, 15, view.HP)
	assert.Len(t, view.Cards, 22)

	undermine := card(t, view, "Undermine")
	assert.True(t, undermine.Rare)
	assert.True(t, undermine.Interrupt)
	assert.Equal(t, "Quick", undermine.Tier)
	assert.Equal(t, "Interrupt (cancels a card winding up). If this cancels a card, apply 2 Vulnerable.", undermine.Text)
	assert.Equal(t, "Deal 1 damage 3 times.", card(t, view, "Double Tap").Text)

	require.Len(t, view.Clans, 2)
	assert.Equal(t, "Ironhide", view.Clans[0].Name)
	assert.Equal(t, "Pickers", view.Clans[1].Name)
	assert.Len(t, view.Clans[0].Cards, 10)
	assert.Len(t, view.Clans[1].Cards, 10)
}

func TestShippedStarterDecksAreLegal(t *testing.T) {
	b, view := loaded(t)
	decks := starterDecks(t, view)
	legal := func(clanName string, deck []int) bool {
		out := b.LegalDeck(encode(t, LegalDeckRequest{Clan: clanName, Deck: deck}))
		return decode[struct{ Legal bool }](t, out).Legal
	}
	assert.True(t, legal("Pickers", decks[0]))
	assert.True(t, legal("Ironhide", decks[1]))
	undermine := card(t, view, "Undermine").ID
	assert.False(t, legal("Pickers", slices.DeleteFunc(slices.Clone(decks[0]), func(id int) bool { return id == undermine })))
}

func TestLegalPlans(t *testing.T) {
	b, view := loaded(t)
	decks := starterDecks(t, view)
	out := b.LegalPlans(encode(t, LegalPlansRequest{State: start(view.HP), Side: 0, Deck: decks[0]}))
	plans := decode[struct{ Plans [][]int }](t, out).Plans
	require.NotEmpty(t, plans)
	seen := map[string]bool{}
	for _, p := range plans {
		beats := 0
		for _, id := range p {
			beats += view.Cards[id].Cost
		}
		assert.Equal(t, 3, beats, "%v", p)
		key := encode(t, p)
		assert.False(t, seen[key], "%v twice", p)
		seen[key] = true
	}
	pick := card(t, view, "Pick").ID
	assert.True(t, seen[encode(t, []int{pick, pick, pick})])
}

// The duel spec's worked example under the shipped numbers: Hammer Blow deals 5 and Double
// Tap hits 3 times.
func TestResolveWorkedExample(t *testing.T) {
	b, view := loaded(t)
	decks := starterDecks(t, view)
	a, bb := ids(t, view, "Chalk Dust", "Double Tap"), ids(t, view, "Hammer Blow", "Spiked Shield")
	out := b.Resolve(encode(t, ResolveRequest{State: start(view.HP), Decks: decks, A: a, B: bb}))
	resp := decode[ResolveResponse](t, out)
	assert.Equal(t, "ongoing", resp.Result)
	assert.Equal(t, 2, resp.State.Round)
	assert.Equal(t, [2]int{7, 12}, [2]int{resp.State.Gnomes[0].HP, resp.State.Gnomes[1].HP})
	assert.Equal(t, slices.Sorted(slices.Values(a)), resp.State.Gnomes[0].Spent)
	require.Len(t, resp.Events, 10)
	assert.Equal(t, "HitLanded", resp.Events[1].Kind)
	assert.Equal(t, 5, resp.Events[1].N)
	assert.True(t, resp.Events[4].Doubled)
	assert.Equal(t, 0, resp.Events[4].After[1].Block)
	assert.Equal(t, "Damage", resp.Events[4].Phase)
	assert.Equal(t, "Normal", resp.Events[4].Tier)
}

func TestErrors(t *testing.T) {
	b, view := loaded(t)
	decks := starterDecks(t, view)
	pick := card(t, view, "Pick").ID
	cases := map[string]struct {
		out  string
		want string
	}{
		"before load":     {New().LegalDeck(encode(t, LegalDeckRequest{Clan: "Pickers"})), "no card file loaded"},
		"bad card file":   {New().Load("{"), "parse card file"},
		"bad request":     {b.Resolve("{"), "parse request"},
		"unknown clan":    {b.LegalDeck(encode(t, LegalDeckRequest{Clan: "Delvers"})), `clan "Delvers" unknown`},
		"bad side":        {b.LegalPlans(encode(t, LegalPlansRequest{State: start(view.HP), Side: 2, Deck: decks[0]})), "side must be 0 or 1"},
		"bad round":       {b.LegalPlans(encode(t, LegalPlansRequest{State: StateView{Round: 0}, Side: 0, Deck: decks[0]})), "round must be 1 to 3"},
		"card id too big": {b.Resolve(encode(t, ResolveRequest{State: start(view.HP), Decks: decks, A: []int{99}, B: []int{pick, pick, pick}})), "card id 99 out of range"},
		"illegal plan":    {b.Resolve(encode(t, ResolveRequest{State: start(view.HP), Decks: decks, A: []int{pick}, B: []int{pick, pick, pick}})), "is not legal for side 0"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Contains(t, decode[errorView](t, tc.out).Error, tc.want)
		})
	}
}

// Blowback lands on beat 2 and moves side A's 2 Vulnerable to side B.
func TestResolveNamesTheVulnerableMove(t *testing.T) {
	const cards = `{"Cards": [
		{"Name": "Brace", "Cost": 1, "Tier": "Normal", "Block": [["GainBlock", 1]]},
		{"Name": "Blowback", "Cost": 2, "Tier": "Normal", "Special": true, "Block": [["MoveVulnerable", 0]]}
	], "Clans": {"Delvers": ["Blowback"]}, "Rules": {}}`
	b := New()
	require.NotContains(t, b.Load(cards), `"error"`)
	s := StateView{Round: 1, Gnomes: [2]GnomeView{{HP: 15, Vulnerable: 2}, {HP: 15}}}
	out := b.Resolve(encode(t, ResolveRequest{State: s, Decks: [2][]int{{1}, {}}, A: []int{1, 0}, B: []int{0, 0, 0}}))
	resp := decode[ResolveResponse](t, out)
	i := slices.IndexFunc(resp.Events, func(e EventView) bool { return e.Kind == "VulnerableMoved" })
	require.GreaterOrEqual(t, i, 0, out)
	assert.Equal(t, 2, resp.Events[i].N)
	assert.Equal(t, [2]int{0, 2}, [2]int{resp.Events[i].After[0].Vulnerable, resp.Events[i].After[1].Vulnerable})
}

func TestResolveNamesTheSelfRiskEvents(t *testing.T) {
	const cards = `{"Cards": [
		{"Name": "Brace", "Cost": 1, "Tier": "Normal", "Block": [["GainBlock", 1]]},
		{"Name": "Sap", "Cost": 1, "Tier": "Normal", "Special": true, "Damage": [["StripBlock", 0], ["GainVulnerable", 1]]}
	], "Clans": {"Delvers": ["Sap"]}, "Rules": {}}`
	b := New()
	require.NotContains(t, b.Load(cards), `"error"`)
	s := StateView{Round: 1, Gnomes: [2]GnomeView{{HP: 15}, {HP: 15}}}
	out := b.Resolve(encode(t, ResolveRequest{State: s, Decks: [2][]int{{1}, {}}, A: []int{1, 0, 0}, B: []int{0, 0, 0}}))
	resp := decode[ResolveResponse](t, out)
	var kinds []string
	for _, e := range resp.Events {
		kinds = append(kinds, e.Kind)
	}
	assert.Contains(t, kinds, "BlockStripped", out)
	assert.Contains(t, kinds, "VulnerableGained", out)
}
