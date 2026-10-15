package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func vit(hp, block, counter, vulnerable, strength int) Vitals {
	return Vitals{HP: hp, Block: block, Counter: counter, Vulnerable: vulnerable, Strength: strength}
}

// ev builds an expected event, looking the card up by name.
func ev(t *testing.T, rs *Ruleset, beat int, phase Phase, tier Tier, step int, kind EventKind, side Side, card string, n, blocked int, doubled bool, after [2]Vitals) Event {
	t.Helper()
	id, ok := rs.CardByName(card)
	require.True(t, ok, "card %q", card)
	return Event{Beat: beat, Phase: phase, Tier: tier, Step: step, Kind: kind, Side: side, Card: id, N: n, Blocked: blocked, Doubled: doubled, After: after}
}

func traceOf(t *testing.T, rs *Ruleset, a, b []string) (Outcome, []Event) {
	t.Helper()
	return rs.Trace(rs.Start(), mustPlan(t, rs, a...), mustPlan(t, rs, b...))
}

// The duel spec's worked example, event by event.
func TestTraceWorkedExample(t *testing.T) {
	rs := ProofOfConcept()
	o, events := traceOf(t, rs, []string{"Chalk Dust", "Double Tap"}, []string{"Hammer Blow", "Spiked Shield"})
	require.Equal(t, Ongoing, o.Result)
	want := []Event{
		ev(t, rs, 1, DamagePhase, Quick, 1, VulnerableApplied, SideA, "Chalk Dust", 1, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 0, 0, 1, 0)}),
		ev(t, rs, 2, DamagePhase, Slow, 1, HitLanded, SideB, "Hammer Blow", 5, 0, false, [2]Vitals{vit(10, 0, 0, 0, 0), vit(15, 0, 0, 1, 0)}),
		ev(t, rs, 3, BlockPhase, Normal, 1, BlockGained, SideB, "Spiked Shield", 1, 0, false, [2]Vitals{vit(10, 0, 0, 0, 0), vit(15, 1, 1, 1, 0)}),
		ev(t, rs, 3, BlockPhase, Normal, 1, CounterGained, SideB, "Spiked Shield", 1, 0, false, [2]Vitals{vit(10, 0, 0, 0, 0), vit(15, 1, 1, 1, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 1, HitLanded, SideA, "Double Tap", 1, 1, true, [2]Vitals{vit(9, 0, 0, 0, 0), vit(14, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 1, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(9, 0, 0, 0, 0), vit(14, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 2, HitLanded, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(8, 0, 0, 0, 0), vit(13, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 2, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(8, 0, 0, 0, 0), vit(13, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 3, HitLanded, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(7, 0, 0, 0, 0), vit(12, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 3, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(7, 0, 0, 0, 0), vit(12, 0, 1, 0, 0)}),
	}
	assert.Equal(t, want, events)
}

// Kneecap cancels the winding-up Hammer Blow; its beat 2 stays empty.
func TestTraceKneecapCancelsHammerBlow(t *testing.T) {
	rs := ProofOfConcept()
	o, events := traceOf(t, rs, []string{"Kneecap", "Double Tap"}, []string{"Hammer Blow", "Spiked Shield"})
	require.Equal(t, Ongoing, o.Result)
	full := [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 0, 0, 0, 0)}
	want := []Event{
		ev(t, rs, 1, InterruptPhase, Quick, 1, Cancelled, SideB, "Hammer Blow", 0, 0, false, full),
		ev(t, rs, 1, DamagePhase, Quick, 1, HitLanded, SideA, "Kneecap", 1, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(14, 0, 0, 0, 0)}),
		ev(t, rs, 3, BlockPhase, Normal, 1, BlockGained, SideB, "Spiked Shield", 1, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(14, 1, 1, 0, 0)}),
		ev(t, rs, 3, BlockPhase, Normal, 1, CounterGained, SideB, "Spiked Shield", 1, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(14, 1, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 1, HitLanded, SideA, "Double Tap", 0, 1, false, [2]Vitals{vit(14, 0, 0, 0, 0), vit(14, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 1, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(14, 0, 0, 0, 0), vit(14, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 2, HitLanded, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(13, 0, 0, 0, 0), vit(13, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 2, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(13, 0, 0, 0, 0), vit(13, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 3, HitLanded, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(12, 0, 0, 0, 0), vit(12, 0, 1, 0, 0)}),
		ev(t, rs, 3, DamagePhase, Normal, 3, CounterHit, SideA, "Double Tap", 1, 0, false, [2]Vitals{vit(12, 0, 0, 0, 0), vit(12, 0, 1, 0, 0)}),
	}
	assert.Equal(t, want, events)
}

// Stone Guard lets Chalk Dust through, a non-attack, and cancels Double Tap as it lands.
func TestTraceStoneGuardCancelsDoubleTap(t *testing.T) {
	rs := ProofOfConcept()
	o, events := traceOf(t, rs, []string{"Chalk Dust", "Double Tap"}, []string{"Stone Guard"})
	require.Equal(t, Ongoing, o.Result)
	after := [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 0, 0, 1, 0)}
	want := []Event{
		ev(t, rs, 1, DamagePhase, Quick, 1, VulnerableApplied, SideA, "Chalk Dust", 1, 0, false, after),
		ev(t, rs, 3, InterruptPhase, Normal, 1, Cancelled, SideA, "Double Tap", 0, 0, false, after),
	}
	assert.Equal(t, want, events)
}

// Two Picks use up a Parry 2, which ends in the same step as its second cancel.
func TestTraceParryEnds(t *testing.T) {
	rs := ProofOfConcept()
	o, events := traceOf(t, rs, []string{"Pick", "Pick", "Sling Stone"}, []string{"Stone Guard"})
	require.Equal(t, Ongoing, o.Result)
	full := [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 0, 0, 0, 0)}
	want := []Event{
		ev(t, rs, 1, InterruptPhase, Normal, 1, Cancelled, SideA, "Pick", 0, 0, false, full),
		ev(t, rs, 2, InterruptPhase, Normal, 1, Cancelled, SideA, "Pick", 0, 0, false, full),
		ev(t, rs, 2, InterruptPhase, Normal, 1, ParryEnded, SideB, "Stone Guard", 0, 0, false, full),
		ev(t, rs, 3, DamagePhase, Normal, 1, HitLanded, SideA, "Sling Stone", 2, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(13, 0, 0, 0, 0)}),
	}
	assert.Equal(t, want, events)
}

// A gnome hit and countered in one step: Block absorbs the hit first, then the Counter damage.
func TestTraceSplitsBlockBetweenHitAndCounter(t *testing.T) {
	rs := ProofOfConcept()
	_, events := traceOf(t, rs, []string{"Brace", "Pick", "Pick"}, []string{"Spiked Shield", "Sling Stone", "Pick"})
	var beat2 []Event
	for _, e := range events {
		if e.Beat == 2 && e.Phase == DamagePhase {
			beat2 = append(beat2, e)
		}
	}
	after := [2]Vitals{vit(13, 0, 0, 0, 0), vit(15, 0, 1, 0, 0)}
	want := []Event{
		ev(t, rs, 2, DamagePhase, Normal, 1, HitLanded, SideA, "Pick", 0, 1, false, after),
		ev(t, rs, 2, DamagePhase, Normal, 1, CounterHit, SideA, "Pick", 1, 0, false, after),
		ev(t, rs, 2, DamagePhase, Normal, 1, HitLanded, SideB, "Sling Stone", 1, 1, false, after),
	}
	assert.Equal(t, want, beat2)
}

// A cancelled Feint gains its "if cancelled" Block in the Block phase of the same beat.
func TestTraceOnCancelBlock(t *testing.T) {
	rs := ProofOfConcept()
	_, events := traceOf(t, rs, []string{"Kneecap", "Pick", "Pick"}, []string{"Feint", "Brace"})
	require.GreaterOrEqual(t, len(events), 3)
	want := []Event{
		ev(t, rs, 1, InterruptPhase, Quick, 1, Cancelled, SideB, "Feint", 0, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 0, 0, 0, 0)}),
		ev(t, rs, 1, BlockPhase, Normal, 1, BlockGained, SideB, "Feint", 4, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 4, 0, 0, 0)}),
		ev(t, rs, 1, DamagePhase, Quick, 1, HitLanded, SideA, "Kneecap", 0, 1, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 3, 0, 0, 0)}),
	}
	assert.Equal(t, want, events[:3])
}

