package arena

const (
	startRating = 1000
	maxRating   = 0xFFFF // a ladder key holds the rating in 2 bytes
	playerK     = 32
	clanK       = 16
)

// expectedTable is the expected score, in thousandths, of a side whose opponent is rated
// 0, 25, …, 400 points above it: 1 / (1 + 10^(d / 400)), rounded.
var expectedTable = [17]int{500, 464, 429, 394, 360, 327, 297, 267, 240, 215, 192, 170, 151, 133, 118, 104, 91}

// expected is the expected score, in thousandths, of a side rated a against one rated b.
// The gap is capped at 400 points and rounded to the nearest 25.
func expected(a, b int) int {
	d := b - a
	if d < 0 {
		return 1000 - expected(b, a)
	}
	if d > 400 {
		d = 400
	}
	return expectedTable[(d+12)/25]
}

// eloChange is the change, rounded to the nearest point, of a side rated a that scored
// score thousandths (1000 a win, 500 a draw, 0 a loss) against one rated b.
func eloChange(a, b, score, k int) int {
	x := k * (score - expected(a, b))
	if x < 0 {
		return -((-x + 500) / 1000)
	}
	return (x + 500) / 1000
}

// applyChange gives a the change delta and b its negative, each kept within 0 to maxRating.
func applyChange(a, b, delta int) (int, int) {
	return clampRating(a + delta), clampRating(b - delta)
}

func clampRating(r int) int {
	if r < 0 {
		return 0
	}
	if r > maxRating {
		return maxRating
	}
	return r
}
