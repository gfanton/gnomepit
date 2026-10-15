package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// withCards is the proof of concept with test cards after its own.
func withCards(cards ...Card) *Ruleset {
	rs := ProofOfConcept()
	rs.Cards = append(rs.Cards, cards...)
	return rs
}

var effectCards = []Card{
	{Name: "Overdig", Cost: 1, Tier: Normal, Special: true, Damage: []Effect{{Hit, 3}, {GainVulnerable, 1}}},
	{Name: "Open Up", Cost: 1, Tier: Normal, Special: true, Damage: []Effect{{GainVulnerable, 1}}},
	{Name: "Deep Swing", Cost: 2, Tier: Slow, Special: true, Damage: []Effect{{HitPerVulnerable, 3}}},
	{Name: "Brace Up", Cost: 1, Tier: Normal, Special: true, Block: []Effect{{BlockPerVulnerable, 2}}},
	{Name: "Sap", Cost: 2, Tier: Normal, Special: true, Damage: []Effect{{StripBlock, 0}, {Hit, 2}}},
	{Name: "Kickback", Cost: 1, Tier: Slow, Special: true, Damage: []Effect{{HitHardest, 5}}},
	{Name: "Sneak", Cost: 1, Tier: Normal, Special: true, Damage: []Effect{{GainVulnerable, 1}, {HitIfNotAttacked, 5}}},
}

func TestSelfRiskEffects(t *testing.T) {
	fresh := [2][3]int{{15, 0, 0}, {15, 0, 0}}
	cases := map[string]struct {
		a, b       []string
		start, end [2][3]int
	}{
		"a token gained after the hit doubles the next one": {
			[]string{"Overdig", "Brace", "Brace"}, []string{"Pick", "Pick", "Pick"},
			fresh, [2][3]int{{13, 0, 0}, {12, 0, 0}}},
		"a token gained in a step does not double that step's hit": {
			[]string{"Open Up", "Brace", "Brace"}, []string{"Pick", "Brace", "Brace"},
			fresh, [2][3]int{{14, 1, 0}, {15, 0, 0}}},
		"the hit grows with each token on its owner": {
			[]string{"Deep Swing", "Brace"}, []string{"Brace", "Brace", "Brace"},
			[2][3]int{{15, 2, 0}, {15, 0, 0}}, [2][3]int{{15, 2, 0}, {8, 0, 0}}},
		"with no token the hit is its base": {
			[]string{"Deep Swing", "Brace"}, []string{"Brace", "Brace", "Brace"},
			fresh, [2][3]int{{15, 0, 0}, {14, 0, 0}}},
		"Block grows with each token on its owner": {
			[]string{"Brace Up", "Brace", "Brace"}, []string{"Hammer Blow", "Pick"},
			[2][3]int{{15, 1, 0}, {15, 0, 0}}, [2][3]int{{10, 0, 0}, {15, 0, 0}}},
		"stripped Block stops nothing": {
			[]string{"Sap", "Pick"}, []string{"Bulwark", "Pick"},
			fresh, [2][3]int{{14, 0, 0}, {12, 0, 0}}},
		"stripped Block leaves Avalanche nothing to throw": {
			[]string{"Sap", "Pick"}, []string{"Bulwark", "Avalanche"},
			fresh, [2][3]int{{15, 0, 0}, {12, 0, 0}}},
		"Kickback returns the hardest hit": {
			[]string{"Pick", "Pick", "Kickback"}, []string{"Hammer Blow", "Pick"},
			fresh, [2][3]int{{9, 0, 0}, {8, 0, 0}}},
		"Kickback returns up to its cap": {
			[]string{"Pick", "Pick", "Kickback"}, []string{"Hammer Blow", "Pick"},
			[2][3]int{{15, 1, 0}, {15, 0, 0}}, [2][3]int{{4, 0, 0}, {8, 0, 0}}},
		"Kickback counts what got through Block": {
			[]string{"Brace", "Brace", "Kickback"}, []string{"Sling Stone", "Cobble Throw", "Pick"},
			fresh, [2][3]int{{12, 0, 0}, {14, 0, 0}}},
		"the bet pays when no attack lands": {
			[]string{"Sneak", "Brace", "Brace"}, []string{"Brace", "Pick", "Pick"},
			fresh, [2][3]int{{14, 0, 0}, {11, 0, 0}}},
		"the bet loses when an attack lands": {
			[]string{"Sneak", "Brace", "Brace"}, []string{"Pick", "Pick", "Pick"},
			fresh, [2][3]int{{13, 0, 0}, {15, 0, 0}}},
		"a Parry cancels the bet before it costs anything": {
			[]string{"Sneak", "Pick", "Pick"}, []string{"Stone Guard"},
			fresh, [2][3]int{{15, 0, 0}, {14, 0, 0}}},
		"Kickback does not see a hit in its own step": {
			[]string{"Kickback", "Pick", "Pick"}, []string{"Cobble Throw", "Brace", "Brace"},
			fresh, [2][3]int{{13, 0, 0}, {15, 0, 0}}},
	}
	rs := withCards(effectCards...)
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			o := rs.Resolve(stateOf(1, tc.start), mustPlan(t, rs, tc.a...), mustPlan(t, rs, tc.b...))
			require.Equal(t, Ongoing, o.Result)
			for side := range o.State.Gnomes {
				g := o.State.Gnomes[side]
				assert.Equal(t, tc.end[side], [3]int{g.HP, g.Vulnerable, g.Strength}, "side %d", side)
			}
		})
	}
}

func TestScaledAndReturnedHitsAreAttacks(t *testing.T) {
	rs := withCards(effectCards...)
	for _, name := range []string{"Deep Swing", "Kickback", "Sneak"} {
		id, ok := rs.CardByName(name)
		require.True(t, ok)
		assert.True(t, rs.Cards[id].Attack(), name)
	}
	id, _ := rs.CardByName("Open Up")
	assert.False(t, rs.Cards[id].Attack())
}

func TestTraceSelfRiskEvents(t *testing.T) {
	rs := withCards(effectCards...)
	_, events := rs.Trace(rs.Start(), mustPlan(t, rs, "Sap", "Open Up"), mustPlan(t, rs, "Bulwark", "Pick"))
	sap, _ := rs.CardByName("Sap")
	open, _ := rs.CardByName("Open Up")
	var stripped, gained []Event
	for _, e := range events {
		switch e.Kind {
		case BlockStripped:
			stripped = append(stripped, e)
		case VulnerableGained:
			gained = append(gained, e)
		}
	}
	require.Len(t, stripped, 1)
	assert.Equal(t, Event{Beat: 2, Phase: DamagePhase, Tier: Normal, Step: 1, Kind: BlockStripped, Side: SideA,
		Card: sap, N: 5, After: [2]Vitals{{HP: 15}, {HP: 15}}}, stripped[0])
	require.Len(t, gained, 1)
	assert.Equal(t, SideA, gained[0].Side)
	assert.Equal(t, open, gained[0].Card)
	assert.Equal(t, 1, gained[0].N)
	assert.Equal(t, 1, gained[0].After[SideA].Vulnerable)
}
