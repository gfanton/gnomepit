package arena

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"gno.land/p/gfanton/gnomehall/engine"
)

// Accept answers open challenge id as clan, with deck and the round-1 plan in plain
// text. When the challenge names an opponent, only that address may accept.
func Accept(cur realm, id, clan, deck, plan string) {
	m := find(id)
	now := time.Now().Unix()
	if m.phase != phaseOpen {
		panic("wrong phase")
	}
	if m.expired(now) {
		panic("challenge expired")
	}
	caller := cur.Previous().Address()
	if m.opponent != "" && caller != m.opponent {
		panic("not the named opponent")
	}
	c, ok := rules.ClanByName(clan)
	if !ok {
		panic("unknown clan")
	}
	bits := deckBits(c, deck)
	if !legal(m.state, engine.SideB, bits, planOf(plan)) {
		panic("illegal plan")
	}

	m.acceptor = caller
	m.clans[1] = clan
	m.decks[1] = deck
	m.deckBits[1] = bits
	m.plans = append(m.plans, [2]string{"", plan})
	m.phase = phaseReveal
	m.deadline = now + moveWindow
	index(caller, key(m.id), m)
	tell("Turn", m.challenger, caller, m, clan+" accepted your challenge. Your move within 24 hours.")
}

// Reveal opens the challenger's sealed plan for the round being played, and on the
// first reveal the sealed deck, then resolves the round. A match that goes on needs
// nextSeal and nextBox for the challenger's next plan; one that ends takes neither.
func Reveal(cur realm, id, deck, deckSalt, plan, planSalt, nextSeal, nextBox string) {
	m := find(id)
	now := time.Now().Unix()
	caller := cur.Previous().Address()
	m.checkMove(caller, phaseReveal, m.challenger, now)

	bits := m.deckBits[0]
	if len(m.hp) == 0 {
		if deck == "" {
			panic("deck required")
		}
		checkSeal(m.deckSeal, deckSalt, deck)
		c, _ := rules.ClanByName(m.clans[0])
		bits = deckBits(c, deck)
	} else if deck != "" || deckSalt != "" {
		panic("deck already revealed")
	}
	checkSeal(m.seal, planSalt, plan)
	a := planOf(plan)
	if !legal(m.state, engine.SideA, bits, a) {
		panic("illegal plan")
	}
	round := m.state.Round
	o := rules.Resolve(m.state, a, planOf(m.plans[round-1][1]))
	if o.Result == engine.Ongoing {
		if nextSeal == "" {
			panic("next seal required")
		}
		if !validSeal(nextSeal) {
			panic("invalid seal")
		}
		if len(nextBox) == 0 || len(nextBox) > maxBox {
			panic("invalid box")
		}
	} else if nextSeal != "" || nextBox != "" {
		panic("unexpected next seal")
	}

	if len(m.hp) == 0 {
		m.decks[0] = deck
		m.deckBits[0] = bits
	}
	m.plans[round-1][0] = plan
	m.state = o.State
	m.hp = append(m.hp, [2]int{o.State.Gnomes[0].HP, o.State.Gnomes[1].HP})
	m.seal, m.box = nextSeal, nextBox
	if o.Result != engine.Ongoing {
		m.end(resultName(o.Result), reasonOf(o.State))
		tellEnded(m, caller)
		return
	}
	m.plans = append(m.plans, [2]string{})
	m.phase = phasePlay
	m.deadline = now + moveWindow
	hp := m.hp[len(m.hp)-1]
	tell("Turn", m.acceptor, caller, m, "Round "+strconv.Itoa(round)+" is over: you "+strconv.Itoa(hp[1])+
		" HP, them "+strconv.Itoa(hp[0])+". Your move within 24 hours.")
}

// Play records the acceptor's plan for the round being played.
func Play(cur realm, id, plan string) {
	m := find(id)
	now := time.Now().Unix()
	caller := cur.Previous().Address()
	m.checkMove(caller, phasePlay, m.acceptor, now)
	if !legal(m.state, engine.SideB, m.deckBits[1], planOf(plan)) {
		panic("illegal plan")
	}
	m.plans[len(m.plans)-1][1] = plan
	m.phase = phaseReveal
	m.deadline = now + moveWindow
	tell("Turn", m.challenger, caller, m, m.clans[1]+" played round "+strconv.Itoa(m.state.Round)+". Your move within 24 hours.")
}

