// Package arena holds Gnomehall's online matches. A challenger posts a sealed deck and
// round-1 plan; an acceptor answers face up; the challenger reveals each round with the
// seal of the next, and the shared duel engine checks and resolves every move.
package arena

import (
	"strconv"
	"strings"
	"time"

	"gno.land/p/gfanton/gnomehall/engine"
	"gno.land/p/nt/avl/v0"
)

const (
	moveWindow = 24 * 60 * 60     // seconds a player has for each move
	openWindow = 7 * 24 * 60 * 60 // seconds an open challenge stays on the board
	maxBox     = 1024             // bytes
	maxPage    = 50
	keyDigits  = 10
)

const (
	phaseOpen      = "open"
	phaseReveal    = "reveal"
	phasePlay      = "play"
	phaseEnded     = "ended"
	phaseWithdrawn = "withdrawn"
	phaseExpired   = "expired" // reported for an open match past its expiry, never stored
)

var (
	rules    = engine.ProofOfConcept()
	matches  avl.Tree // key → *match
	byPlayer avl.Tree // address + "/" + key → *match, one entry per player of a match
	lastID   int
)

// match is one challenge and, once accepted, the duel it became. Side 0 is the
// challenger, side 1 the acceptor.
type match struct {
	id         string
	challenger address
	acceptor   address
	opponent   address // the only address that may accept; empty for anyone
	clans      [2]string
	deckSeal   string
	decks      [2]string // card names, once public
	deckBits   [2]uint64
	plans      [][2]string // per round started; "" while sealed or not made
	seal       string      // the challenger's sealed plan for the round being played
	box        string      // the encrypted plan behind seal
	state      engine.State
	hp         [][2]int // after each resolved round
	phase      string
	posted     int64
	deadline   int64
	result     string
	reason     string
}

// OpenChallenge is an open challenge as the board lists it.
type OpenChallenge struct {
	ID, Challenger, Clan, Opponent string
	Posted, Expires                int64
}

// Challenge posts a challenge for clan with the seals of the challenger's deck and
// round-1 plan, the box holding both, and an opponent who alone may accept, or none.
// It returns the new match's id.
func Challenge(cur realm, clan, deckSeal, planSeal, box string, opponent address) string {
	if _, ok := rules.ClanByName(clan); !ok {
		panic("unknown clan")
	}
	if !validSeal(deckSeal) || !validSeal(planSeal) {
		panic("invalid seal")
	}
	if len(box) == 0 || len(box) > maxBox {
		panic("invalid box")
	}
	if opponent != "" && !canonical(opponent) {
		panic("invalid opponent")
	}
	lastID++
	m := &match{
		id:         strconv.Itoa(lastID),
		challenger: cur.Previous().Address(),
		opponent:   opponent,
		deckSeal:   deckSeal,
		seal:       planSeal,
		box:        box,
		state:      rules.Start(),
		phase:      phaseOpen,
		posted:     time.Now().Unix(),
	}
	m.clans[0] = clan
	k := key(m.id)
	matches.Set(k, m)
	index(m.challenger, k, m)
	return m.id
}

// Open lists open, unexpired challenges, newest first: limit of them after skipping
// offset. limit is 1 to 50.
func Open(offset, limit int) []OpenChallenge {
	checkPage(offset, limit)
	now := time.Now().Unix()
	// ceiling: the walk visits every match posted in the last 7 days; keep an index of open
	// challenges, at about 1.2 KB of storage each, if that grows past a few hundred
	list := []OpenChallenge{}
	matches.ReverseIterate("", "", func(_ string, v any) bool {
		m := v.(*match)
		if now > m.posted+openWindow {
			return true // ids rise with time, so every older match is past it too
		}
		if m.phase != phaseOpen {
			return false
		}
		if offset > 0 {
			offset--
			return false
		}
		list = append(list, OpenChallenge{
			ID:         m.id,
			Challenger: m.challenger.String(),
			Clan:       m.clans[0],
			Opponent:   m.opponent.String(),
			Posted:     m.posted,
			Expires:    m.posted + openWindow,
		})
		return len(list) == limit
	})
	return list
}

func (m *match) expired(now int64) bool {
	return m.phase == phaseOpen && now > m.posted+openWindow
}

func checkPage(offset, limit int) {
	if offset < 0 {
		panic("offset must not be negative")
	}
	if limit < 1 || limit > maxPage {
		panic("limit must be 1 to 50")
	}
}

// key pads a match id with zeros so that tree order is id order.
func key(id string) string {
	return strings.Repeat("0", keyDigits-len(id)) + id
}

// index lists the match under player's matches. One tree for every player stores
// less than a tree per player, which costs about 3 KB to create.
func index(player address, k string, m *match) {
	byPlayer.Set(player.String()+"/"+k, m)
}

// canonical accepts a valid address in the lowercase form callers carry. bech32 also
// allows uppercase, which would never equal a caller's address.
func canonical(a address) bool {
	return a.IsValid() && string(a) == strings.ToLower(string(a))
}

// validSeal accepts a sha256 sum in lowercase hex.
func validSeal(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
