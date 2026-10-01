// Package cardtext prints a card's text from its effect data, in the duel spec's style.
package cardtext

import (
	"strconv"
	"strings"

	"gnomehall/p/engine"
)

// Text writes the card's printed text: keywords first, then one sentence per effect in
// printed order, with a run of identical hits folded into one sentence.
func Text(c engine.Card) string {
	var parts []string
	if c.Interrupt {
		parts = append(parts, "Interrupt.")
	}
	if c.Parry > 0 {
		parts = append(parts, "Parry "+strconv.Itoa(c.Parry)+".")
	}
	switch {
	case len(c.OnCancel) > 0:
		parts = append(parts, cancelForm(c.OnCancel, c.Damage))
	case len(c.CancelDamage) > 0:
		parts = append(parts, cancelForm(c.CancelDamage, c.Block))
	default:
		parts = append(parts, sentences(c.Block)...)
		parts = append(parts, sentences(c.Damage)...)
	}
	return strings.Join(parts, " ")
}

func cancelForm(ifCancelled, otherwise []engine.Effect) string {
	return "If this card is cancelled, " + lowerFirst(strings.Join(sentences(ifCancelled), " ")) +
		" Otherwise, " + lowerFirst(strings.Join(sentences(otherwise), " "))
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// sentences writes one sentence per effect, folding consecutive identical hits.
func sentences(effects []engine.Effect) []string {
	var out []string
	for i := 0; i < len(effects); {
		e := effects[i]
		if e.Kind != engine.Hit {
			out = append(out, sentence(e))
			i++
			continue
		}
		times := 1
		for i+times < len(effects) && effects[i+times] == e {
			times++
		}
		out = append(out, hits(e.N, times))
		i += times
	}
	return out
}

func hits(damage, times int) string {
	s := "Deal " + strconv.Itoa(damage) + " damage"
	switch times {
	case 1:
	case 2:
		s += " twice"
	default:
		s += " " + strconv.Itoa(times) + " times"
	}
	return s + "."
}

func sentence(e engine.Effect) string {
	n := strconv.Itoa(e.N)
	switch e.Kind {
	case engine.Hit:
		return hits(e.N, 1)
	case engine.GainBlock:
		return "Gain " + n + " Block."
	case engine.GainCounter:
		return "Counter " + n + "."
	case engine.HitBlock:
		return "Deal damage equal to your Block."
	case engine.ApplyVulnerable:
		return "Apply " + n + " Vulnerable."
	case engine.GainStrength:
		return "Gain " + n + " Strength."
	case engine.VulnerableIfCancelled:
		return "If this cancels a card, apply " + n + " Vulnerable."
	}
	panic("cardtext: unknown effect kind " + strconv.Itoa(int(e.Kind)))
}
