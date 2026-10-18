// The bot: a random legal deck and a uniformly random plan. `rand` returns a number in
// [0, 1), Math.random in the page and a fixed function in tests.

import { deckSize, rareOf } from "./deck.ts";
import type { Card, Clan } from "./engine.ts";

export function randomDeck(clan: Clan, cards: Card[], rand: () => number): number[] {
  const rare = rareOf(clan, cards);
  const pool = clan.cards.filter((id) => id !== rare);
  const picks = rare === undefined ? [] : [rare];
  while (picks.length < deckSize) {
    const [pick] = pool.splice(Math.floor(rand() * pool.length), 1);
    if (pick === undefined) throw new Error(`${clan.name} has too few cards for a deck`);
    picks.push(pick);
  }
  return picks.sort((a, b) => a - b);
}

export function randomPlan(plans: number[][], rand: () => number): number[] {
  const plan = plans[Math.floor(rand() * plans.length)];
  if (plan === undefined) throw new Error("no plan to choose from");
  return plan;
}
