// Presentation only: the engine's actual HP damage and absorbed damage stay separate.
export function stepFeedback(events) {
  const sides = [0, 1].map(() => ({ damage: 0, blocked: 0, block: 0, counter: 0, strength: 0, vulnerable: 0 }));
  const cancelled = [];
  const attackers = new Set();
  for (const event of events) {
    const target = event.kind === "HitLanded" || event.kind === "VulnerableApplied" ? 1 - event.side : event.side;
    const side = sides[target];
    if (event.kind === "HitLanded" || event.kind === "CounterHit") {
      side.damage += event.n;
      side.blocked += event.blocked ?? 0;
      attackers.add(event.kind === "HitLanded" ? event.side : 1 - event.side);
    } else if (event.kind === "BlockGained") side.block += event.n;
    else if (event.kind === "CounterGained") side.counter += event.n;
    else if (event.kind === "StrengthGained") side.strength += event.n;
    else if (event.kind === "VulnerableApplied") side.vulnerable += event.n;
    else if (event.kind === "Cancelled") cancelled.push({ side: event.side, card: event.card, beat: event.beat });
  }
  return { sides, cancelled, attackers: [...attackers] };
}
