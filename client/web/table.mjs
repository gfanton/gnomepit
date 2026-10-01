// What is public on the table: the cards a side may still hold and the round a card was
// spent in. `rounds` is the flow's played rounds, each with its two plans.

// unseen lists the pack cards the side has not spent, cheapest first.
export function unseen(pack, spent, cards) {
  return pack.filter((id) => !spent.includes(id)).sort((a, b) => cards[a].cost - cards[b].cost || a - b);
}

// spentIn is the 1-based round in which the side played the card, or 0 if it has not.
export function spentIn(rounds, side, cardId) {
  return rounds.findIndex((round) => round.plans[side].includes(cardId)) + 1;
}
