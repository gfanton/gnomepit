package arena

import (
	"math"
	"testing"

	"gno.land/p/gfanton/gnomepit/engine"
	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nt/urequire/v0"
)

// ended is a finished match between a and b with clans ca and cb.
func ended(a, b address, ca, cb int, result, reason string) record {
	return record{phase: phaseEnded, result: result, reason: reason, challenger: a, acceptor: b, clans: [2]int{ca, cb}}
}

// seed gives a a standing at rating with one rated Pickers win, and its ladder key.
func seed(a address, rating int) {
	p := loadPlayer(a)
	p.standing = &standing{rating: rating, wins: 1, lastClan: 1, perClan: []int{1, 0, 0}}
	savePlayer(a, p)
	ladder, _ = ladder.Set(ladderKey(rating, a), nil)
}

// counted is how many rated matches a has finished.
func counted(a address) int {
	st := loadPlayer(a).standing
	if st == nil {
		return 0
	}
	return st.wins + st.losses + st.draws
}

// ladderKeys lists the ladder's keys in order.
func ladderKeys() []string {
	var keys []string
	ladder.TraverseByOffset(0, ladder.Size(), true, true, func(n *avl.Node) bool {
		keys = append(keys, n.Key())
		return false
	})
	return keys
}

func TestExpectedTableMatchesFormula(t *testing.T) {
	for i, e := range expectedTable {
		d := float64(i * 25)
		uassert.Equal(t, int(math.Round(1000/(1+math.Pow(10, d/400)))), e)
	}
}

func TestExpected(t *testing.T) {
	uassert.Equal(t, 500, expected(1000, 1000))
	uassert.Equal(t, 500, expected(1000, 1012), "a gap of 12 rounds to 0")
	uassert.Equal(t, 464, expected(1000, 1013), "a gap of 13 rounds to 25")
	uassert.Equal(t, 360, expected(1000, 1100))
	uassert.Equal(t, 640, expected(1100, 1000))
	uassert.Equal(t, 91, expected(1000, 1500), "the gap is capped at 400")
	uassert.Equal(t, 909, expected(1500, 1000))
}

func TestEloChange(t *testing.T) {
	uassert.Equal(t, 16, eloChange(1000, 1000, 1000, playerK))
	uassert.Equal(t, 0, eloChange(1000, 1000, 500, playerK))
	uassert.Equal(t, 20, eloChange(1000, 1100, 1000, playerK))
	uassert.Equal(t, -12, eloChange(1000, 1100, 0, playerK))
	uassert.Equal(t, 4, eloChange(1000, 1100, 500, playerK))
	uassert.Equal(t, 12, eloChange(1100, 1000, 1000, playerK))
	uassert.Equal(t, -20, eloChange(1100, 1000, 0, playerK))
	uassert.Equal(t, 29, eloChange(1000, 1500, 1000, playerK))
	uassert.Equal(t, 8, eloChange(1000, 1000, 1000, clanK))
}

func TestApplyChangeClamps(t *testing.T) {
	a, b := applyChange(1000, 1000, 16)
	uassert.Equal(t, 1016, a)
	uassert.Equal(t, 984, b)
	a, b = applyChange(5, 5, -16)
	uassert.Equal(t, 0, a, "no rating goes below 0")
	uassert.Equal(t, 21, b)
	a, b = applyChange(65530, 900, 29)
	uassert.Equal(t, maxRating, a, "no rating goes above what the ladder key holds")
	uassert.Equal(t, 871, b)
}

func TestRateFirstMatch(t *testing.T) {
	reset()
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "a", "hp"))

	a := loadPlayer(alice).standing
	urequire.True(t, a != nil)
	uassert.Equal(t, "1016 1-0-0 last 1 per 1 0 0", showStanding(*a))
	uassert.Equal(t, 1, a.mainClan())
	b := loadPlayer(bob).standing
	urequire.True(t, b != nil)
	uassert.Equal(t, "984 0-1-0 last 2 per 0 1 0", showStanding(*b))
	uassert.Equal(t, 2, b.mainClan())

	uassert.Equal(t, 2, ladder.Size())
	uassert.Equal(t, 1, rankOf(1016))
	uassert.Equal(t, 2, rankOf(984))
	c := decodeClans(clanRecords, 3)
	uassert.True(t, c[0] == clanRecord{1008, 1, 0, 0})
	uassert.True(t, c[1] == clanRecord{992, 0, 1, 0})
	uassert.True(t, c[2] == clanRecord{rating: startRating})
}

func TestRateMovesLadderKeys(t *testing.T) {
	reset()
	rules := engine.ProofOfConcept()
	rate(rules, ended(alice, bob, 1, 2, "a", "hp"))
	rate(rules, ended(alice, bob, 1, 2, "a", "hp"))
	a, b := loadPlayer(alice).standing, loadPlayer(bob).standing
	keys := ladderKeys()
	urequire.Equal(t, 2, len(keys))
	uassert.Equal(t, ladderKey(a.rating, alice), keys[0])
	uassert.Equal(t, ladderKey(b.rating, bob), keys[1])
}

