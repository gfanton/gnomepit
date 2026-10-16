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
		"Kneecap":        "Interrupt (cancels a card winding up). Deal 1 damage.",
		"Dodge Roll":     "Parry 1.",
		"Chalk Dust":     "Apply 1 Vulnerable.",
		"Double Tap":     "Deal 1 damage 3 times.",
		"Momentum":       "Gain 1 Strength.",
		"Undermine":      "Interrupt (cancels a card winding up). If this cancels a card, apply 2 Vulnerable.",
		"Hunker Down":    "Parry 2.",
		"Boot and Heel":  "Deal 2 damage twice.",
		"Spiked Shield":  "Gain 1 Block. Counter 1.",
		"Anvil Stomp":    "Deal 2 damage. Apply 1 Vulnerable.",
		"Feint":          "If this card is cancelled, gain 4 Block. Otherwise, deal 4 damage.",
		"Avalanche":      "Deal damage equal to your Block.",
		"Loose Timbers":  "If this card is cancelled, deal 4 damage. Otherwise, gain 3 Block.",
		"Kickback":       "Deal damage equal to the hardest hit you took this round, up to 5.",
		"Overdig":        "Deal 6 damage. Gain 1 Vulnerable.",
		"Ambush":         "Gain 1 Vulnerable. If no opponent attack lands this beat, deal 6 damage.",
		"Open Guard":     "Gain 4 Block. Gain 1 Vulnerable.",
		"Chisel Jab":     "Deal 2 damage.",
		"Rockfall":       "Deal 5 damage.",
		"Cribbing":       "Gain 1 Block, and 1 more for each Vulnerable on you.",
		"Deadfall":       "Parry 1. If it cancels on its last beat, apply 1 Vulnerable.",
		"Blowback":       "Move your Vulnerable to the opponent.",
		"Cave-In":        "The opponent loses all Block. Deal 5 damage.",
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

func TestTextSelfRiskEffects(t *testing.T) {
	cases := map[string]engine.Card{
		"Deal 3 damage. Gain 1 Vulnerable.":                                        {Damage: []engine.Effect{{Kind: engine.Hit, N: 3}, {Kind: engine.GainVulnerable, N: 1}}},
		"Deal 3 damage, and 3 more for each Vulnerable on you.":                    {Damage: []engine.Effect{{Kind: engine.HitPerVulnerable, N: 3}}},
		"Gain 2 Block, and 2 more for each Vulnerable on you.":                     {Block: []engine.Effect{{Kind: engine.BlockPerVulnerable, N: 2}}},
		"The opponent loses all Block. Deal 3 damage.":                             {Damage: []engine.Effect{{Kind: engine.StripBlock}, {Kind: engine.Hit, N: 3}}},
		"Deal damage equal to the hardest hit you took this round, up to 5.":       {Damage: []engine.Effect{{Kind: engine.HitHardest, N: 5}}},
		"Gain 1 Vulnerable. If no opponent attack lands this beat, deal 5 damage.": {Damage: []engine.Effect{{Kind: engine.GainVulnerable, N: 1}, {Kind: engine.HitIfNotAttacked, N: 5}}},
	}
	for want, c := range cases {
		assert.Equal(t, want, Text(c))
	}
}