// Trace and Resolve agree on every legal plan pair of the two starter decks.
func TestTraceAgreesWithResolve(t *testing.T) {
	rs := ProofOfConcept()
	deckA := clanPool(t, rs, "Pickers") &^ cardBits(t, rs, "Hunker Down", "Boot and Heel")
	deckB := clanPool(t, rs, "Ironhide") &^ cardBits(t, rs, "Shield Catch", "Loose Timbers")
	states := map[string]State{
		"round 1": rs.Start(),
		"round 3": stateOf(3, [2][3]int{{6, 1, 0}, {5, 0, 0}}),
	}
	for name, s := range states {
		t.Run(name, func(t *testing.T) {
			plansA, plansB := rs.LegalPlans(s, SideA, deckA), rs.LegalPlans(s, SideB, deckB)
			for _, a := range plansA {
				for _, b := range plansB {
					want := rs.Resolve(s, a, b)
					got, events := rs.Trace(s, a, b)
					require.Equal(t, want, got, "%v vs %v", a, b)
					if len(events) == 0 {
						continue
					}
					last := events[len(events)-1]
					require.Equal(t, got.State.Gnomes[SideA].HP, last.After[SideA].HP, "%v vs %v", a, b)
					require.Equal(t, got.State.Gnomes[SideB].HP, last.After[SideB].HP, "%v vs %v", a, b)
					beat := 1
					for _, e := range events {
						require.GreaterOrEqual(t, e.Beat, beat, "%v vs %v", a, b)
						require.GreaterOrEqual(t, e.Step, 1, "%v vs %v", a, b)
						beat = e.Beat
					}
				}
			}
		})
	}
}

