// Package bridge exposes the duel engine to the page. Every method takes one JSON
// request and returns one JSON response, or {"error": message}; it never panics on input.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"gnomehall/cardfile"
	"gnomehall/cardtext"
	"gnomehall/p/engine"
)

// Bridge holds the ruleset loaded by Load. The other methods fail until then.
type Bridge struct {
	rs *engine.Ruleset
}

func New() *Bridge {
	return &Bridge{}
}

var errNotLoaded = errors.New("no card file loaded")

var (
	tierNames  = [...]string{engine.Quick: "Quick", engine.Normal: "Normal", engine.Slow: "Slow"}
	phaseNames = [...]string{engine.InterruptPhase: "Interrupt", engine.BlockPhase: "Block", engine.DamagePhase: "Damage"}
	kindNames  = [...]string{
		engine.Cancelled: "Cancelled", engine.ParryEnded: "ParryEnded",
		engine.BlockGained: "BlockGained", engine.CounterGained: "CounterGained",
		engine.HitLanded: "HitLanded", engine.CounterHit: "CounterHit",
		engine.VulnerableApplied: "VulnerableApplied", engine.StrengthGained: "StrengthGained",
		engine.VulnerableMoved: "VulnerableMoved", engine.VulnerableGained: "VulnerableGained",
		engine.BlockStripped: "BlockStripped",
	}
	resultNames = [...]string{engine.Ongoing: "ongoing", engine.AWins: "a", engine.BWins: "b", engine.Draw: "draw"}
)

// Load parses a card file, keeps its ruleset and returns the RulesetView.
func (b *Bridge) Load(cardsJSON string) string {
	rs, err := cardfile.Load([]byte(cardsJSON))
	if err != nil {
		return fail(err)
	}
	b.rs = rs
	view := RulesetView{HP: rs.HP}
	for i, c := range rs.Cards {
		view.Cards = append(view.Cards, CardView{
			ID: i, Name: c.Name, Cost: c.Cost, Tier: tierNames[c.Tier], Special: c.Special, Rare: c.Rare,
			Interrupt: c.Interrupt, Parry: c.Parry, Text: cardtext.Text(c),
		})
	}
	for _, clan := range rs.Clans {
		view.Clans = append(view.Clans, ClanView{Name: clan.Name, Cards: idsOf(clan.Pool)})
	}
	return respond(view)
}

// LegalDeck answers a LegalDeckRequest with {"legal": bool}.
func (b *Bridge) LegalDeck(req string) string {
	var r LegalDeckRequest
	if err := b.parse(req, &r); err != nil {
		return fail(err)
	}
	clan, ok := b.rs.ClanByName(r.Clan)
	if !ok {
		return fail(fmt.Errorf("clan %q unknown", r.Clan))
	}
	deck, err := b.bitsOf(r.Deck)
	if err != nil {
		return fail(err)
	}
	return respond(struct {
		Legal bool `json:"legal"`
	}{b.rs.LegalDeck(clan, deck)})
}

// LegalPlans answers a LegalPlansRequest with {"plans": [[ids]...]} in the engine's order.
func (b *Bridge) LegalPlans(req string) string {
	var r LegalPlansRequest
	if err := b.parse(req, &r); err != nil {
		return fail(err)
	}
	s, err := b.state(r.State)
	if err != nil {
		return fail(err)
	}
	if r.Side != 0 && r.Side != 1 {
		return fail(errors.New("side must be 0 or 1"))
	}
	deck, err := b.bitsOf(r.Deck)
	if err != nil {
		return fail(err)
	}
	plans := b.rs.LegalPlans(s, engine.Side(r.Side), deck)
	out := make([][]int, 0, len(plans))
	for _, p := range plans {
		out = append(out, planIDs(p))
	}
	return respond(struct {
		Plans [][]int `json:"plans"`
	}{out})
}

