import { otherSide, type BattleEvent, type Card, type Side } from "./engine.ts";
import { slots } from "./plan.ts";

type Tally = { damage: number; blocked: number; block: number; counter: number; strength: number; vulnerable: number };

export type StepFeedback = { sides: [Tally, Tally]; cancelled: { side: Side; card: number; beat: number }[] };

// Presentation only: the engine's actual HP damage and absorbed damage stay separate.
export function stepFeedback(events: BattleEvent[]): StepFeedback {
  const tally = (): Tally => ({ damage: 0, blocked: 0, block: 0, counter: 0, strength: 0, vulnerable: 0 });
  const sides: [Tally, Tally] = [tally(), tally()];
  const cancelled: StepFeedback["cancelled"] = [];
  for (const event of events) {
    const target = ["HitLanded", "VulnerableApplied", "BlockStripped"].includes(event.kind)
      ? otherSide(event.side)
      : event.side;
    const side = sides[target];
    if (event.kind === "HitLanded" || event.kind === "CounterHit") {
      side.damage += event.n;
      side.blocked += event.blocked;
    } else if (event.kind === "BlockGained") side.block += event.n;
    else if (event.kind === "CounterGained") side.counter += event.n;
    else if (event.kind === "StrengthGained") side.strength += event.n;
    else if (event.kind === "VulnerableApplied" || event.kind === "VulnerableGained") side.vulnerable += event.n;
    else if (event.kind === "BlockStripped") side.block -= event.n;
    else if (event.kind === "VulnerableMoved") {
      // ceiling: shows the tokens that left the mover, not those the receiver's cap kept.
      side.vulnerable -= event.n;
      sides[otherSide(event.side)].vulnerable += event.n;
    } else if (event.kind === "Cancelled") cancelled.push({ side: event.side, card: event.card, beat: event.beat });
  }
  return { sides, cancelled };
}

// A hit of heavyHit HP or more lands with full force.
export const heavyHit = 5;

// impact is how hard damage HP lands, from 0 for none to 1 for a heavy hit; the page scales a
// hit's recoil, number and drain by it.
export function impact(damage: number): number {
  return Math.min(1, Math.max(0, damage) / heavyHit);
}

// cardBehind is the side and plan index of the card that produced an event. A Cancelled
// event names the cancelled card, so the card behind it is the opponent's card on that beat.
export function cardBehind(
  event: BattleEvent,
  plans: [number[], number[]],
  cards: Card[],
): { side: Side; index: number } {
  const side = event.kind === "Cancelled" ? otherSide(event.side) : event.side;
  const slot = slots(plans[side], cards)[event.beat - 1];
  if (slot === null || slot === undefined) throw new Error(`side ${side} has no card on beat ${event.beat}`);
  return { side, index: slot.index };
}
