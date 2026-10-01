package engine

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func mustPlan(t *testing.T, rs *Ruleset, names ...string) Plan {
	t.Helper()
	p, ok := rs.PlanOf(names...)
	require.True(t, ok, "unknown card in %v", names)
	return p
}

func stateOf(round int, start [2][3]int) State {
	s := State{Round: round}
	for i := range s.Gnomes {
		s.Gnomes[i] = Gnome{HP: start[i][0], Vulnerable: start[i][1], Strength: start[i][2]}
	}
	return s
}

func TestResolveMatchesModel(t *testing.T) {
	rs := ProofOfConcept()
	for i, tc := range resolveCases {
		name := strconv.Itoa(i) + " " + strings.Join(tc.A, ",") + " vs " + strings.Join(tc.B, ",")
		t.Run(name, func(t *testing.T) {
			o := rs.Resolve(stateOf(tc.Round, tc.Start), mustPlan(t, rs, tc.A...), mustPlan(t, rs, tc.B...))
			require.Equal(t, tc.Result, o.Result)
			if tc.End == ([2][3]int{}) {
				return
			}
			for side := range o.State.Gnomes {
				g := o.State.Gnomes[side]
				assert.Equal(t, tc.End[side], [3]int{g.HP, g.Vulnerable, g.Strength}, "side %d", side)
			}
		})
	}
}

func TestWorkedExample(t *testing.T) {
	rs := ProofOfConcept()
	cases := map[string]struct {
		a, b        []string
		hpA, hpB    int
		vulnerableB int
	}{
		"printed pair":            {[]string{"Chalk Dust", "Double Tap"}, []string{"Hammer Blow", "Spiked Shield"}, 7, 12, 0},
		"Kneecap cancels Hammer":  {[]string{"Kneecap", "Double Tap"}, []string{"Hammer Blow", "Spiked Shield"}, 12, 12, 0},
		"Stone Guard cancels Tap": {[]string{"Chalk Dust", "Double Tap"}, []string{"Stone Guard"}, 15, 15, 1},
		"Parry 2 runs out":        {[]string{"Pick", "Pick", "Sling Stone"}, []string{"Stone Guard"}, 15, 13, 0},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			o := rs.Resolve(rs.Start(), mustPlan(t, rs, tc.a...), mustPlan(t, rs, tc.b...))
			require.Equal(t, Ongoing, o.Result)
			assert.Equal(t, 2, o.State.Round)
			assert.Equal(t, tc.hpA, o.State.Gnomes[SideA].HP)
			assert.Equal(t, tc.hpB, o.State.Gnomes[SideB].HP)
			assert.Equal(t, tc.vulnerableB, o.State.Gnomes[SideB].Vulnerable)
		})
	}
}

func TestResolveSpendsPlayedSpecials(t *testing.T) {
	rs := ProofOfConcept()
	o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Kneecap", "Double Tap"), mustPlan(t, rs, "Hammer Blow", "Spiked Shield"))
	assert.Equal(t, cardBits(t, rs, "Kneecap", "Double Tap"), o.State.Gnomes[SideA].Spent)
	assert.Equal(t, cardBits(t, rs, "Hammer Blow", "Spiked Shield"), o.State.Gnomes[SideB].Spent)
}

func TestDoubleKnockoutIsADraw(t *testing.T) {
	rs := ProofOfConcept()
	s := stateOf(1, [2][3]int{{1, 0, 0}, {1, 0, 0}})
	p := mustPlan(t, rs, "Pickaxe Flurry", "Pick", "Pick")
	assert.Equal(t, Draw, rs.Resolve(s, p, p).Result)
}

func TestRoundThreeDecidesByHP(t *testing.T) {
	rs := ProofOfConcept()
	braces := mustPlan(t, rs, "Brace", "Brace", "Brace")
	assert.Equal(t, Draw, rs.Resolve(stateOf(3, [2][3]int{{15, 0, 0}, {15, 0, 0}}), braces, braces).Result)
	assert.Equal(t, AWins, rs.Resolve(stateOf(3, [2][3]int{{15, 0, 0}, {14, 0, 0}}), braces, braces).Result)
}

