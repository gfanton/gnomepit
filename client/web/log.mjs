// Log sentences, one per event, and the plain-text match log for playtest notes.
// ctx is {cards, names: [nameA, nameB], plans: [a, b]} for the round the events belong to.

import { slots } from "./plan.mjs";

export function sentences(events, { cards, names, plans }) {
  const hitsTotal = new Map();
  for (const ev of events) {
    if (ev.kind === "HitLanded") hitsTotal.set(hitKey(ev), (hitsTotal.get(hitKey(ev)) ?? 0) + 1);
  }
  const hitsSoFar = new Map();
  return events.map((ev) => {
    const card = cards[ev.card].name;
    const me = names[ev.side];
    const other = names[1 - ev.side];
    switch (ev.kind) {
      case "Cancelled": {
        const canceller = slots(plans[1 - ev.side], cards)[ev.beat - 1];
        return `${cards[canceller.cardId].name} cancels ${card}.`;
      }
      case "ParryEnded":
        return `${card}'s Parry ends.`;
      case "BlockGained":
        return `${card}: ${me} +${ev.n} Block.`;
      case "CounterGained":
        return `${card}: Counter ${ev.n}.`;
      case "HitLanded": {
        const k = (hitsSoFar.get(hitKey(ev)) ?? 0) + 1;
        hitsSoFar.set(hitKey(ev), k);
        const head = hitsTotal.get(hitKey(ev)) > 1 ? `${card}, hit ${k}` : card;
        const parts = [`${ev.n + ev.blocked} damage`];
        if (ev.doubled) parts.push("doubled by Vulnerable");
        if (ev.blocked > 0) parts.push(`${ev.blocked} blocked`);
        return `${head}: ${parts.join(", ")}. ${other} ${ev.after[1 - ev.side].hp}.`;
      }
      case "CounterHit":
        return `Counter deals ${ev.n} to ${me}. ${me} ${ev.after[ev.side].hp}.`;
      case "VulnerableApplied":
        return `${card}: ${other} is Vulnerable ${ev.after[1 - ev.side].vulnerable}.`;
      case "StrengthGained":
        return `${card}: ${me} +${ev.n} Strength.`;
      default:
        return `${card}: ${ev.kind}.`;
    }
  });
}

// A basic can be played by both sides and more than once in a plan, so hits are counted per
// side, card and beat: a card's hits all land on one beat.
const hitKey = (ev) => `${ev.side}:${ev.card}:${ev.beat}`;

// sideNames names the sides by clan, or by player when both play the same clan.
export function sideNames(clans, mode) {
  if (clans[0] !== clans[1]) return [...clans];
  return mode === "bot" ? ["You", "Bot"] : ["Player 1", "Player 2"];
}

export function resultLine(result, names) {
  switch (result) {
    case "a":
      return `Winner: ${names[0]}.`;
    case "b":
      return `Winner: ${names[1]}.`;
    case "draw":
      return "Draw.";
    default:
      return "";
  }
}

export function matchLog(rounds, result, { cards, names }) {
  const lines = [];
  rounds.forEach((round, i) => {
    lines.push(`Round ${i + 1}`);
    round.plans.forEach((plan, side) => lines.push(`${names[side]}: ${plan.map((id) => cards[id].name).join(", ")}`));
    lines.push(...sentences(round.events, { cards, names, plans: round.plans }));
    lines.push(`${names[0]} ${round.state.gnomes[0].hp}, ${names[1]} ${round.state.gnomes[1].hp}`, "");
  });
  lines.push(resultLine(result, names));
  return lines.join("\n") + "\n";
}
