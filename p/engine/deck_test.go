package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func clanOf(t *testing.T, rs *Ruleset, name string) Clan {
	t.Helper()
	c, ok := rs.ClanByName(name)
	require.True(t, ok, "clan %q", name)
	return c
}

func TestRares(t *testing.T) {
	rs := ProofOfConcept()
	var rares []string
	for _, c := range rs.Cards {
		if c.Rare {
			rares = append(rares, c.Name)
		}
	}
	assert.ElementsMatch(t, []string{"Undermine", "Avalanche"}, rares)
}

func TestLegalDeck(t *testing.T) {
	rs := ProofOfConcept()
	pickers := clanOf(t, rs, "Pickers")
	starter := pickers.Pool &^ cardBits(t, rs, "Hunker Down", "Boot and Heel")
	cases := map[string]struct {
		deck uint64
		want bool
	}{
		"starter deck":          {starter, true},
		"seven cards":           {starter &^ cardBits(t, rs, "Sling Stone"), false},
		"nine cards":            {pickers.Pool &^ cardBits(t, rs, "Hunker Down"), false},
		"no Rare":               {pickers.Pool &^ cardBits(t, rs, "Undermine", "Hunker Down"), false},
		"card outside the pool": {starter&^cardBits(t, rs, "Sling Stone") | cardBits(t, rs, "Bulwark"), false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, rs.LegalDeck(pickers, tc.deck))
		})
	}
}

// A pool holding two Rares still allows only one of them in a deck.
func TestLegalDeckRefusesTwoRares(t *testing.T) {
	rs := ProofOfConcept()
	pickers := clanOf(t, rs, "Pickers")
	pickers.Pool |= cardBits(t, rs, "Avalanche")
	starter := pickers.Pool &^ cardBits(t, rs, "Hunker Down", "Boot and Heel", "Avalanche")
	deck := starter&^cardBits(t, rs, "Sling Stone") | cardBits(t, rs, "Avalanche")
	assert.False(t, rs.LegalDeck(pickers, deck))
}
