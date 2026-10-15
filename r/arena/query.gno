package arena

import "time"

// MatchSummary is one match as a player's list shows it. Round is the round being
// played, or the last one resolved once the match is over. ToMove is the address that
// must move next, empty when none. Deadline is the end of the current move's 24 hours,
// or the expiry of an open challenge, in Unix seconds.
type MatchSummary struct {
	ID, Phase                    string
	Round                        int
	Challenger, Acceptor         string
	ChallengerClan, AcceptorClan string
	ToMove                       string
	Deadline                     int64
	Result, Reason               string
}

// MatchView is everything one match screen needs. Plans holds [challenger, acceptor]
// per round started, "" while a plan is sealed or not yet made; HP holds both sides'
// HP after each resolved round; Box is the challenger's encrypted pending plan.
type MatchView struct {
	MatchSummary
	Opponent                     string
	ChallengerDeck, AcceptorDeck string
	Plans                        [][]string
	Box                          string
	HP                           [][]int
	DeadlinePassed               bool
}

// Matches lists player's matches, newest first: limit of them after skipping offset.
func Matches(player address, offset, limit int) []MatchSummary {
	checkPage(offset, limit)
	list := []MatchSummary{}
	now := time.Now().Unix()
	prefix := player.String() + "/"
	// "0" follows "/", so the range holds exactly this player's keys.
	byPlayer.ReverseIterate(prefix, player.String()+"0", func(_ string, v any) bool {
		if offset > 0 {
			offset--
			return false
		}
		list = append(list, v.(*match).summary(now))
		return len(list) == limit
	})
	return list
}

// Match returns the view of match id.
func Match(id string) MatchView {
	m := find(id)
	now := time.Now().Unix()
	v := MatchView{
		MatchSummary:   m.summary(now),
		Opponent:       m.opponent.String(),
		ChallengerDeck: m.decks[0],
		AcceptorDeck:   m.decks[1],
		Plans:          [][]string{},
		Box:            m.box,
		HP:             [][]int{},
		DeadlinePassed: m.running() && now > m.deadline,
	}
	for _, p := range m.plans {
		v.Plans = append(v.Plans, []string{p[0], p[1]})
	}
	for _, hp := range m.hp {
		v.HP = append(v.HP, []int{hp[0], hp[1]})
	}
	return v
}

// summary copies the match out of storage, so a query returns no stored object.
func (m *match) summary(now int64) MatchSummary {
	s := MatchSummary{
		ID:             m.id,
		Phase:          m.phase,
		Round:          m.state.Round,
		Challenger:     m.challenger.String(),
		Acceptor:       m.acceptor.String(),
		ChallengerClan: m.clans[0],
		AcceptorClan:   m.clans[1],
		Result:         m.result,
		Reason:         m.reason,
	}
	switch m.phase {
	case phaseOpen:
		s.Deadline = m.posted + openWindow
		if m.expired(now) {
			s.Phase = phaseExpired
		}
	case phaseReveal:
		s.ToMove = s.Challenger
		s.Deadline = m.deadline
	case phasePlay:
		s.ToMove = s.Acceptor
		s.Deadline = m.deadline
	case phaseEnded:
		if len(m.hp) > 0 {
			s.Round = len(m.hp)
		}
	}
	return s
}

func (m *match) running() bool {
	return m.phase == phaseReveal || m.phase == phasePlay
}
