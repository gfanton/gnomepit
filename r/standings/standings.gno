// Package standings keeps Gnomepit's ratings, records, ladder and clan ratings, whatever
// arena version played the match. Only realms on its owner's writer list report results.
package standings

import (
	"strings"

	"gno.land/p/nt/avl/v0"
	"gno.land/p/nt/ownable/v0"
)

const (
	maxWriters  = 255 // a writer number fills one byte of a result entry
	maxClanName = 32
)

var (
	owner       *ownable.Ownable
	writerPaths []string // every path ever a writer; its index plus one is its writer number
	writers     avl.Tree // current writer path → its writer number
)

func init(cur realm) {
	owner = ownable.NewWithAddress(cur.Previous().Address())
	addWriter("gno.land/r/gfanton/gnomepit/arena/v0")
}

// Record counts a match the calling arena reports as ended. result is "a" when the
// challenger won, "b" when the acceptor did, and "draw". It aborts unless the caller is a
// realm on the writer list.
func Record(cur realm, challenger, acceptor address, challengerClan, acceptorClan, result string) {
	caller := cur.Previous()
	if !caller.IsCode() || !IsWriter(caller.PkgPath()) {
		panic("not a writer")
	}
	if challenger == acceptor {
		panic("same player")
	}
	if result != "a" && result != "b" && result != "draw" {
		panic("unknown result")
	}
	if !validClan(challengerClan) || !validClan(acceptorClan) {
		panic("bad clan name")
	}
}

// AddWriter lets the realm at pkgpath, a versioned path under gno.land/r/, report results.
// A path that was a writer before gets its old writer number back. Owner only.
func AddWriter(cur realm, pkgpath string) {
	owner.AssertOwnedBy(cur.Previous().Address())
	if !isVersionedRealm(pkgpath) {
		panic("bad writer path")
	}
	if IsWriter(pkgpath) {
		panic("already a writer")
	}
	addWriter(pkgpath)
}

// RemoveWriter stops the realm at pkgpath from reporting results. Owner only.
func RemoveWriter(cur realm, pkgpath string) {
	owner.AssertOwnedBy(cur.Previous().Address())
	if _, removed := writers.Remove(pkgpath); !removed {
		panic("not a writer")
	}
}

// TransferOwnership makes newOwner the owner. Owner only.
func TransferOwnership(cur realm, newOwner address) {
	if err := owner.TransferOwnership(0, cur, newOwner); err != nil {
		panic(err.Error())
	}
}

// IsWriter reports whether the realm at pkgpath may report results.
func IsWriter(pkgpath string) bool {
	return writers.Has(pkgpath)
}

// Writers lists the realms that may report results, in writer-number order.
func Writers() []string {
	var list []string
	for _, p := range writerPaths {
		if writers.Has(p) {
			list = append(list, p)
		}
	}
	return list
}

// Owner is the address that manages the writer list.
func Owner() address {
	return owner.Owner()
}

func addWriter(pkgpath string) {
	n := 0
	for i, p := range writerPaths {
		if p == pkgpath {
			n = i + 1
			break
		}
	}
	if n == 0 {
		if len(writerPaths) == maxWriters {
			panic("too many writers")
		}
		writerPaths = append(writerPaths, pkgpath)
		n = len(writerPaths)
	}
	writers.Set(pkgpath, n)
}

// isVersionedRealm reports whether pkgpath is under gno.land/r/ and ends in a version
// element: "v" and one or more digits.
func isVersionedRealm(pkgpath string) bool {
	if !strings.HasPrefix(pkgpath, "gno.land/r/") {
		return false
	}
	v := pkgpath[strings.LastIndex(pkgpath, "/")+1:]
	if len(v) < 2 || v[0] != 'v' {
		return false
	}
	for _, c := range v[1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func validClan(name string) bool {
	return len(name) >= 1 && len(name) <= maxClanName
}
