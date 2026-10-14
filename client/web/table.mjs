// What is public on the table: the cards a side is known to hold and the round a card was
// spent in. `rounds` is the flow's played rounds, each with its two plans.

// knownCards is what the other side knows of a side's cards: its clan pack until the first
// reveal, its open deck after that (decision 32). Cheapest first, each with its spentIn round.
export function knownCards(rounds, side, pack, deck, cards) {
  const open = rounds.length > 0;
  const ids = [...(open ? deck : pack)].sort((a, b) => cards[a].cost - cards[b].cost || a - b);
  return { open, cards: ids.map((id) => ({ id, spentRound: spentIn(rounds, side, id) })) };
}

// spentIn is the 1-based round in which the side played the card, or 0 if it has not.
export function spentIn(rounds, side, cardId) {
  return rounds.findIndex((round) => round.plans[side].includes(cardId)) + 1;
}