func BenchmarkResolve(b *testing.B) {
	rs := ProofOfConcept()
	pa, _ := rs.PlanOf("Chalk Dust", "Momentum", "Pickaxe Flurry")
	pb, _ := rs.PlanOf("Pickaxe Flurry", "Dodge Roll")
	s := rs.Start()
	b.ReportAllocs()
	for b.Loop() {
		rs.Resolve(s, pa, pb)
	}
}

// withRiposte adds Riposte, a Parry 1 card that deals 2, to the Pickers' pool.
func withRiposte() *Ruleset {
	rs := ProofOfConcept()
	rs.Cards = append(rs.Cards, Card{Name: "Riposte", Cost: 2, Tier: Normal, Special: true, Parry: 1, Damage: hits(1, 2)})
	riposte := uint64(1) << uint(len(rs.Cards)-1)
	for i := range rs.Clans {
		if rs.Clans[i].Name == "Pickers" {
			rs.Clans[i].Pool |= riposte
		}
	}
	return rs
}

// A Parry card whose last cancel falls on its landing beat still resolves its own
// effects on that beat.
func TestParryResolvesItsEffectsOnItsLastCancel(t *testing.T) {
	rs := withRiposte()
	// Beat 3: Riposte cancels the Pick (2 damage with Momentum) and lands its own 2.
	o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Pick", "Riposte"), mustPlan(t, rs, "Pick", "Momentum", "Pick"))
	require.Equal(t, Ongoing, o.Result)
	assert.Equal(t, 14, o.State.Gnomes[SideA].HP)
	assert.Equal(t, 12, o.State.Gnomes[SideB].HP)
}

// A Parry that used up its cancels before its last beat has left play: its own effects
// never resolve.
func TestParryThatEndedEarlierResolvesNothing(t *testing.T) {
	rs := withRiposte()
	// Beat 1: Riposte cancels a Pick and ends. Beat 2 is empty, so the Pick lands and
	// Riposte's 2 never does. Beat 3: Pick against Pick.
	o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Riposte", "Pick"), mustPlan(t, rs, "Pick", "Pick", "Pick"))
	require.Equal(t, Ongoing, o.Result)
	assert.Equal(t, 13, o.State.Gnomes[SideA].HP)
	assert.Equal(t, 14, o.State.Gnomes[SideB].HP)
}

// A Parry card lands once, on its last beat, like every other card.
func TestParryEffectsResolveOnceOnTheLastBeat(t *testing.T) {
	rs := withRiposte()
	// Riposte's 2 lands on beat 2 only, into the 2 Block of two Braces; beat 3's Pick
	// meets the third Brace.
	o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Riposte", "Pick"), mustPlan(t, rs, "Brace", "Brace", "Brace"))
	require.Equal(t, Ongoing, o.Result)
	assert.Equal(t, 15, o.State.Gnomes[SideB].HP)
}

// A Parry card that deals damage is an attack landing on its last beat, so a Parry
// catches it there.
func TestParryCardIsCaughtOnItsLastBeat(t *testing.T) {
	rs := withRiposte()
	// Beat 2: Riposte lands into Dodge Roll, which cancels it and ends. Beat 3: the Pick
	// meets Brace's Block.
	o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Riposte", "Pick"), mustPlan(t, rs, "Brace", "Dodge Roll"))
	require.Equal(t, Ongoing, o.Result)
	assert.Equal(t, 15, o.State.Gnomes[SideA].HP)
	assert.Equal(t, 15, o.State.Gnomes[SideB].HP)
}

