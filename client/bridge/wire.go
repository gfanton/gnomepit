package bridge

// The wire types are what the page sends and receives, as JSON. Card ids index the
// ruleset's cards; every set of cards travels as an ascending id list.

type CardView struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Cost      int    `json:"cost"`
	Tier      string `json:"tier"` // Quick, Normal or Slow
	Special   bool   `json:"special"`
	Rare      bool   `json:"rare"`
	Interrupt bool   `json:"interrupt"`
	Parry     int    `json:"parry"`
	Text      string `json:"text"`
}

type ClanView struct {
	Name  string `json:"name"`
	Cards []int  `json:"cards"`
}

type RulesetView struct {
	HP    int        `json:"hp"`
	Cards []CardView `json:"cards"`
	Clans []ClanView `json:"clans"`
}

type GnomeView struct {
	HP         int   `json:"hp"`
	Vulnerable int   `json:"vulnerable"`
	Strength   int   `json:"strength"`
	Spent      []int `json:"spent"`
}

type StateView struct {
	Round  int          `json:"round"`
	Gnomes [2]GnomeView `json:"gnomes"`
}

type VitalsView struct {
	HP         int `json:"hp"`
	Block      int `json:"block"`
	Counter    int `json:"counter"`
	Vulnerable int `json:"vulnerable"`
	Strength   int `json:"strength"`
}

type EventView struct {
	Beat    int           `json:"beat"`
	Phase   string        `json:"phase"` // Interrupt, Block or Damage
	Tier    string        `json:"tier"`
	Step    int           `json:"step"`
	Kind    string        `json:"kind"` // the engine's EventKind constant name
	Side    int           `json:"side"`
	Card    int           `json:"card"`
	N       int           `json:"n"`
	Blocked int           `json:"blocked"`
	Doubled bool          `json:"doubled"`
	After   [2]VitalsView `json:"after"`
}

type LegalDeckRequest struct {
	Clan string `json:"clan"`
	Deck []int  `json:"deck"`
}

type LegalPlansRequest struct {
	State StateView `json:"state"`
	Side  int       `json:"side"`
	Deck  []int     `json:"deck"`
}

type ResolveRequest struct {
	State StateView `json:"state"`
	Decks [2][]int  `json:"decks"`
	A     []int     `json:"a"`
	B     []int     `json:"b"`
}

type ResolveResponse struct {
	State  StateView   `json:"state"`
	Result string      `json:"result"` // ongoing, a, b or draw
	Events []EventView `json:"events"`
}
