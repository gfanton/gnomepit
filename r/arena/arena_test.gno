package arena

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nt/urequire/v0"
)

var (
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
	carol = testutils.TestAddress("carol")
)

const (
	saltA = "0101010101010101010101010101010101010101010101010101010101010101"
	saltB = "0202020202020202020202020202020202020202020202020202020202020202"
)

// reset empties the realm's state between tests; t.Run shares package globals.
func reset() {
	matches = avl.Tree{}
	byPlayer = avl.Tree{}
	lastID = 0
}

func sealOf(salt, text string) string {
	b, err := hex.DecodeString(salt)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(append(b, text...))
	return hex.EncodeToString(sum[:])
}

func TestChallengeOpensAMatch(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, "deck"), sealOf(saltB, "plan"), "box", "")
	uassert.Equal(t, "1", id)

	list := Open(0, 50)
	urequire.Equal(t, 1, len(list))
	c := list[0]
	uassert.Equal(t, "1", c.ID)
	uassert.Equal(t, alice.String(), c.Challenger)
	uassert.Equal(t, "Pickers", c.Clan)
	uassert.Equal(t, "", c.Opponent)
	uassert.Equal(t, c.Posted+604800, c.Expires)
}

func TestChallengeNamesAnOpponent(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	Challenge(cross(cur), "Ironhide", sealOf(saltA, "deck"), sealOf(saltB, "plan"), "box", bob)
	uassert.Equal(t, bob.String(), Open(0, 50)[0].Opponent)
}

func TestChallengeRejects(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	seal := sealOf(saltA, "deck")
	cases := []struct {
		name, clan, deckSeal, planSeal, box string
		opponent                            address
		want                                string
	}{
		{"unknown clan", "Elves", seal, seal, "box", "", "unknown clan"},
		{"short seal", "Pickers", seal[1:], seal, "box", "", "invalid seal"},
		{"uppercase seal", "Pickers", strings.ToUpper(seal), seal, "box", "", "invalid seal"},
		{"non-hex seal", "Pickers", seal, "z" + seal[1:], "box", "", "invalid seal"},
		{"empty box", "Pickers", seal, seal, "", "", "invalid box"},
		{"long box", "Pickers", seal, seal, strings.Repeat("x", 1025), "", "invalid box"},
		{"bad opponent", "Pickers", seal, seal, "box", address("g1nope"), "invalid opponent"},
		{"uppercase opponent", "Pickers", seal, seal, "box", address(strings.ToUpper(bob.String())), "invalid opponent"},
	}
	for _, c := range cases {
		uassert.AbortsWithMessage(t, cur, c.want, func() {
			Challenge(cross(cur), c.clan, c.deckSeal, c.planSeal, c.box, c.opponent)
		}, c.name)
	}
	uassert.Equal(t, 0, len(Open(0, 50)))
}

func TestOpenNewestFirstAndUnexpired(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	seal := sealOf(saltA, "deck")
	Challenge(cross(cur), "Pickers", seal, seal, "box", "")
	Challenge(cross(cur), "Pickers", seal, seal, "box", "")
	testing.SkipHeights(120000) // 600,000 s
	Challenge(cross(cur), "Ironhide", seal, seal, "box", "")

	ids := func(list []OpenChallenge) string {
		var out []string
		for _, c := range list {
			out = append(out, c.ID)
		}
		return strings.Join(out, ",")
	}
	uassert.Equal(t, "3,2,1", ids(Open(0, 50)))
	uassert.Equal(t, "2", ids(Open(1, 1)))

	testing.SkipHeights(1000) // the first two are now 605,000 s old
	uassert.Equal(t, "3", ids(Open(0, 50)))
}

func TestOpenLimit(t *testing.T) {
	uassert.PanicsWithMessage(t, nil, "limit must be 1 to 50", func() { Open(0, 0) })
	uassert.PanicsWithMessage(t, nil, "limit must be 1 to 50", func() { Open(0, 51) })
	uassert.PanicsWithMessage(t, nil, "offset must not be negative", func() { Open(-1, 10) })
}
