package arena

import (
	"strings"
	"testing"

	"gno.land/p/gfanton/gnomehall/engine"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nt/urequire/v0"
)

const (
	deckA = "Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine"
	deckB = "Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche"

	salt1 = "1111111111111111111111111111111111111111111111111111111111111111"
	salt2 = "2222222222222222222222222222222222222222222222222222222222222222"
	salt3 = "3333333333333333333333333333333333333333333333333333333333333333"

	picks  = "Pick,Pick,Pick"
	braces = "Brace,Brace,Brace"

	day = 86400 / 5 // block heights in 24 hours at the test chain's 5 s per block
)

func stored(id string) *match {
	return matches.Get(key(id)).(*match)
}

// resolveAll plays rounds of [A plan, B plan] with the engine directly.
func resolveAll(rounds ...[2]string) engine.Outcome {
	s := rules.Start()
	var o engine.Outcome
	for _, r := range rounds {
		a, _ := rules.PlanOf(strings.Split(r[0], ",")...)
		b, _ := rules.PlanOf(strings.Split(r[1], ",")...)
		o = rules.Resolve(s, a, b)
		s = o.State
	}
	return o
}

func TestWorkedExample(cur realm, t *testing.T) {
	reset()
	a1, b1 := "Chalk Dust,Double Tap", "Hammer Blow,Spiked Shield"

	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, a1), "box1", "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, b1)
	uassert.Equal(t, phaseReveal, stored(id).phase)
	uassert.Equal(t, 0, len(Open(0, 50)))

	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, a1, salt1, sealOf(salt2, picks), "box2")
	uassert.Equal(t, phasePlay, stored(id).phase)
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", picks, salt2, sealOf(salt3, picks), "box3")
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", picks, salt3, "", "")

	want := resolveAll([2]string{a1, b1}, [2]string{picks, braces}, [2]string{picks, braces})
	m := stored(id)
	uassert.Equal(t, phaseEnded, m.phase)
	uassert.Equal(t, resultName(want.Result), m.result)
	uassert.Equal(t, "hp", m.reason)
	urequire.Equal(t, 3, len(m.hp))
	uassert.Equal(t, want.State.Gnomes[0].HP, m.hp[2][0])
	uassert.Equal(t, want.State.Gnomes[1].HP, m.hp[2][1])
	uassert.Equal(t, deckA, m.decks[0])
	uassert.Equal(t, a1, m.plans[0][0])
	uassert.Equal(t, b1, m.plans[0][1])
}

func TestKnockoutEndsTheMatchEarly(cur realm, t *testing.T) {
	reset()
	b1, b2 := "Pick,Anvil Stomp", "Hammer Blow,Cobble Throw"

	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, b1)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, picks, salt1, sealOf(salt2, picks), "box2")
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, b2)

	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "unexpected next seal", func() {
		Reveal(cross(cur), id, "", "", picks, salt2, sealOf(salt3, picks), "box3")
	})
	Reveal(cross(cur), id, "", "", picks, salt2, "", "")

	m := stored(id)
	uassert.Equal(t, phaseEnded, m.phase)
	uassert.Equal(t, "b", m.result)
	uassert.Equal(t, "knockout", m.reason)
	uassert.Equal(t, 2, len(m.hp))
}

func TestDrawOnHP(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, braces), "box1", "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, braces, salt1, sealOf(salt2, braces), "box2")
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", braces, salt2, sealOf(salt3, braces), "box3")
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, "", "", braces, salt3, "", "")

	m := stored(id)
	uassert.Equal(t, "draw", m.result)
	uassert.Equal(t, "hp", m.reason)
}

func TestSelfPlay(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", "")
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	Reveal(cross(cur), id, deckA, saltA, picks, salt1, sealOf(salt2, picks), "box2")
	Play(cross(cur), id, braces)
	Reveal(cross(cur), id, "", "", picks, salt2, sealOf(salt3, picks), "box3")
	Play(cross(cur), id, braces)
	Reveal(cross(cur), id, "", "", picks, salt3, "", "")
	uassert.Equal(t, phaseEnded, stored(id).phase)
}

