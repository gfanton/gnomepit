// The result screen's account of a finished match: who won, read from the player's side when a
// side is named You, how it ended, and the winner's blow that decided it.

import { otherSide, type BattleEvent, type Resolution, type Side } from "./engine.ts";
import type { Round } from "./flow.ts";

// A blow is the winner's hit that knocked the loser out or put the winner ahead for good; when a
// Counter did either, it is the winner's hardest hit.
export type Blow = { card: number; damage: number; round: number; kind: "finishing" | "lead" | "hardest" };
export type Verdict = { winner: Side | null; title: string; detail: string; blow: Blow | null };

export function verdict(rounds: Round[], result: Resolution["result"], names: [string, string]): Verdict {
  const last = rounds.at(-1);
  if (last === undefined || result === "ongoing") throw new Error("The match has not ended.");
  const [a, b] = last.state.gnomes;
  const knockout = a.hp <= 0 || b.hp <= 0;
  if (result === "draw")
    return {
      winner: null,
      title: "A draw",
      detail: knockout
        ? `Both gnomes fell in round ${rounds.length}.`
        : `Level on health after three rounds, ${a.hp} each.`,
      blow: null,
    };
  const winner: Side = result === "a" ? 0 : 1;
  const loser = otherSide(winner);
  return {
    winner,
    title: names[winner] === "You" ? "You won" : names[loser] === "You" ? "You lost" : `${names[winner]} won`,
    detail: knockout
      ? `Knockout in round ${rounds.length}.`
      : `On health after three rounds: ${names[winner]} ${last.state.gnomes[winner].hp}, ${names[loser]} ${last.state.gnomes[loser].hp}.`,
    blow: (knockout ? finishingBlow(rounds, winner) : turningPoint(rounds, winner)) ?? hardestHit(rounds, winner),
  };
}

function finishingBlow(rounds: Round[], winner: Side): Blow | null {
  for (const [i, { events }] of rounds.entries())
    for (const ev of events)
      if (ev.kind === "HitLanded" && ev.side === winner && ev.after[otherSide(winner)].hp <= 0)
        return { card: ev.card, damage: ev.n, round: i + 1, kind: "finishing" };
  return null;
}

// turningPoint is the winner's biggest hit in the last step that put them ahead; null when a
// Counter, not a hit of theirs, made that step's swing.
function turningPoint(rounds: Round[], winner: Side): Blow | null {
  const loser = otherSide(winner);
  let ahead = false;
  let turn: Blow | null = null;
  for (const [i, { events }] of rounds.entries()) {
    for (const ev of events) {
      const leads = ev.after[winner].hp > ev.after[loser].hp;
      if (leads && !ahead) {
        const hits = events.filter((e) => sameStep(e, ev) && e.kind === "HitLanded" && e.side === winner);
        const best = hits.reduce<BattleEvent | null>((top, e) => (top === null || e.n > top.n ? e : top), null);
        turn = best === null ? null : { card: best.card, damage: best.n, round: i + 1, kind: "lead" };
      }
      ahead = leads;
    }
  }
  return turn;
}

function sameStep(a: BattleEvent, b: BattleEvent): boolean {
  return a.beat === b.beat && a.phase === b.phase && a.tier === b.tier && a.step === b.step;
}

// hardestHit is the winner's biggest hit, the later of a tie; null when they dealt no damage.
function hardestHit(rounds: Round[], winner: Side): Blow | null {
  let hardest: Blow | null = null;
  for (const [i, { events }] of rounds.entries())
    for (const ev of events)
      if (ev.kind === "HitLanded" && ev.side === winner && ev.n > 0 && (hardest === null || ev.n >= hardest.damage))
        hardest = { card: ev.card, damage: ev.n, round: i + 1, kind: "hardest" };
  return hardest;
}
