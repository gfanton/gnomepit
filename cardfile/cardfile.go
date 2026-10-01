// Package cardfile loads a ruleset from the JSON card file the balance runs write.
package cardfile

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	"gnomehall/engine"
)

// file is the card file's shape: every card with its engine fields, each clan's pool by
// card name, and the rule switches. Rare and HP are optional.
type file struct {
	Cards []struct {
		Name                                  string
		Cost                                  int
		Tier                                  string
		Special, Rare, Interrupt              bool
		Parry                                 int
		Block, Damage, OnCancel, CancelDamage [][2]any
	}
	Clans map[string][]string
	Rules struct {
		HP                                                                      int
		VulnerableDoublesOneHit, StrengthLastsTheRound, VulnerableLastsTheRound bool
	}
}

var effectKinds = map[string]engine.EffectKind{
	"GainBlock": engine.GainBlock, "GainCounter": engine.GainCounter, "Hit": engine.Hit,
	"HitBlock": engine.HitBlock, "ApplyVulnerable": engine.ApplyVulnerable,
	"GainStrength": engine.GainStrength, "VulnerableIfCancelled": engine.VulnerableIfCancelled,
}

var tiers = map[string]engine.Tier{"Quick": engine.Quick, "Normal": engine.Normal, "Slow": engine.Slow}

const (
	maxCards = 64 // the engine keys card sets by bits of a uint64
	maxCost  = 3  // a card occupies 1 to 3 beats, a whole round at most
)

// Load parses a card file into a ruleset. Starting HP is Rules.HP when set; otherwise
// it and the caps are the proof of concept's. Clans come out sorted by name.
func Load(data []byte) (*engine.Ruleset, error) {
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse card file: %w", err)
	}
	if len(f.Cards) > maxCards {
		return nil, fmt.Errorf("%d cards, at most %d", len(f.Cards), maxCards)
	}
	rs := engine.ProofOfConcept()
	rs.Cards, rs.Clans = nil, nil
	if f.Rules.HP > 0 {
		rs.HP = f.Rules.HP
	}
	rs.VulnerableDoublesOneHit = f.Rules.VulnerableDoublesOneHit
	rs.StrengthLastsTheRound = f.Rules.StrengthLastsTheRound
	rs.VulnerableLastsTheRound = f.Rules.VulnerableLastsTheRound
	for _, c := range f.Cards {
		tier, ok := tiers[c.Tier]
		if !ok {
			return nil, fmt.Errorf("card %s: tier %q", c.Name, c.Tier)
		}
		if c.Cost < 1 || c.Cost > maxCost {
			return nil, fmt.Errorf("card %s: cost %d, want 1 to %d", c.Name, c.Cost, maxCost)
		}
		card := engine.Card{Name: c.Name, Cost: c.Cost, Tier: tier, Special: c.Special, Rare: c.Rare, Interrupt: c.Interrupt, Parry: c.Parry}
		parts := []struct {
			raw [][2]any
			dst *[]engine.Effect
		}{{c.Block, &card.Block}, {c.Damage, &card.Damage}, {c.OnCancel, &card.OnCancel}, {c.CancelDamage, &card.CancelDamage}}
		for _, part := range parts {
			var err error
			if *part.dst, err = effects(part.raw); err != nil {
				return nil, fmt.Errorf("card %s: %w", c.Name, err)
			}
		}
		rs.Cards = append(rs.Cards, card)
	}
	for _, name := range slices.Sorted(maps.Keys(f.Clans)) {
		var pool uint64
		for _, cardName := range f.Clans[name] {
			id, ok := rs.CardByName(cardName)
			if !ok {
				return nil, fmt.Errorf("clan %s: no card %q", name, cardName)
			}
			pool |= uint64(1) << uint(id)
		}
		rs.Clans = append(rs.Clans, engine.Clan{Name: name, Pool: pool})
	}
	return rs, nil
}

func effects(raw [][2]any) ([]engine.Effect, error) {
	var out []engine.Effect
	for _, e := range raw {
		name, _ := e[0].(string)
		kind, ok := effectKinds[name]
		n, isNum := e[1].(float64)
		if !ok || !isNum {
			return nil, fmt.Errorf("effect %v", e)
		}
		out = append(out, engine.Effect{Kind: kind, N: int(n)})
	}
	return out, nil
}
