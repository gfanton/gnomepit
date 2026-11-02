package arena

import (
	"gno.land/p/gfanton/gnomepit/engine/v0"
	"gno.land/r/gfanton/gnomepit/standings/v0"
)

// report sends match m, which has just ended, to the standings realm, which rates it. A
// match its challenger accepted is not reported, and neither is any match while the arena
// is off the writer list, so no ending ever depends on the standings realm.
func report(cur realm, rules *engine.Ruleset, m record) {
	if m.challenger == m.acceptor || !standings.IsWriter(self) {
		return
	}
	standings.Record(cross(cur), m.challenger, m.acceptor, clanName(rules, m.clans[0]), clanName(rules, m.clans[1]), m.result)
}
