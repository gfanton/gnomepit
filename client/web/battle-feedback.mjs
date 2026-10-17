import { slots } from "./plan.mjs";

// Presentation only: the engine's actual HP damage and absorbed damage stay separate.
export function stepFeedback(events) {
  const sides = [0, 1].map(() => ({ damage: 0, blocked: 0, block: 0, counter: 0, strength: 0, vulnerable: 0 }));
  const cancelled = [];
  for (const event of events) {
    const target = ["HitLanded", "VulnerableApplied", "BlockStripped"].includes(event.kind)
      ? 1 - event.side
      : event.side;
    const side = sides[target];
    if (event.kind === "HitLanded" || event.kind === "CounterHit") {
      side.damage += event.n;
      side.blocked += event.blocked ?? 0;
    } else if (event.kind === "BlockGained") side.block += event.n;
    else if (event.kind === "CounterGained") side.counter += event.n;
    else if (event.kind === "StrengthGained") side.strength += event.n;
    else if (event.kind === "VulnerableApplied" || event.kind === "VulnerableGained") side.vulnerable += event.n;
    else if (event.kind === "BlockStripped") side.block -= event.n;
    else if (event.kind === "VulnerableMoved") {
      // ceiling: shows the tokens that left the mover, not those the receiver's cap kept.
      side.vulnerable -= event.n;
      sides[1 - event.side].vulnerable += event.n;
    } else if (event.kind === "Cancelled") cancelled.push({ side: event.side, card: event.card, beat: event.beat });
  }
  return { sides, cancelled };
}

// cardBehind is the side and plan index of the card that produced an event. A Cancelled
// event names the cancelled card, so the card behind it is the opponent's card on that beat.
export function cardBehind(event, plans, cards) {
  const side = event.kind === "Cancelled" ? 1 - event.side : event.side;
  return { side, index: slots(plans[side], cards)[event.beat - 1].index };
}
