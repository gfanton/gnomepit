// The deck picker: a deck starts as its clan's whole pool, and the player leaves cards out until
// deckSize remain. Its picks keep pool order, and the Rare always stays in.

import { cardOf, type Card, type Clan } from "./engine.ts";

export type Deck = { clan: string; picks: number[] };

export const deckSize = 8;

export function newDeck(clan: Clan): Deck {
  return { clan: clan.name, picks: [...clan.cards] };
}

// toggle leaves a pool card out, or puts one back. The Rare and a card outside the pool leave
// the deck unchanged.
export function toggle(deck: Deck, cardId: number, clan: Clan, cards: Card[]): Deck {
  if (cardId === rareOf(clan, cards) || !clan.cards.includes(cardId)) return deck;
  const kept = deck.picks.includes(cardId);
  return { ...deck, picks: clan.cards.filter((id) => (id === cardId ? !kept : deck.picks.includes(id))) };
}

// readiness is the deck screen's call to action: what the player still has to do before the
// deck holds deckSize cards.
export function readiness(deck: Deck): string {
  const extra = deck.picks.length - deckSize;
  return extra > 0 ? `Leave out ${extra} more` : extra < 0 ? `Put ${-extra} back` : "Ready";
}

// rareOf is undefined for a clan without a Rare.
export function rareOf(clan: Clan, cards: Card[]): number | undefined {
  return clan.cards.find((id) => cardOf(cards, id).rare);
}
