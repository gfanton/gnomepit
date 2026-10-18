// What is public on the table: the cards a side is known to hold and the round a card was
// spent in. `rounds` is the flow's played rounds, each with its two plans.

import { cardOf, type Card, type Side } from "./engine.ts";
import type { Round } from "./flow.ts";

export type KnownCards = { open: boolean; cards: { id: number; spentRound: number }[] };

// knownCards is what the other side knows of a side's cards: its clan pack until the first
// reveal, its open deck after that (decision 32). Cheapest first, each with its spentIn round.
export function knownCards(
  rounds: Pick<Round, "plans">[],
  side: Side,
  pack: number[],
  deck: number[],
  cards: Card[],
): KnownCards {
  const open = rounds.length > 0;
  const ids = [...(open ? deck : pack)].sort((a, b) => {
    const byCost = cardOf(cards, a).cost - cardOf(cards, b).cost;
    return byCost !== 0 ? byCost : a - b;
  });
  return { open, cards: ids.map((id) => ({ id, spentRound: spentIn(rounds, side, id) })) };
}

// spentIn is the 1-based round in which the side played the card, or 0 if it has not.
export function spentIn(rounds: Pick<Round, "plans">[], side: Side, cardId: number): number {
  return rounds.findIndex((round) => round.plans[side].includes(cardId)) + 1;
}
