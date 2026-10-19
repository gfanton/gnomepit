package arena

import (
	"strconv"
	"testing"

	"gno.land/p/gfanton/gnomepit/engine"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
	"gno.land/p/nt/urequire/v0"
	"gno.land/r/sys/users"
)

var dave = testutils.TestAddress("dave")

// giveName registers name for a in r/sys/users, as the users realm's genesis controller
// does; the registry outlives reset, so a name given once stays.
func giveName(cur realm, a address, name string) {
	if !users.ResolveAddress(a).IsDeleted() {
		return
	}
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/sys/users/init"))
	if err := users.RegisterUser(cross(cur), name, a); err != nil {
		panic(err.Error())
	}
}

func ranks(list []Standing) string {
	out := ""
	for _, s := range list {
		out += strconv.Itoa(s.Rank) + " "
	}
	return out
}

func TestStandingOfUnrated(t *testing.T) {
	reset()
	s := StandingOf(carol)
	uassert.Equal(t, 0, s.Rank)
	uassert.Equal(t, carol.String(), s.Player)
	uassert.Equal(t, "", s.Name)
	uassert.Equal(t, "", s.MainClan)
	uassert.Equal(t, 1000, s.Rating)
	uassert.Equal(t, 0, s.Wins+s.Losses+s.Draws)
}

func TestStandingOfNamed(cur realm, t *testing.T) {
	reset()
	giveName(cur, alice, "alice")
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "a", "hp"))
	s := StandingOf(alice)
	uassert.Equal(t, "alice", s.Name)
	uassert.Equal(t, 1, s.Rank)
	uassert.Equal(t, "Pickers", s.MainClan)
	uassert.Equal(t, 1016, s.Rating)
	uassert.Equal(t, 1, s.Wins)
	uassert.Equal(t, "", StandingOf(bob).Name, "an address without a name has none")
	uassert.Equal(t, 2, StandingOf(bob).Rank)
}

func TestLeaderboardSharedRankAcrossPages(t *testing.T) {
	reset()
	seed(alice, 1016)
	seed(bob, 1016)
	seed(carol, 1016)
	seed(dave, 952)
	uassert.Equal(t, "1 1 ", ranks(Leaderboard(0, 2)))
	uassert.Equal(t, "1 4 ", ranks(Leaderboard(2, 2)), "a page that opens inside a tie keeps its shared rank")
	uassert.Equal(t, "1 1 1 4 ", ranks(Leaderboard(0, 50)))
}

func TestLeaderboardLimits(t *testing.T) {
	reset()
	uassert.PanicsWithMessage(t, nil, "limit must be 1 to 50", func() { Leaderboard(0, 0) })
	uassert.PanicsWithMessage(t, nil, "limit must be 1 to 50", func() { Leaderboard(0, 51) })
	uassert.PanicsWithMessage(t, nil, "offset must not be negative", func() { Leaderboard(-1, 10) })
	list := Leaderboard(0, 50)
	uassert.True(t, list != nil)
	uassert.Equal(t, 0, len(list))
}

func TestLeaderboardFiftyNamed(cur realm, t *testing.T) {
	reset()
	for i := 0; i < 50; i++ {
		a := testutils.TestAddress("player" + strconv.Itoa(i))
		giveName(cur, a, "player"+strconv.Itoa(i))
		seed(a, 1000+i)
	}
	list := Leaderboard(0, 50)
	urequire.Equal(t, 50, len(list))
	for i, s := range list {
		uassert.Equal(t, 1049-i, s.Rating)
		uassert.Equal(t, i+1, s.Rank)
		uassert.Equal(t, "player"+strconv.Itoa(49-i), s.Name)
	}
}

func TestRatedPlayers(t *testing.T) {
	reset()
	uassert.Equal(t, 0, RatedPlayers())
	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "a", "hp"))
	uassert.Equal(t, 2, RatedPlayers())
}

func TestClanStandings(t *testing.T) {
	reset()
	list := ClanStandings()
	urequire.Equal(t, 3, len(list))
	for i, name := range []string{"Pickers", "Ironhide", "Delvers"} {
		uassert.Equal(t, name, list[i].Clan)
		uassert.Equal(t, 1, list[i].Rank)
		uassert.Equal(t, 1000, list[i].Rating)
	}

	rate(engine.ProofOfConcept(), ended(alice, bob, 1, 2, "a", "hp"))
	list = ClanStandings()
	urequire.Equal(t, 3, len(list))
	uassert.Equal(t, "Pickers", list[0].Clan)
	uassert.Equal(t, 1, list[0].Rank)
	uassert.Equal(t, 1008, list[0].Rating)
	uassert.Equal(t, 1, list[0].Wins)
	uassert.Equal(t, "Delvers", list[1].Clan)
	uassert.Equal(t, 2, list[1].Rank)
	uassert.Equal(t, "Ironhide", list[2].Clan)
	uassert.Equal(t, 3, list[2].Rank)
	uassert.Equal(t, 992, list[2].Rating)
	uassert.Equal(t, 1, list[2].Losses)
}
