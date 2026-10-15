package cardfile

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"gnomehall/p/engine"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	require.NoError(t, err)
	return data
}

func TestLoadSmallFile(t *testing.T) {
	rs, err := Load(fixture(t, "small.cards.json"))
	require.NoError(t, err)

	want := engine.ProofOfConcept()
	want.Cards = []engine.Card{
		{Name: "Jab", Cost: 1, Tier: engine.Normal, Damage: []engine.Effect{{Kind: engine.Hit, N: 1}}},
		{Name: "Riposte", Cost: 2, Tier: engine.Quick, Special: true, Interrupt: true, Parry: 1,
			Damage:   []engine.Effect{{Kind: engine.Hit, N: 2}, {Kind: engine.Hit, N: 2}},
			OnCancel: []engine.Effect{{Kind: engine.GainBlock, N: 3}}},
		{Name: "Wall", Cost: 2, Tier: engine.Slow, Special: true,
			Block:        []engine.Effect{{Kind: engine.GainBlock, N: 5}, {Kind: engine.GainCounter, N: 1}},
			CancelDamage: []engine.Effect{{Kind: engine.Hit, N: 4}}},
		{Name: "Crest", Cost: 1, Tier: engine.Normal, Special: true, Rare: true,
			Block:  []engine.Effect{{Kind: engine.MoveVulnerable}},
			Damage: []engine.Effect{{Kind: engine.HitBlock}, {Kind: engine.ApplyVulnerable, N: 1}, {Kind: engine.GainStrength, N: 1}, {Kind: engine.VulnerableIfCancelled, N: 2}}},
	}
	want.Clans = []engine.Clan{{Name: "Alpha", Pool: 1<<1 | 1<<3}, {Name: "Zeta", Pool: 1 << 2}}
	want.HP = 12
	want.VulnerableDoublesOneHit = true
	want.StrengthLastsTheRound = true
	want.VulnerableLastsTheRound = false
	require.Equal(t, want, rs)
}

func TestLoadDefaultsHP(t *testing.T) {
	data := bytes.Replace(fixture(t, "small.cards.json"), []byte(`"HP": 12, `), nil, 1)
	rs, err := Load(data)
	require.NoError(t, err)
	assert.Equal(t, 15, rs.HP)
}

// oneCard is a card file holding one basic card of the given cost.
func oneCard(cost int) []byte {
	return []byte(fmt.Sprintf(`{"Cards": [{"Name": "Jab", "Cost": %d, "Tier": "Normal", "Damage": [["Hit", 1]]}], "Clans": {}, "Rules": {}}`, cost))
}

// manyCards is a card file holding n distinct basic cards.
func manyCards(n int) []byte {
	cards := make([]string, 0, n)
	for i := range n {
		cards = append(cards, fmt.Sprintf(`{"Name": "Jab %d", "Cost": 1, "Tier": "Normal", "Damage": [["Hit", 1]]}`, i))
	}
	return []byte(`{"Cards": [` + strings.Join(cards, ",") + `], "Clans": {}, "Rules": {}}`)
}

func TestLoadAcceptsSixtyFourCards(t *testing.T) {
	rs, err := Load(manyCards(64))
	require.NoError(t, err)
	assert.Len(t, rs.Cards, 64)
}

func TestLoadErrors(t *testing.T) {
	cases := map[string]struct {
		data []byte
		want string
	}{
		"bad tier":       {fixture(t, "bad-tier.cards.json"), `card Jab: tier "Fast"`},
		"bad effect":     {fixture(t, "bad-effect.cards.json"), "card Jab: effect"},
		"bad clan":       {fixture(t, "bad-clan.cards.json"), `clan Alpha: no card "Nobody"`},
		"not JSON":       {[]byte("{"), "parse card file"},
		"cost zero":      {oneCard(0), "card Jab: cost 0, want 1 to 3"},
		"cost negative":  {oneCard(-1), "card Jab: cost -1, want 1 to 3"},
		"cost four":      {oneCard(4), "card Jab: cost 4, want 1 to 3"},
		"too many cards": {manyCards(65), "65 cards, at most 64"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(tc.data)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestLoadSelfRiskEffects(t *testing.T) {
	rs, err := Load([]byte(`{"Cards": [
		{"Name": "Rockfall", "Cost": 2, "Tier": "Slow", "Special": true,
		 "Block": [["BlockPerVulnerable", 2]],
		 "Damage": [["StripBlock", 0], ["HitPerVulnerable", 3], ["GainVulnerable", 1], ["HitHardest", 5],
		            ["HitIfNotAttacked", 4]]}
	], "Clans": {"Delvers": ["Rockfall"]}, "Rules": {}}`))
	require.NoError(t, err)
	c := rs.Cards[0]
	assert.Equal(t, []engine.Effect{{Kind: engine.BlockPerVulnerable, N: 2}}, c.Block)
	assert.Equal(t, []engine.Effect{{Kind: engine.StripBlock}, {Kind: engine.HitPerVulnerable, N: 3},
		{Kind: engine.GainVulnerable, N: 1}, {Kind: engine.HitHardest, N: 5}, {Kind: engine.HitIfNotAttacked, N: 4}}, c.Damage)
}
