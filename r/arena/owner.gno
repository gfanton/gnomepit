package arena

import "gno.land/p/nt/ownable/v0"

var (
	owner   *ownable.Ownable
	retired bool
)

func init(cur realm) {
	owner = ownable.NewWithAddress(cur.Previous().Address())
}

// Retire closes the arena to new challenges and acceptances, for good. Matches already
// running play out and are rated, and an open challenge can still be withdrawn. Owner
// only.
func Retire(cur realm) {
	owner.AssertOwnedBy(cur.Previous().Address())
	retired = true
}

// TransferOwnership makes newOwner the owner. Owner only.
func TransferOwnership(cur realm, newOwner address) {
	if err := owner.TransferOwnership(0, cur, newOwner); err != nil {
		panic(err.Error())
	}
}

// Retired reports whether the owner has retired the arena.
func Retired() bool {
	return retired
}

// Owner is the address that may retire the arena.
func Owner() address {
	return owner.Owner()
}

// mustBeOpen refuses a new match on an arena that is closed.
func mustBeOpen() {
	if retired {
		panic("arena retired")
	}
}
