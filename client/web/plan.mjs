// The plan builder: a plan is an ordered list of card ids filling three beats. `cards` is
// the ruleset view's card list indexed by id; `available` lists the ids the player may
// play, the two basics and the deck's unspent specials.

const beats = 3;

export function beatsUsed(plan, cards) {
  return plan.reduce((sum, id) => sum + cards[id].cost, 0);
}

// canAdd: the card fits the remaining beats, and a special is available and not already
// in the plan.
export function canAdd(plan, cardId, cards, available) {
  const card = cards[cardId];
  if (beatsUsed(plan, cards) + card.cost > beats) return false;
  if (!card.special) return true;
  return available.includes(cardId) && !plan.includes(cardId);
}

export function addCard(plan, cardId, cards, available) {
  return canAdd(plan, cardId, cards, available) ? [...plan, cardId] : plan;
}

// clearFrom drops the card occupying the 0-based beat and every card after it.
export function clearFrom(plan, beat, cards) {
  const slot = slots(plan, cards)[beat];
  return slot === null ? plan : plan.slice(0, slot.index);
}

// slots lays the plan over the three beats: {cardId, index, lands} or null per beat, where
// lands marks the card's last beat.
export function slots(plan, cards) {
  const out = [null, null, null];
  let beat = 0;
  plan.forEach((cardId, index) => {
    const { cost } = cards[cardId];
    for (let k = 0; k < cost; k++) out[beat++] = { cardId, index, lands: k === cost - 1 };
  });
  return out;
}

export function isSealable(plan, legalPlans) {
  return legalPlans.some((p) => p.length === plan.length && p.every((id, i) => id === plan[i]));
}