func TestResolveDoesNotAllocate(t *testing.T) {
	rs := ProofOfConcept()
	a, b := mustPlan(t, rs, "Chalk Dust", "Double Tap"), mustPlan(t, rs, "Hammer Blow", "Spiked Shield")
	s := rs.Start()
	assert.Zero(t, testing.AllocsPerRun(1000, func() { rs.Resolve(s, a, b) }))
}

// Two Blowbacks land on beat 2 and swap their tokens in the Block phase.
func TestTraceBlowbackSwap(t *testing.T) {
	rs := ProofOfConcept()
	p := mustPlan(t, rs, "Blowback", "Brace")
	o, events := rs.Trace(stateOf(1, [2][3]int{{15, 2, 0}, {15, 1, 0}}), p, p)
	require.Equal(t, Ongoing, o.Result)
	swapped := [2]Vitals{vit(15, 0, 0, 1, 0), vit(15, 0, 0, 2, 0)}
	want := []Event{
		ev(t, rs, 2, BlockPhase, Normal, 1, VulnerableMoved, SideA, "Blowback", 2, 0, false, swapped),
		ev(t, rs, 2, BlockPhase, Normal, 1, VulnerableMoved, SideB, "Blowback", 1, 0, false, swapped),
	}
	assert.Equal(t, want, events[:2])
}

// Tokens over the receiver's cap are lost; N counts every token that left the mover.
func TestTraceMoveIntoTheCap(t *testing.T) {
	rs := ProofOfConcept()
	o, events := rs.Trace(stateOf(1, [2][3]int{{15, 3, 0}, {15, 2, 0}}), mustPlan(t, rs, "Blowback", "Brace"), mustPlan(t, rs, "Brace", "Brace", "Brace"))
	require.Equal(t, Ongoing, o.Result)
	want := ev(t, rs, 2, BlockPhase, Normal, 1, VulnerableMoved, SideA, "Blowback", 3, 0, false, [2]Vitals{vit(15, 0, 0, 0, 0), vit(15, 2, 0, 3, 0)})
	assert.Contains(t, events, want)
}
