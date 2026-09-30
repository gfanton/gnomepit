package engine

// Result is how a round left the match.
type Result int

const (
	Ongoing Result = iota
	AWins
	BWins
	Draw
)

// Outcome is the state after a round, and the match result once it has one.
type Outcome struct {
	State  State
	Result Result
}

const (
	lastRound   = 3
	maxPlanSize = beatsPerRound
)

// slot is the card of one plan occupying one beat.
type slot struct {
	index  int  // position of the card in the plan
	lands  bool // the card's last beat, where its effects resolve
	active bool // lands, or a Parry card, which acts on every beat it occupies
}

func (rs *Ruleset) slotsOf(p Plan) [beatsPerRound]slot {
	var out [beatsPerRound]slot
	beat := 0
	for i, id := range p {
		c := &rs.Cards[id]
		for k := 0; k < c.Cost; k++ {
			lands := k == c.Cost-1
			out[beat] = slot{index: i, lands: lands, active: lands || c.Parry > 0}
			beat++
		}
	}
	return out
}

// fighter is one gnome during a round.
type fighter struct {
	hp, block, counter, vulnerable, strength int
}

func (f *fighter) take(damage int) {
	absorbed := damage
	if f.block < absorbed {
		absorbed = f.block
	}
	f.block -= absorbed
	f.hp -= damage - absorbed
}

func (f *fighter) gainAll(rs *Ruleset, effects []Effect) {
	for _, e := range effects {
		switch e.Kind {
		case GainBlock:
			f.block = capped(f.block+e.N, rs.BlockCap)
		case GainCounter:
			f.counter = capped(f.counter+e.N, rs.CounterCap)
		}
	}
}

func capped(v, limit int) int {
	if v > limit {
		return limit
	}
	return v
}

// Resolve plays round s.Round. Both plans must be legal for their side in s
// (LegalPlans); an illegal plan is a caller error.
func (rs *Ruleset) Resolve(s State, a, b Plan) Outcome {
	plans := [2]Plan{a, b}
	next := s
	next.Round = s.Round + 1
	var f [2]fighter
	var slots [2][beatsPerRound]slot
	var gone [2][maxPlanSize]bool   // cancelled, or a Parry that used up its cancels
	var parried [2][maxPlanSize]int // cancels made by each Parry card this round
	for side := 0; side < 2; side++ {
		g := s.Gnomes[side]
		f[side] = fighter{hp: g.HP, vulnerable: g.Vulnerable, strength: g.Strength}
		slots[side] = rs.slotsOf(plans[side])
		for _, id := range plans[side] {
			if rs.Cards[id].Special {
				next.Gnomes[side].Spent |= uint64(1) << uint(id)
			}
		}
	}

	for beat := 0; beat < beatsPerRound; beat++ {
		var cur [2]*Card // nil once cancelled or ended
		var sl [2]slot
		for side := 0; side < 2; side++ {
			sl[side] = slots[side][beat]
			if !gone[side][sl[side].index] {
				cur[side] = &rs.Cards[plans[side][sl[side].index]]
			}
		}

		// Interrupt phase
		var cancelledNow [2]*Card
		var didCancel [2]bool
		for tier := Quick; tier <= Slow; tier++ {
			var hit, parryDone [2]bool
			for side := 0; side < 2; side++ {
				o := 1 - side
				me, op := cur[side], cur[o]
				if me == nil || op == nil || me.Tier != tier {
					continue
				}
				switch {
				case me.Interrupt && sl[side].lands && !sl[o].active:
					hit[o], didCancel[side] = true, true
				case me.Parry > 0 && sl[side].active && sl[o].lands && op.Attack():
					hit[o], didCancel[side] = true, true
					parried[side][sl[side].index]++
					parryDone[side] = parried[side][sl[side].index] >= me.Parry
				}
			}
			for side := 0; side < 2; side++ {
				if hit[side] {
					cancelledNow[side] = cur[side]
					gone[side][sl[side].index] = true
					cur[side] = nil
				}
				if parryDone[side] && cur[side] != nil {
					// Its later beats stay empty; this beat's effects still resolve.
					gone[side][sl[side].index] = true
				}
			}
		}

		// Block phase
		for side := 0; side < 2; side++ {
			if cur[side] != nil && sl[side].lands {
				f[side].gainAll(rs, cur[side].Block)
			}
			if cancelledNow[side] != nil {
				f[side].gainAll(rs, cancelledNow[side].OnCancel)
			}
		}

		// Damage phase
		for tier := Quick; tier <= Slow; tier++ {
			var effects [2][]Effect
			for side := 0; side < 2; side++ {
				switch c := cancelledNow[side]; {
				case cur[side] != nil && sl[side].lands && cur[side].Tier == tier:
					effects[side] = cur[side].Damage
				case c != nil && c.Tier == tier:
					effects[side] = c.CancelDamage
				}
			}
			if result := rs.resolveDamageTier(&f, effects, didCancel); result != Ongoing {
				return Outcome{State: rs.settle(next, f), Result: result}
			}
		}
	}

	next = rs.settle(next, f)
	if s.Round < lastRound {
		return Outcome{State: next, Result: Ongoing}
	}
	return Outcome{State: next, Result: byHP(next.Gnomes[SideA].HP, next.Gnomes[SideB].HP)}
}

