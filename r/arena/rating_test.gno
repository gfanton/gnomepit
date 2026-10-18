package arena

import (
	"math"
	"testing"

	"gno.land/p/nt/uassert/v0"
)

func TestExpectedTableMatchesFormula(t *testing.T) {
	for i, e := range expectedTable {
		d := float64(i * 25)
		uassert.Equal(t, int(math.Round(1000/(1+math.Pow(10, d/400)))), e)
	}
}

func TestExpected(t *testing.T) {
	uassert.Equal(t, 500, expected(1000, 1000))
	uassert.Equal(t, 500, expected(1000, 1012), "a gap of 12 rounds to 0")
	uassert.Equal(t, 464, expected(1000, 1013), "a gap of 13 rounds to 25")
	uassert.Equal(t, 360, expected(1000, 1100))
	uassert.Equal(t, 640, expected(1100, 1000))
	uassert.Equal(t, 91, expected(1000, 1500), "the gap is capped at 400")
	uassert.Equal(t, 909, expected(1500, 1000))
}

func TestEloChange(t *testing.T) {
	uassert.Equal(t, 16, eloChange(1000, 1000, 1000, playerK))
	uassert.Equal(t, 0, eloChange(1000, 1000, 500, playerK))
	uassert.Equal(t, 20, eloChange(1000, 1100, 1000, playerK))
	uassert.Equal(t, -12, eloChange(1000, 1100, 0, playerK))
	uassert.Equal(t, 4, eloChange(1000, 1100, 500, playerK))
	uassert.Equal(t, 12, eloChange(1100, 1000, 1000, playerK))
	uassert.Equal(t, -20, eloChange(1100, 1000, 0, playerK))
	uassert.Equal(t, 29, eloChange(1000, 1500, 1000, playerK))
	uassert.Equal(t, 8, eloChange(1000, 1000, 1000, clanK))
}

func TestApplyChangeClamps(t *testing.T) {
	a, b := applyChange(1000, 1000, 16)
	uassert.Equal(t, 1016, a)
	uassert.Equal(t, 984, b)
	a, b = applyChange(5, 5, -16)
	uassert.Equal(t, 0, a, "no rating goes below 0")
	uassert.Equal(t, 21, b)
	a, b = applyChange(65530, 900, 29)
	uassert.Equal(t, maxRating, a, "no rating goes above what the ladder key holds")
	uassert.Equal(t, 871, b)
}
