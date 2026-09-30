package cardfile

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"gnomehall/engine"
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

func TestLoadErrors(t *testing.T) {
	cases := map[string]struct {
		data []byte
		want string
	}{
		"bad tier":   {fixture(t, "bad-tier.cards.json"), `card Jab: tier "Fast"`},
		"bad effect": {fixture(t, "bad-effect.cards.json"), "card Jab: effect"},
		"bad clan":   {fixture(t, "bad-clan.cards.json"), `clan Alpha: no card "Nobody"`},
		"not JSON":   {[]byte("{"), "parse card file"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(tc.data)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}
