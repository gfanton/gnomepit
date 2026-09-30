// The deck picker: a deck is {clan, picks}, the ids picked from the clan's pool with the
// Rare always in. `clan` is a clan view {name, cards}; `cards` the card list by id.

export const deckSize = 8;

export function newDeck(clan, cards) {
  return { clan: clan.name, picks: [rareOf(clan, cards)] };
}

// toggle adds a pool card while the deck has room, or removes a picked one. The Rare and a
// card outside the pool leave the deck unchanged.
export function toggle(deck, cardId, clan, cards) {
  if (cardId === rareOf(clan, cards) || !clan.cards.includes(cardId)) return deck;
  if (deck.picks.includes(cardId)) return { ...deck, picks: deck.picks.filter((id) => id !== cardId) };
  if (deck.picks.length >= deckSize) return deck;
  return { ...deck, picks: [...deck.picks, cardId] };
}

export function rareOf(clan, cards) {
  return clan.cards.find((id) => cards[id].rare);
}