// settle copies the round's carried values into the next state.
func (rs *Ruleset) settle(next State, f [2]fighter) State {
	for side := 0; side < 2; side++ {
		next.Gnomes[side].HP = f[side].hp
		next.Gnomes[side].Vulnerable = f[side].vulnerable
		next.Gnomes[side].Strength = f[side].strength
		if rs.StrengthLastsTheRound {
			next.Gnomes[side].Strength = 0
		}
		if rs.VulnerableLastsTheRound {
			next.Gnomes[side].Vulnerable = 0
		}
	}
	return next
}

func byHP(a, b int) Result {
	switch {
	case a > b:
		return AWins
	case b > a:
		return BWins
	}
	return Draw
}

// resolveDamageTier resolves both gnomes' effects of one tier in steps: step k applies
// effect k of each card together, every value read at the start of the step. It
// returns the knockout result as soon as a step leaves a gnome at 0 HP or less.
func (rs *Ruleset) resolveDamageTier(f *[2]fighter, effects [2][]Effect, didCancel [2]bool) Result {
	var hitsTotal, hitsDone [2]int
	var doubled, doubleDecided [2]bool
	for side := 0; side < 2; side++ {
		for _, e := range effects[side] {
			if e.Kind == Hit || e.Kind == HitBlock {
				hitsTotal[side]++
			}
		}
	}
	steps := len(effects[0])
	if len(effects[1]) > steps {
		steps = len(effects[1])
	}

	for k := 0; k < steps; k++ {
		var incoming, addVulnerable, addStrength, usedVulnerable [2]int
		for side := 0; side < 2; side++ {
			if k >= len(effects[side]) {
				continue
			}
			o := 1 - side
			e := effects[side][k]
			switch e.Kind {
			case Hit, HitBlock:
				if rs.VulnerableDoublesOneHit {
					doubled[side] = f[o].vulnerable > 0
				} else if !doubleDecided[side] {
					doubled[side], doubleDecided[side] = f[o].vulnerable > 0, true
				}
				amount := e.N
				if e.Kind == HitBlock {
					amount = f[side].block
				}
				amount += f[side].strength
				if doubled[side] {
					amount *= 2
				}
				incoming[o] += amount
				incoming[side] += f[o].counter
				hitsDone[side]++
				if doubled[side] && (rs.VulnerableDoublesOneHit || hitsDone[side] == hitsTotal[side]) {
					usedVulnerable[o]++
				}
			case ApplyVulnerable:
				addVulnerable[o] += e.N
			case GainStrength:
				addStrength[side] += e.N
			case VulnerableIfCancelled:
				if didCancel[side] {
					addVulnerable[o] += e.N
				}
			}
		}
		for side := 0; side < 2; side++ {
			f[side].take(incoming[side])
			v := f[side].vulnerable - usedVulnerable[side]
			if v < 0 {
				v = 0
			}
			f[side].vulnerable = capped(v+addVulnerable[side], rs.VulnerableCap)
			f[side].strength = capped(f[side].strength+addStrength[side], rs.StrengthCap)
		}
		outA, outB := f[SideA].hp <= 0, f[SideB].hp <= 0
		switch {
		case outA && outB:
			return Draw
		case outB:
			return AWins
		case outA:
			return BWins
		}
	}
	return Ongoing
}
