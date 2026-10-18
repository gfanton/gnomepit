// Log sentences, one per event, and the plain-text match log for playtest notes.
// ctx is {cards, names: [nameA, nameB], plans: [a, b]} for the round the events belong to.

import { cardBehind } from "./battle-feedback.ts";
import { cardOf, otherSide, type BattleEvent, type Card, type Resolution } from "./engine.ts";
import type { Flow, Round } from "./flow.ts";

type Names = [string, string];

export type LogContext = { cards: Card[]; names: Names; plans: [number[], number[]] };

export function sentences(events: BattleEvent[], { cards, names, plans }: LogContext): string[] {
  const hitsTotal = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === "HitLanded") hitsTotal.set(hitKey(ev), (hitsTotal.get(hitKey(ev)) ?? 0) + 1);
  }
  const hitsSoFar = new Map<string, number>();
  return events.map((ev) => {
    const card = cardOf(cards, ev.card).name;
    const me = names[ev.side];
    const other = names[otherSide(ev.side)];
    switch (ev.kind) {
      case "Cancelled": {
        const by = cardBehind(ev, plans, cards);
        const canceller = plans[by.side][by.index];
        if (canceller === undefined) throw new Error(`side ${by.side}'s plan has no card ${by.index}`);
        return `${cardOf(cards, canceller).name} cancels ${card}.`;
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
        const head = (hitsTotal.get(hitKey(ev)) ?? 0) > 1 ? `${card}, hit ${k}` : card;
        const parts = [`${ev.n + ev.blocked} damage`];
        if (ev.doubled) parts.push("doubled by Vulnerable");
        if (ev.blocked > 0) parts.push(`${ev.blocked} blocked`);
        return `${head}: ${parts.join(", ")}. ${other} ${ev.after[otherSide(ev.side)].hp}.`;
      }
      case "CounterHit":
        return `Counter deals ${ev.n} to ${me}. ${me} ${ev.after[ev.side].hp}.`;
      case "VulnerableApplied":
        return `${card}: ${other} ${verb(other, "is", "are")} Vulnerable ${ev.after[otherSide(ev.side)].vulnerable}.`;
      case "VulnerableGained":
        return `${card}: ${me} ${verb(me, "is", "are")} Vulnerable ${ev.after[ev.side].vulnerable}.`;
      case "VulnerableMoved":
        if (ev.n === 0) return `${card}: ${me} ${verb(me, "has", "have")} no Vulnerable to move.`;
        return `${card}: ${me} ${verb(me, "moves", "move")} ${ev.n} Vulnerable to ${other}, who ${verb(other, "is", "are")} Vulnerable ${ev.after[otherSide(ev.side)].vulnerable}.`;
      case "BlockStripped":
        if (ev.n === 0) return `${card}: ${other} ${verb(other, "has", "have")} no Block to lose.`;
        return `${card}: ${other} ${verb(other, "loses", "lose")} ${ev.n} Block.`;
      case "StrengthGained":
        return `${card}: ${me} +${ev.n} Strength.`;
      default:
        return `${card}: ${ev.kind}.`;
    }
  });
}

// A basic can be played by both sides and more than once in a plan, so hits are counted per
// side, card and beat: a card's hits all land on one beat.
const hitKey = (ev: BattleEvent) => `${ev.side}:${ev.card}:${ev.beat}`;

const verb = (name: string, form: string, youForm: string) => (name === "You" ? youForm : form);

// sideNames names the sides by clan, or by player when both play the same clan. The guided
// match calls its player You.
export function sideNames(clans: Names, mode: Flow["mode"]): Names {
  if (mode === "tutorial") return ["You", clans[1]];
  if (clans[0] !== clans[1]) return [...clans];
  return mode === "bot" ? ["You", "Bot"] : ["Player 1", "Player 2"];
}

export function possessive(name: string): string {
  if (name === "You") return "Your";
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

export function resultLine(result: Resolution["result"], names: Names): string {
  switch (result) {
    case "a":
      return `Winner: ${names[0]}.`;
    case "b":
      return `Winner: ${names[1]}.`;
    case "draw":
      return "Draw.";
    case "ongoing":
      return "";
  }
}

export function matchLog(
  rounds: Round[],
  result: Resolution["result"],
  { cards, names }: Pick<LogContext, "cards" | "names">,
): string {
  const lines: string[] = [];
  rounds.forEach((round, i) => {
    lines.push(`Round ${i + 1}`);
    round.plans.forEach((plan, side) =>
      lines.push(`${names[side]}: ${plan.map((id) => cardOf(cards, id).name).join(", ")}`),
    );
    lines.push(...sentences(round.events, { cards, names, plans: round.plans }));
    lines.push(`${names[0]} ${round.state.gnomes[0].hp}, ${names[1]} ${round.state.gnomes[1].hp}`, "");
  });
  lines.push(resultLine(result, names));
  return lines.join("\n") + "\n";
}