// Resign withdraws the caller's open challenge, or concedes a running match.
func Resign(cur realm, id string) {
	m := find(id)
	caller := cur.Previous().Address()
	switch m.phase {
	case phaseOpen:
		if m.expired(time.Now().Unix()) {
			panic("challenge expired")
		}
		if caller != m.challenger {
			panic("not your challenge")
		}
		m.phase = phaseWithdrawn
	case phaseReveal, phasePlay:
		switch caller {
		case m.challenger:
			m.end("b", "resign")
		case m.acceptor:
			m.end("a", "resign")
		default:
			panic("not a player")
		}
		tellEnded(m, caller)
	default:
		panic("wrong phase")
	}
}

// ClaimForfeit ends a running match whose deadline has passed: the player who had to
// move loses. Anyone may claim it.
func ClaimForfeit(cur realm, id string) {
	m := find(id)
	var result string
	switch m.phase {
	case phaseReveal:
		result = "b"
	case phasePlay:
		result = "a"
	default:
		panic("wrong phase")
	}
	if time.Now().Unix() <= m.deadline {
		panic("deadline not passed")
	}
	m.end(result, "forfeit")
	tellEnded(m, cur.Previous().Address())
}

func find(id string) *match {
	m, ok := lookup(id)
	if !ok {
		panic("unknown match")
	}
	return m
}

func lookup(id string) (*match, bool) {
	if len(id) == 0 || len(id) > keyDigits {
		return nil, false
	}
	v := matches.Get(key(id))
	if v == nil || v.(*match).id != id {
		return nil, false
	}
	return v.(*match), true
}

func (m *match) checkMove(caller address, phase string, mover address, now int64) {
	if m.phase != phase {
		panic("wrong phase")
	}
	if caller != mover {
		panic("not your move")
	}
	if now > m.deadline {
		panic("deadline passed")
	}
}

func (m *match) end(result, reason string) {
	m.phase = phaseEnded
	m.result = result
	m.reason = reason
}

// checkSeal panics unless seal is the sha256 of salt's bytes followed by text.
func checkSeal(seal, salt, text string) {
	if !validSeal(salt) {
		panic("invalid salt")
	}
	b, _ := hex.DecodeString(salt)
	sum := sha256.Sum256(append(b, text...))
	if hex.EncodeToString(sum[:]) != seal {
		panic("seal mismatch")
	}
}

// planOf maps comma-separated card names to the engine's ids.
func planOf(text string) engine.Plan {
	p, ok := rules.PlanOf(strings.Split(text, ",")...)
	if !ok {
		panic("unknown card")
	}
	return p
}

// deckBits returns deck as the engine's bit set, panicking unless it is legal for c. A
// card named twice is illegal, so a legal deck text holds exactly the deck's names.
func deckBits(c engine.Clan, deck string) uint64 {
	var bits uint64
	for _, id := range planOf(deck) {
		bit := uint64(1) << uint(id)
		if bits&bit != 0 {
			panic("illegal deck")
		}
		bits |= bit
	}
	if !rules.LegalDeck(c, bits) {
		panic("illegal deck")
	}
	return bits
}

func legal(s engine.State, side engine.Side, deck uint64, p engine.Plan) bool {
	for _, q := range rules.LegalPlans(s, side, deck) {
		if samePlan(p, q) {
			return true
		}
	}
	return false
}

func samePlan(p, q engine.Plan) bool {
	if len(p) != len(q) {
		return false
	}
	for i := range p {
		if p[i] != q[i] {
			return false
		}
	}
	return true
}

func resultName(r engine.Result) string {
	switch r {
	case engine.AWins:
		return "a"
	case engine.BWins:
		return "b"
	case engine.Draw:
		return "draw"
	}
	return ""
}

// reasonOf says why a finished match ended: a gnome at 0 HP or less is a knockout.
func reasonOf(s engine.State) string {
	if s.Gnomes[0].HP <= 0 || s.Gnomes[1].HP <= 0 {
		return "knockout"
	}
	return "hp"
}