func TestRateKeepsMatchesAndLocks(t *testing.T) {
	reset()
	ids := make([]int, 3000)
	for i := range ids {
		ids[i] = i + 1
	}
	locks := []sessionLock{{session: carol, id: 3000, expires: 1_790_000_000}}
	savePlayer(alice, playerRecord{ids: ids, locks: locks})
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "a", "hp"))
	got := loadPlayer(alice)
	uassert.Equal(t, encodePlayer(playerRecord{ids: ids, standing: got.standing, locks: locks}), stringAt(&players, string(alice)))
	uassert.Equal(t, 1016, got.standing.rating)
}

func TestRateDraw(t *testing.T) {
	reset()
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "draw", "hp"))
	uassert.Equal(t, "1000 0-0-1 last 1 per 1 0 0", showStanding(*loadPlayer(alice).standing))
	uassert.Equal(t, "1000 0-0-1 last 2 per 0 1 0", showStanding(*loadPlayer(bob).standing))
}

func TestSelfMatchUnrated(t *testing.T) {
	reset()
	rate(engine.ProofOfConcept(), ended(alice, alice, 1, 2, "a", "hp"))
	uassert.True(t, loadPlayer(alice).standing == nil)
	uassert.Equal(t, 0, ladder.Size())
	uassert.Equal(t, "", clanRecords)
}

func TestForfeitCountsForClans(t *testing.T) {
	reset()
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "b", "forfeit"))
	uassert.Equal(t, 984, loadPlayer(alice).standing.rating)
	uassert.Equal(t, 1016, loadPlayer(bob).standing.rating)
	c := decodeClans(clanRecords, 3)
	uassert.True(t, c[0] == clanRecord{992, 0, 1, 0}, "the clan that ran out of time loses")
	uassert.True(t, c[1] == clanRecord{1008, 1, 0, 0})
}

func TestMirrorSkipsClans(t *testing.T) {
	reset()
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 1, "a", "hp"))
	uassert.Equal(t, 1016, loadPlayer(alice).standing.rating)
	uassert.Equal(t, "", clanRecords)
}

func TestSharedRank(t *testing.T) {
	reset()
	seed(alice, 1016)
	seed(bob, 1016)
	seed(carol, 984)
	uassert.Equal(t, 1, rankOf(1016))
	uassert.Equal(t, 3, rankOf(984))
}

func TestMainClanTie(t *testing.T) {
	uassert.Equal(t, 2, standing{lastClan: 2, perClan: []int{2, 2, 0}}.mainClan())
	uassert.Equal(t, 1, standing{lastClan: 1, perClan: []int{2, 2, 0}}.mainClan())
	uassert.Equal(t, 1, standing{lastClan: 3, perClan: []int{2, 2, 1}}.mainClan(), "a tie the last clan is not in goes to ruleset order")
	uassert.Equal(t, 0, standing{}.mainClan())
}

func TestEndingsRate(cur realm, t *testing.T) {
	// The worked match ends on HP with the challenger's last Reveal.
	reset()
	a1, b1 := "Chalk Dust,Double Tap", "Hammer Blow,Spiked Shield"
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, a1), boxOf("box1"), "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, b1)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, a1, salt1, sealOf(salt2, picks), boxOf("box2"))
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", picks, salt2, sealOf(salt3, picks), boxOf("box3"))
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", picks, salt3, "", "")
	uassert.Equal(t, 1, counted(alice), "a match ended on HP is rated")
	uassert.Equal(t, 1, counted(bob))

	// A knockout ends it with the second Reveal.
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, "Pick,Anvil Stomp")
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, picks, salt1, sealOf(salt2, picks), boxOf("box2"))
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, "Hammer Blow,Cobble Throw")
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", picks, salt2, "", "")
	uassert.Equal(t, "knockout", Match(id).Reason)
	uassert.Equal(t, 1, counted(alice), "a knockout is rated")
	uassert.Equal(t, 1, loadPlayer(bob).standing.wins)

	// A resignation.
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	Resign(cross(cur), id)
	uassert.Equal(t, 1, loadPlayer(alice).standing.wins, "a resignation is rated")
	uassert.Equal(t, 1, loadPlayer(bob).standing.losses)

	// A forfeit claimed by a third wallet.
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	testing.SkipHeights(day + 1)
	testing.SetRealm(testing.NewUserRealm(carol))
	ClaimForfeit(cross(cur), id)
	uassert.Equal(t, 1, loadPlayer(alice).standing.losses, "a forfeit is rated")
	uassert.Equal(t, 1, loadPlayer(bob).standing.wins)
	uassert.True(t, loadPlayer(carol).standing == nil)

	// A match the challenger accepted themselves.
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	Resign(cross(cur), id)
	uassert.True(t, loadPlayer(alice).standing == nil, "a self-match is never rated")

	// A withdrawn challenge, then an expired one.
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	Resign(cross(cur), id)
	id = Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), boxOf("box1"), "")
	testing.SkipHeights(7*day + 1)
	Resign(cross(cur), id)
	uassert.True(t, loadPlayer(alice).standing == nil, "a challenge nobody accepted is never rated")
	uassert.Equal(t, 0, ladder.Size())
}
