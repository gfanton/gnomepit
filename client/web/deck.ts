// The deck picker: a deck is {clan, picks}, the ids picked from the clan's pool with the
// Rare always in. `clan` is a clan view {name, cards}; `cards` the card list by id.

import { cardOf, type Card, type Clan } from "./engine.ts";

export type Deck = { clan: string; picks: number[] };

export const deckSize = 8;

export function newDeck(clan: Clan, cards: Card[]): Deck {
  const rare = rareOf(clan, cards);
  return { clan: clan.name, picks: rare === undefined ? [] : [rare] };
}

// toggle adds a pool card while the deck has room, or removes a picked one. The Rare and a
// card outside the pool leave the deck unchanged.
export function toggle(deck: Deck, cardId: number, clan: Clan, cards: Card[]): Deck {
  if (cardId === rareOf(clan, cards) || !clan.cards.includes(cardId)) return deck;
  if (deck.picks.includes(cardId)) return { ...deck, picks: deck.picks.filter((id) => id !== cardId) };
  if (deck.picks.length >= deckSize) return deck;
  return { ...deck, picks: [...deck.picks, cardId] };
}

// rareOf is undefined for a clan without a Rare.
export function rareOf(clan: Clan, cards: Card[]): number | undefined {
  return clan.cards.find((id) => cardOf(cards, id).rare);
}
