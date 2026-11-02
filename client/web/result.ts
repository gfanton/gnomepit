// The result screen's account of a finished match: who won, read from the player's side when a
// side is named You, how it ended, and the winner's blow that decided it.

import { otherSide, type Resolution, type Side } from "./engine.ts";
import type { Round } from "./flow.ts";

// finishing marks the hit that knocked the loser out; otherwise the blow is the winner's hardest.
export type Blow = { card: number; damage: number; round: number; finishing: boolean };
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
      : `On health after three rounds, ${last.state.gnomes[winner].hp} to ${last.state.gnomes[loser].hp}.`,
    blow: decidingBlow(rounds, winner, knockout),
  };
}

// decidingBlow is the winner's hit that brought the loser to 0 HP after a knockout, or else their
// hardest hit, the later of a tie; null when they dealt no damage.
function decidingBlow(rounds: Round[], winner: Side, knockout: boolean): Blow | null {
  let hardest: Blow | null = null;
  for (const [i, { events }] of rounds.entries()) {
    for (const ev of events) {
      if (ev.kind !== "HitLanded" || ev.side !== winner) continue;
      const blow = { card: ev.card, damage: ev.n, round: i + 1, finishing: false };
      if (knockout && ev.after[otherSide(winner)].hp <= 0) return { ...blow, finishing: true };
      if (ev.n > 0 && (hardest === null || ev.n >= hardest.damage)) hardest = blow;
    }
  }
  return hardest;
}
