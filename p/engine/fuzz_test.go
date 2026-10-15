package engine

import (
	"slices"
	"testing"

	"github.com/stretchr/testify/require"
)

func mirrored(r Result) Result {
	switch r {
	case AWins:
		return BWins
	case BWins:
		return AWins
	}
	return r
}

func swapped(s State) State {
	s.Gnomes[SideA], s.Gnomes[SideB] = s.Gnomes[SideB], s.Gnomes[SideA]
	return s
}

// fuzzInput is one fuzz case before decoding: a matchup, a round, both start gnomes
// and one plan index per side.
type fuzzInput struct {
	matchup, round                     uint8
	hpA, vulnA, strA, hpB, vulnB, strB uint8
	pickA, pickB                       uint16
}

type fuzzDecoder struct {
	rs       *Ruleset
	matchups [6][2]uint64
}

func (d fuzzDecoder) state(in fuzzInput) (State, [2]uint64) {
	s := State{Round: 1 + int(in.round)%3}
	s.Gnomes[SideA] = Gnome{HP: 1 + int(in.hpA)%20, Vulnerable: int(in.vulnA) % 4, Strength: int(in.strA) % 9}
	s.Gnomes[SideB] = Gnome{HP: 1 + int(in.hpB)%20, Vulnerable: int(in.vulnB) % 4, Strength: int(in.strB) % 9}
	return s, d.matchups[int(in.matchup)%len(d.matchups)]
}

func (d fuzzDecoder) decode(in fuzzInput) (State, Plan, Plan) {
	s, decks := d.state(in)
	plansA, plansB := d.rs.LegalPlans(s, SideA, decks[0]), d.rs.LegalPlans(s, SideB, decks[1])
	return s, plansA[int(in.pickA)%len(plansA)], plansB[int(in.pickB)%len(plansB)]
}

// seed fills in the plan indexes of in so that it decodes to the named plans.
func (d fuzzDecoder) seed(tb testing.TB, in fuzzInput, a, b []string) fuzzInput {
	tb.Helper()
	pa, okA := d.rs.PlanOf(a...)
	pb, okB := d.rs.PlanOf(b...)
	require.True(tb, okA && okB, "unknown card in %v or %v", a, b)
	s, decks := d.state(in)
	ia := slices.IndexFunc(d.rs.LegalPlans(s, SideA, decks[0]), func(p Plan) bool { return slices.Equal(p, pa) })
	ib := slices.IndexFunc(d.rs.LegalPlans(s, SideB, decks[1]), func(p Plan) bool { return slices.Equal(p, pb) })
	require.True(tb, ia >= 0 && ib >= 0, "%v or %v is not a legal plan of its deck", a, b)
	in.pickA, in.pickB = uint16(ia), uint16(ib)
	_, gotA, gotB := d.decode(in)
	require.True(tb, slices.Equal(gotA, pa) && slices.Equal(gotB, pb), "seed %v vs %v does not decode to its plans", a, b)
	return in
}

func FuzzResolve(f *testing.F) {
	rs := ProofOfConcept()
	pickers, okP := rs.ClanByName("Pickers")
	ironhide, okI := rs.ClanByName("Ironhide")
	delvers, okD := rs.ClanByName("Delvers")
	require.True(f, okP && okI && okD)
	const (
		pickersMirror = iota
		ironhideMirror
		delversMirror
		pickersAgainstIronhide
		delversAgainstPickers
		delversAgainstIronhide
	)
	d := fuzzDecoder{rs: rs, matchups: [6][2]uint64{
		pickersMirror:          {pickers.Pool, pickers.Pool},
		ironhideMirror:         {ironhide.Pool, ironhide.Pool},
		delversMirror:          {delvers.Pool, delvers.Pool},
		pickersAgainstIronhide: {pickers.Pool, ironhide.Pool},
		delversAgainstPickers:  {delvers.Pool, pickers.Pool},
		delversAgainstIronhide: {delvers.Pool, ironhide.Pool},
	}}

	fresh := fuzzInput{matchup: pickersAgainstIronhide, round: 0, hpA: 14, hpB: 14}
	lastRound := fuzzInput{matchup: pickersMirror, round: 2, hpA: 14, hpB: 14}
	bothAtOne := fuzzInput{matchup: pickersMirror, round: 0, hpA: 0, hpB: 0}
	capped := fuzzInput{matchup: pickersAgainstIronhide, round: 0, hpA: 14, strA: 8, hpB: 14, vulnB: 3}
	tokens := fuzzInput{matchup: delversMirror, round: 1, hpA: 14, vulnA: 2, hpB: 14, vulnB: 1}
	seeds := []struct {
		in   fuzzInput
		a, b []string
	}{
		{fresh, []string{"Chalk Dust", "Double Tap"}, []string{"Hammer Blow", "Spiked Shield"}},
		{fresh, []string{"Pick", "Pick", "Sling Stone"}, []string{"Stone Guard"}},
		{fresh, []string{"Pickaxe Flurry", "Dodge Roll"}, []string{"Anvil Stomp", "Cobble Throw"}},
		{bothAtOne, []string{"Pickaxe Flurry", "Pick", "Pick"}, []string{"Pickaxe Flurry", "Pick", "Pick"}},
		{lastRound, []string{"Brace", "Brace", "Brace"}, []string{"Brace", "Brace", "Brace"}},
		{capped, []string{"Momentum", "Chalk Dust", "Brace"}, []string{"Brace", "Brace", "Brace"}},
		{tokens, []string{"Blowback", "Brace"}, []string{"Blowback", "Brace"}},
	}
	for _, sd := range seeds {
		in := d.seed(f, sd.in, sd.a, sd.b)
		f.Add(in.matchup, in.round, in.hpA, in.vulnA, in.strA, in.hpB, in.vulnB, in.strB, in.pickA, in.pickB)
	}

	f.Fuzz(func(t *testing.T, matchup, round, hpA, vulnA, strA, hpB, vulnB, strB uint8, pickA, pickB uint16) {
		s, a, b := d.decode(fuzzInput{matchup, round, hpA, vulnA, strA, hpB, vulnB, strB, pickA, pickB})

		o := rs.Resolve(s, a, b)
		w := rs.Resolve(swapped(s), b, a)
		require.Equal(t, mirrored(o.Result), w.Result, "result under side swap")
		require.Equal(t, swapped(o.State), w.State, "state under side swap")

		for side, p := range [2]Plan{a, b} {
			g := o.State.Gnomes[side]
			require.LessOrEqual(t, g.Vulnerable, rs.VulnerableCap)
			require.LessOrEqual(t, g.Strength, rs.StrengthCap)
			for _, id := range p {
				if rs.Cards[id].Special {
					require.NotZero(t, g.Spent&(uint64(1)<<uint(id)), "side %d did not spend %s", side, rs.Cards[id].Name)
				}
			}
		}
	})
}