func TestCancelDamageMakesAnAttack(t *testing.T) {
	rs := ProofOfConcept()
	id, ok := rs.CardByName("Loose Timbers")
	require.True(t, ok)
	assert.True(t, rs.Cards[id].Attack())
}

// A card whose cancel text deals damage deals it on the beat it is cancelled.
func TestCancelDamage(t *testing.T) {
	rs := ProofOfConcept()
	cases := map[string]struct {
		a, b     []string
		hpA, hpB int
	}{
		// Beat 2: Stone Guard cancels Loose Timbers as it lands, and takes its 4.
		"into a Parry": {[]string{"Loose Timbers", "Pick"}, []string{"Stone Guard"}, 15, 11},
		// Beat 1: Kneecap cancels the wind-up, deals 1 and takes 4.
		"into an Interrupt": {[]string{"Loose Timbers", "Pick"}, []string{"Kneecap", "Brace", "Brace"}, 14, 11},
		// Not cancelled: beat 1's Pick lands before the 3 Block, which absorbs the other two.
		"not cancelled": {[]string{"Loose Timbers", "Brace"}, []string{"Pick", "Pick", "Pick"}, 14, 15},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			o := rs.Resolve(rs.Start(), mustPlan(t, rs, tc.a...), mustPlan(t, rs, tc.b...))
			require.Equal(t, Ongoing, o.Result)
			assert.Equal(t, tc.hpA, o.State.Gnomes[SideA].HP)
			assert.Equal(t, tc.hpB, o.State.Gnomes[SideB].HP)
		})
	}
}

// Chalk Dust, then Double Tap's three hits of 1 against a Vulnerable gnome.
func TestVulnerableDoubling(t *testing.T) {
	cases := map[string]struct {
		oneHit bool
		hpB    int
	}{
		"every hit of the next card": {false, 9},
		"the next hit only":          {true, 11},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			rs := ProofOfConcept()
			rs.VulnerableDoublesOneHit = tc.oneHit
			o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Chalk Dust", "Double Tap"), mustPlan(t, rs, "Pick", "Pick", "Pick"))
			require.Equal(t, Ongoing, o.Result)
			assert.Equal(t, 12, o.State.Gnomes[SideA].HP)
			assert.Equal(t, tc.hpB, o.State.Gnomes[SideB].HP)
			assert.Equal(t, 0, o.State.Gnomes[SideB].Vulnerable)
		})
	}
}

// Momentum, then Pickaxe Flurry's two hits of 1 plus 1 Strength into two Braces' Block.
func TestStrengthDuration(t *testing.T) {
	cases := map[string]struct {
		lastsTheRound bool
		strengthA     int
	}{
		"until the end of the round": {true, 0},
		"for the match":              {false, 1},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			rs := ProofOfConcept()
			rs.StrengthLastsTheRound = tc.lastsTheRound
			o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Momentum", "Pickaxe Flurry", "Brace"), mustPlan(t, rs, "Brace", "Brace", "Brace"))
			require.Equal(t, Ongoing, o.Result)
			assert.Equal(t, 13, o.State.Gnomes[SideB].HP)
			assert.Equal(t, tc.strengthA, o.State.Gnomes[SideA].Strength)
		})
	}
}

// Chalk Dust leaves Ironhide 1 Vulnerable that no hit uses this round.
func TestVulnerableDuration(t *testing.T) {
	cases := map[string]struct {
		lastsTheRound bool
		vulnerableB   int
	}{
		"until the end of the round": {true, 0},
		"until used":                 {false, 1},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			rs := ProofOfConcept()
			rs.VulnerableLastsTheRound = tc.lastsTheRound
			o := rs.Resolve(rs.Start(), mustPlan(t, rs, "Chalk Dust", "Brace", "Brace"), mustPlan(t, rs, "Brace", "Brace", "Brace"))
			require.Equal(t, Ongoing, o.Result)
			assert.Equal(t, tc.vulnerableB, o.State.Gnomes[SideB].Vulnerable)
		})
	}
}