func TestAcceptRejects(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	openID := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", "")
	namedID := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", bob)

	testing.SetRealm(testing.NewUserRealm(carol))
	cases := []struct {
		name, id, clan, deck, plan, want string
	}{
		{"unknown match", "99", "Ironhide", deckB, braces, "unknown match"},
		{"not the named opponent", namedID, "Ironhide", deckB, braces, "not the named opponent"},
		{"unknown clan", openID, "Elves", deckB, braces, "unknown clan"},
		{"a card twice", openID, "Ironhide", strings.Replace(deckB, "Bulwark", "Stone Guard", 1), braces, "illegal deck"},
		{"a ninth name repeating a card", openID, "Ironhide", deckB + ",Stone Guard", braces, "illegal deck"},
		{"another clan's card", openID, "Ironhide", strings.Replace(deckB, "Bulwark", "Kneecap", 1), braces, "illegal deck"},
		{"unknown card", openID, "Ironhide", strings.Replace(deckB, "Bulwark", "Bulwerk", 1), braces, "unknown card"},
		{"two beats", openID, "Ironhide", deckB, "Pick,Pick", "illegal plan"},
		{"a card outside the deck", openID, "Ironhide", deckB, "Shield Catch,Pick", "illegal plan"},
	}
	for _, c := range cases {
		uassert.AbortsWithMessage(t, cur, c.want, func() {
			Accept(cross(cur), c.id, c.clan, c.deck, c.plan)
		}, c.name)
	}

	Accept(cross(cur), openID, "Ironhide", deckB, braces)
	uassert.AbortsWithMessage(t, cur, "wrong phase", func() {
		Accept(cross(cur), openID, "Ironhide", deckB, braces)
	})

	testing.SkipHeights(7*day + 1)
	testing.SetRealm(testing.NewUserRealm(bob))
	uassert.AbortsWithMessage(t, cur, "challenge expired", func() {
		Accept(cross(cur), namedID, "Ironhide", deckB, braces)
	})
}

func TestRevealRejects(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", "")
	badPlan := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, "Pick,Pick"), "box1", "")
	badDeck := Challenge(cross(cur), "Pickers", sealOf(saltA, "Pick"), sealOf(salt1, picks), "box1", "")
	longDeck := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA+",Kneecap"), sealOf(salt1, picks), "box1", "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	Accept(cross(cur), badPlan, "Ironhide", deckB, braces)
	Accept(cross(cur), badDeck, "Ironhide", deckB, braces)
	Accept(cross(cur), longDeck, "Ironhide", deckB, braces)
	next := sealOf(salt2, picks)

	uassert.AbortsWithMessage(t, cur, "not your move", func() {
		Reveal(cross(cur), id, deckA, saltA, picks, salt1, next, "box2")
	})

	testing.SetRealm(testing.NewUserRealm(alice))
	cases := []struct {
		name, id, deck, deckSalt, plan, planSalt, nextSeal, nextBox, want string
	}{
		{"no deck", id, "", "", picks, salt1, next, "box2", "deck required"},
		{"wrong deck salt", id, deckA, saltB, picks, salt1, next, "box2", "seal mismatch"},
		{"wrong plan salt", id, deckA, saltA, picks, salt2, next, "box2", "seal mismatch"},
		{"short salt", id, deckA, saltA[2:], picks, salt1, next, "box2", "invalid salt"},
		{"illegal plan", badPlan, deckA, saltA, "Pick,Pick", salt1, next, "box2", "illegal plan"},
		{"illegal deck", badDeck, "Pick", saltA, picks, salt1, next, "box2", "illegal deck"},
		{"a ninth name repeating a card", longDeck, deckA + ",Kneecap", saltA, picks, salt1, next, "box2", "illegal deck"},
		{"no next seal", id, deckA, saltA, picks, salt1, "", "", "next seal required"},
		{"bad next seal", id, deckA, saltA, picks, salt1, "abc", "box2", "invalid seal"},
		{"no next box", id, deckA, saltA, picks, salt1, next, "", "invalid box"},
	}
	for _, c := range cases {
		uassert.AbortsWithMessage(t, cur, c.want, func() {
			Reveal(cross(cur), c.id, c.deck, c.deckSalt, c.plan, c.planSalt, c.nextSeal, c.nextBox)
		}, c.name)
	}

	Reveal(cross(cur), id, deckA, saltA, picks, salt1, next, "box2")
	testing.SetRealm(testing.NewUserRealm(bob))
	Play(cross(cur), id, braces)
	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "deck already revealed", func() {
		Reveal(cross(cur), id, deckA, saltA, picks, salt2, sealOf(salt3, picks), "box3")
	})

	testing.SkipHeights(day + 1)
	uassert.AbortsWithMessage(t, cur, "deadline passed", func() {
		Reveal(cross(cur), id, "", "", picks, salt2, sealOf(salt3, picks), "box3")
	})
}

func TestPlayRejects(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Challenge(cross(cur), "Pickers", sealOf(saltA, deckA), sealOf(salt1, picks), "box1", "")
	testing.SetRealm(testing.NewUserRealm(bob))
	Accept(cross(cur), id, "Ironhide", deckB, braces)
	uassert.AbortsWithMessage(t, cur, "wrong phase", func() { Play(cross(cur), id, braces) })

	testing.SetRealm(testing.NewUserRealm(alice))
	Reveal(cross(cur), id, deckA, saltA, picks, salt1, sealOf(salt2, picks), "box2")
	uassert.AbortsWithMessage(t, cur, "not your move", func() { Play(cross(cur), id, braces) })

	testing.SetRealm(testing.NewUserRealm(bob))
	uassert.AbortsWithMessage(t, cur, "illegal plan", func() { Play(cross(cur), id, "Kneecap,Pick,Pick") })
	testing.SkipHeights(day + 1)
	uassert.AbortsWithMessage(t, cur, "deadline passed", func() { Play(cross(cur), id, braces) })
}
