package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func clanPool(t *testing.T, rs *Ruleset, name string) uint64 {
	t.Helper()
	c, ok := rs.ClanByName(name)
	require.True(t, ok, "clan %q", name)
	return c.Pool
}

func cardBits(t *testing.T, rs *Ruleset, names ...string) uint64 {
	t.Helper()
	var bits uint64
	for _, n := range names {
		id, ok := rs.CardByName(n)
		require.True(t, ok, "card %q", n)
		bits |= 1 << uint(id)
	}
	return bits
}

func TestLegalPlanCounts(t *testing.T) {
	rs := ProofOfConcept()
	pickers, ironhide := clanPool(t, rs, "Pickers"), clanPool(t, rs, "Ironhide")
	cases := map[string]struct {
		deck uint64
		want int
	}{
		"Pickers pool":          {pickers, 429},
		"Ironhide pool":         {ironhide, 147},
		"Pickers starter deck":  {pickers &^ cardBits(t, rs, "Hunker Down", "Boot and Heel"), 412},
		"Ironhide starter deck": {ironhide &^ cardBits(t, rs, "Shield Catch", "Loose Timbers"), 127},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Len(t, rs.LegalPlans(rs.Start(), SideA, tc.deck), tc.want)
		})
	}
}

func TestLegalPlansAreLegal(t *testing.T) {
	rs := ProofOfConcept()
	for _, clan := range []string{"Pickers", "Ironhide"} {
		deck := clanPool(t, rs, clan)
		for _, p := range rs.LegalPlans(rs.Start(), SideA, deck) {
			beats := 0
			var specials uint64
			for _, id := range p {
				c := rs.Cards[id]
				beats += c.Cost
				if !c.Special {
					continue
				}
				bit := uint64(1) << uint(id)
				require.Zero(t, specials&bit, "%s: %v plays %s twice", clan, p, c.Name)
				require.NotZero(t, deck&bit, "%s: %v plays %s from outside the deck", clan, p, c.Name)
				specials |= bit
			}
			require.Equal(t, 3, beats, "%s: %v", clan, p)
		}
	}
}

func TestLegalPlansSkipSpent(t *testing.T) {
	rs := ProofOfConcept()
	pickers := clanPool(t, rs, "Pickers")
	spent := cardBits(t, rs, "Dodge Roll", "Kneecap")
	s := rs.Start()
	s.Gnomes[SideA].Spent = spent

	plansA := rs.LegalPlans(s, SideA, pickers)
	assert.Len(t, plansA, 277)
	for _, p := range plansA {
		for _, id := range p {
			assert.Zero(t, spent&(1<<uint(id)), "side A plan %v holds a spent card", p)
		}
	}
	assert.Len(t, rs.LegalPlans(s, SideB, pickers), 429)
}