// Resolve answers a ResolveRequest with the ResolveResponse of the round. Each plan must
// be legal for its side and deck.
func (b *Bridge) Resolve(req string) string {
	var r ResolveRequest
	if err := b.parse(req, &r); err != nil {
		return fail(err)
	}
	s, err := b.state(r.State)
	if err != nil {
		return fail(err)
	}
	var plans [2]engine.Plan
	for side, ids := range [2][]int{r.A, r.B} {
		deck, err := b.bitsOf(r.Decks[side])
		if err != nil {
			return fail(err)
		}
		plan, err := b.plan(ids)
		if err != nil {
			return fail(err)
		}
		legal := b.rs.LegalPlans(s, engine.Side(side), deck)
		if !slices.ContainsFunc(legal, func(p engine.Plan) bool { return slices.Equal(p, plan) }) {
			return fail(fmt.Errorf("plan %v is not legal for side %d", ids, side))
		}
		plans[side] = plan
	}
	o, events := b.rs.Trace(s, plans[0], plans[1])
	resp := ResolveResponse{State: stateView(o.State), Result: resultNames[o.Result], Events: make([]EventView, 0, len(events))}
	for _, e := range events {
		resp.Events = append(resp.Events, EventView{
			Beat: e.Beat, Phase: phaseNames[e.Phase], Tier: tierNames[e.Tier], Step: e.Step, Kind: kindNames[e.Kind],
			Side: int(e.Side), Card: int(e.Card), N: e.N, Blocked: e.Blocked, Doubled: e.Doubled,
			After: [2]VitalsView{vitalsView(e.After[0]), vitalsView(e.After[1])},
		})
	}
	return respond(resp)
}

// parse decodes a request; it fails before any card file is loaded.
func (b *Bridge) parse(req string, into any) error {
	if b.rs == nil {
		return errNotLoaded
	}
	if err := json.Unmarshal([]byte(req), into); err != nil {
		return fmt.Errorf("parse request: %w", err)
	}
	return nil
}

func (b *Bridge) state(v StateView) (engine.State, error) {
	if v.Round < 1 || v.Round > 3 {
		return engine.State{}, errors.New("round must be 1 to 3")
	}
	s := engine.State{Round: v.Round}
	for i, g := range v.Gnomes {
		spent, err := b.bitsOf(g.Spent)
		if err != nil {
			return engine.State{}, err
		}
		s.Gnomes[i] = engine.Gnome{HP: g.HP, Vulnerable: g.Vulnerable, Strength: g.Strength, Spent: spent}
	}
	return s, nil
}

func stateView(s engine.State) StateView {
	v := StateView{Round: s.Round}
	for i, g := range s.Gnomes {
		v.Gnomes[i] = GnomeView{HP: g.HP, Vulnerable: g.Vulnerable, Strength: g.Strength, Spent: idsOf(g.Spent)}
	}
	return v
}

func vitalsView(v engine.Vitals) VitalsView {
	return VitalsView{HP: v.HP, Block: v.Block, Counter: v.Counter, Vulnerable: v.Vulnerable, Strength: v.Strength}
}

func (b *Bridge) plan(ids []int) (engine.Plan, error) {
	plan := make(engine.Plan, 0, len(ids))
	for _, id := range ids {
		if err := b.checkID(id); err != nil {
			return nil, err
		}
		plan = append(plan, engine.CardID(id))
	}
	return plan, nil
}

func planIDs(p engine.Plan) []int {
	ids := make([]int, 0, len(p))
	for _, id := range p {
		ids = append(ids, int(id))
	}
	return ids
}

func (b *Bridge) bitsOf(ids []int) (uint64, error) {
	var bits uint64
	for _, id := range ids {
		if err := b.checkID(id); err != nil {
			return 0, err
		}
		bits |= uint64(1) << uint(id)
	}
	return bits, nil
}

func (b *Bridge) checkID(id int) error {
	if id < 0 || id >= len(b.rs.Cards) {
		return fmt.Errorf("card id %d out of range", id)
	}
	return nil
}

// idsOf lists a bit set's ids ascending; an empty set is [] rather than null.
func idsOf(bits uint64) []int {
	ids := []int{}
	for i := 0; bits != 0; i, bits = i+1, bits>>1 {
		if bits&1 != 0 {
			ids = append(ids, i)
		}
	}
	return ids
}

func respond(v any) string {
	out, err := json.Marshal(v)
	if err != nil {
		return fail(err)
	}
	return string(out)
}

func fail(err error) string {
	out, _ := json.Marshal(struct {
		Error string `json:"error"`
	}{err.Error()})
	return string(out)
}
