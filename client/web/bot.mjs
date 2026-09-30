// The bot: a random legal deck and a uniformly random plan. `rand` returns a number in
// [0, 1), Math.random in the page and a fixed function in tests.

import { deckSize, rareOf } from "./deck.mjs";

export function randomDeck(clan, cards, rand) {
  const rare = rareOf(clan, cards);
  const pool = clan.cards.filter((id) => id !== rare);
  const picks = [rare];
  while (picks.length < deckSize) picks.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return picks.sort((a, b) => a - b);
}

export function randomPlan(plans, rand) {
  return plans[Math.floor(rand() * plans.length)];
}
