// The deck picker: a deck starts as its clan's suggested eight, and the player leaves cards out
// and puts them back until deckSize remain. Its picks keep pool order, and the Rare always stays in.

import { cardOf, type Card, type Clan } from "./engine.ts";

export type Deck = { clan: string; picks: number[] };

export const deckSize = 8;

// The pair each clan's suggested deck leaves out: the deck without them wins most often when both
// sides play random legal plans against a random clan's random deck.
const suggestedOut: Record<string, readonly string[]> = {
  Pickers: ["Dodge Roll", "Momentum"],
  Ironhide: ["Shield Catch", "Loose Timbers"],
  Delvers: ["Cribbing", "Blowback"],
};

// newDeck is the clan's suggested deck; a clan without a suggestion starts with its whole pool.
export function newDeck(clan: Clan, cards: Card[]): Deck {
  const out = suggestedOut[clan.name] ?? [];
  return { clan: clan.name, picks: clan.cards.filter((id) => !out.includes(cardOf(cards, id).name)) };
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

const listing = new Intl.ListFormat("en-GB", { type: "conjunction" });

// sitOutText names the pool cards the deck leaves out, or is empty when it keeps them all.
export function sitOutText(deck: Deck, clan: Clan, cards: Card[]): string {
  const out = clan.cards.filter((id) => !deck.picks.includes(id)).map((id) => cardOf(cards, id).name);
  return out.length === 0 ? "" : `${listing.format(out)} ${out.length === 1 ? "sits" : "sit"} out`;
}

// rareOf is undefined for a clan without a Rare.
export function rareOf(clan: Clan, cards: Card[]): number | undefined {
  return clan.cards.find((id) => cardOf(cards, id).rare);
}
