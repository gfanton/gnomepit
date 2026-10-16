package arena

import (
	"chain/runtime"
	"strconv"
	"time"
)

// guard binds the session that signed the transaction to match id, held in m. fromUser
// says the call came straight from a user: a session belongs to the whole transaction,
// so a call through another realm is left unchecked.
func guard(fromUser bool, caller address, m record, id int, opening bool) {
	if !fromUser {
		return
	}
	session, expires, _, ok := runtime.GetSessionInfo()
	if !ok {
		return
	}
	if caller != m.challenger && caller != m.acceptor {
		panic("not a player")
	}
	p := loadPlayer(caller)
	locks, refusal := lockSession(p.locks, session, expires, id, opening, time.Now().Unix())
	if refusal != "" {
		panic(refusal)
	}
	p.locks = locks
	savePlayer(caller, p)
}

// lockSession binds session to match id in locks, or refuses when session is bound to
// another match, or to any when opening. Expiries are Unix seconds, 0 for none; a lock
// for session under another expiry belongs to an earlier session with the same key.
func lockSession(locks []sessionLock, session address, expires int64, id int, opening bool, now int64) ([]sessionLock, string) {
	var kept []sessionLock
	for _, l := range locks {
		expired := l.expires != 0 && l.expires <= now
		stale := l.session == session && l.expires != expires
		if !expired && !stale {
			kept = append(kept, l)
		}
	}
	for _, l := range kept {
		if l.session != session {
			continue
		}
		if opening || l.id != id {
			return kept, "session locked to match " + strconv.Itoa(l.id)
		}
		return kept, ""
	}
	return append(kept, sessionLock{session: session, id: id, expires: expires}), ""
}
