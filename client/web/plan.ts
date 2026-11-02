// The plan builder: a plan is an ordered list of card ids filling three beats. `cards` is
// the ruleset view's card list indexed by id; `available` lists the ids the player may
// play, the two basics and the deck's unspent specials.

import { cardOf, type Card } from "./engine.ts";
import { counted } from "./keywords.ts";

const beats = 3;

export type Slot = { cardId: number; index: number; lands: boolean };

export function beatsUsed(plan: number[], cards: Card[]): number {
  return plan.reduce((sum, id) => sum + cardOf(cards, id).cost, 0);
}

// canAdd: the card fits the remaining beats and is available, and a special is not already
// in the plan.
export function canAdd(plan: number[], cardId: number, cards: Card[], available: number[]): boolean {
  const card = cardOf(cards, cardId);
  if (beatsUsed(plan, cards) + card.cost > beats) return false;
  if (!available.includes(cardId)) return false;
  return !card.special || !plan.includes(cardId);
}

// fitText says why the card overruns the beats left, or is empty when it fits them.
export function fitText(plan: number[], cardId: number, cards: Card[]): string {
  const left = beats - beatsUsed(plan, cards);
  const cost = cardOf(cards, cardId).cost;
  if (cost <= left) return "";
  return left === 0 ? "All three beats are filled." : `Needs ${counted(cost, "beat")}; ${counted(left, "beat")} left.`;
}

export function addCard(plan: number[], cardId: number, cards: Card[], available: number[]): number[] {
  return canAdd(plan, cardId, cards, available) ? [...plan, cardId] : plan;
}

// clearFrom drops the card occupying the 0-based beat and every card after it.
export function clearFrom(plan: number[], beat: number, cards: Card[]): number[] {
  const slot = slots(plan, cards)[beat];
  if (slot === undefined) throw new RangeError(`a plan has no beat ${beat}`);
  return slot === null ? plan : plan.slice(0, slot.index);
}

// slots lays the plan over the three beats: {cardId, index, lands} or null per beat, where
// lands marks the card's last beat.
export function slots(plan: number[], cards: Card[]): (Slot | null)[] {
  const out: (Slot | null)[] = [null, null, null];
  let beat = 0;
  plan.forEach((cardId, index) => {
    const { cost } = cardOf(cards, cardId);
    for (let k = 0; k < cost; k++) out[beat++] = { cardId, index, lands: k === cost - 1 };
  });
  return out;
}

export function isSealable(plan: number[], legalPlans: number[][]): boolean {
  return legalPlans.some((p) => p.length === plan.length && p.every((id, i) => id === plan[i]));
}
