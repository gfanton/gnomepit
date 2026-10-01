package cardtext

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"gnomehall/p/engine"
)

func TestText(t *testing.T) {
	rs := engine.ProofOfConcept()
	cases := map[string]string{
		"Pick":           "Deal 1 damage.",
		"Brace":          "Gain 1 Block.",
		"Pickaxe Flurry": "Deal 1 damage twice.",
		"Kneecap":        "Interrupt. Deal 1 damage.",
		"Dodge Roll":     "Parry 1.",
		"Chalk Dust":     "Apply 1 Vulnerable.",
		"Double Tap":     "Deal 1 damage 3 times.",
		"Momentum":       "Gain 1 Strength.",
		"Undermine":      "Interrupt. If this cancels a card, apply 2 Vulnerable.",
		"Hunker Down":    "Parry 2.",
		"Boot and Heel":  "Deal 2 damage twice.",
		"Spiked Shield":  "Gain 1 Block. Counter 1.",
		"Anvil Stomp":    "Deal 2 damage. Apply 1 Vulnerable.",
		"Feint":          "If this card is cancelled, gain 4 Block. Otherwise, deal 4 damage.",
		"Avalanche":      "Deal damage equal to your Block.",
		"Loose Timbers":  "If this card is cancelled, deal 4 damage. Otherwise, gain 3 Block.",
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			id, ok := rs.CardByName(name)
			require.True(t, ok, "card %q", name)
			assert.Equal(t, want, Text(rs.Cards[id]))
		})
	}
}

func TestTextParryWithDamage(t *testing.T) {
	c := engine.Card{Parry: 1, Damage: []engine.Effect{{Kind: engine.Hit, N: 2}}}
	assert.Equal(t, "Parry 1. Deal 2 damage.", Text(c))
}
