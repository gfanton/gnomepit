// The lobby uses the arena view, never wallet/chain internals: the realm's fields, any of
// them absent, and what the arena adds. Times in the arena are Unix seconds.

import type { Action, MatchDetail, MatchView, OpenChallenge, Phase } from "./arena.ts";
import { type Card, type Clan, type Engine, type GameState, type Resolution, type Side, startState } from "./engine.ts";
import type { Round } from "./flow.ts";
import { type Address, type MatchId, matchId } from "./ids.ts";
import { counted } from "./keywords.ts";

type Pair<T> = [T, T];

// A match, a summary or a board challenge as the arena gives it.
export type ArenaView = Partial<MatchView & OpenChallenge> &
  Partial<Pick<MatchDetail, "action" | "deadline" | "session" | "pending" | "planning">>;

// A view under the lobby's names. side is this player's: 0 for the challenger, 1 for the
// acceptor, -1 for neither.
export type View = {
  id: MatchId;
  phase: Phase | undefined;
  round: number | undefined;
  challenger: Address | undefined;
  acceptor: Address | "" | undefined;
  opponent: Address | "" | undefined;
  challengerClan: string | undefined;
  acceptorClan: string | undefined;
  clan: string | undefined;
  toMove: Address | "" | undefined;
  deadline: number | undefined;
  result: string | undefined;
  reason: string | undefined;
  posted: number | undefined;
  expires: number | undefined;
  challengerDeck: string | undefined;
  acceptorDeck: string | undefined;
  plans: string[][] | undefined;
  hp: number[][] | undefined;
  deadlinePassed: boolean;
  session: MatchDetail["session"] | undefined;
  players: Pair<Address | "">;
  clans: Pair<string>;
  side: Side | -1;
  action: Action;
};

// isSet is true for a time the arena set; 0 stands for none.
export const isSet = (unix: number | undefined): unix is number =>
  unix !== undefined && unix !== 0 && !Number.isNaN(unix);

export function viewOf(raw: ArenaView, address: Address | "" = "", now = Date.now() / 1000): View {
  const players: Pair<Address | ""> = [raw.Challenger ?? "", raw.Acceptor ?? ""];
  const side = sideOf(players, address);
  const deadline = raw.deadline ?? raw.Deadline;
  const opponent = raw.Opponent;
  const expires = raw.Expires;
  const deadlinePassed = raw.DeadlinePassed === true || (isSet(deadline) && now >= deadline);
  let phase = raw.Phase;
  let action: Action =
    raw.action ??
    (phase === "open" &&
    side !== 0 &&
    (opponent === undefined || opponent === "" || opponent === address) &&
    (!isSet(expires) || now < expires)
      ? "accept"
      : phase === "ended" || phase === "expired"
        ? "done"
        : deadlinePassed && side >= 0 && raw.ToMove !== address
          ? "claimForfeit"
          : "wait"); // Only the arena can say a turn needs move vs automatic finish.
  if ((phase === "play" || phase === "reveal") && deadlinePassed)
    action = side >= 0 && raw.ToMove !== address ? "claimForfeit" : "wait";
  if (phase === "open" && isSet(expires) && now >= expires) {
    phase = "expired";
    action = "done";
  }
  if (phase === "open" && opponent !== undefined && opponent !== "" && opponent !== address) action = "wait";
  return {
    id: raw.ID ?? matchId(""),
    phase,
    round: raw.Round,
    challenger: raw.Challenger,
    acceptor: raw.Acceptor,
    opponent,
    challengerClan: raw.ChallengerClan,
    acceptorClan: raw.AcceptorClan,
    clan: raw.Clan,
    toMove: raw.ToMove,
    deadline,
    result: raw.Result,
    reason: raw.Reason,
    posted: raw.Posted,
    expires,
    challengerDeck: raw.ChallengerDeck,
    acceptorDeck: raw.AcceptorDeck,
    plans: raw.Plans,
    hp: raw.HP,
    deadlinePassed,
    session: raw.session,
    players,
    clans: [raw.ChallengerClan ?? raw.Clan ?? "", raw.AcceptorClan ?? ""],
    side,
    action,
  };
}

function sideOf(players: Pair<Address | "">, address: Address | ""): Side | -1 {
  if (address === "") return -1;
  return players[0] === address ? 0 : players[1] === address ? 1 : -1;
}

// matchBarText is what the bar over an online plan says: the player's deadline in a match
// under way, or which first plan they are making.
export function matchBarText(intent: "challenge" | "accept" | "move", deadline: number | undefined): string {
  if (intent === "accept") return "Accepting a challenge · Round 1";
  if (intent === "challenge") return "Posting a challenge · Round 1";
  return isSet(deadline) ? `Your move deadline: ${deadlineText(deadline)}` : "Your move";
}

// deadlineText is a Unix time as a short date and time in the page's locale and time zone.
export function deadlineText(unix: number, locale?: string, timeZone?: string): string {
  const style = { dateStyle: "medium", timeStyle: "short" } as const;
  return new Intl.DateTimeFormat(locale, timeZone === undefined ? style : { ...style, timeZone }).format(unix * 1000);
}

// sendingText is the match bar's status while a plan of intent is sent.
export function sendingText(intent: "challenge" | "accept" | "move"): string {
  return intent === "move"
    ? "Sending your move… Waiting for confirmation."
    : "Approve the request in Adena if it asks, then wait for the chain to confirm.";
}

export function shortAddress(address: string | undefined): string {
  if (address === undefined || address === "") return "Awaiting a rival";
  return address.length > 15 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
export function timeLeft(unix: number | undefined, now = Date.now() / 1000): string {
  if (!isSet(unix)) return "No deadline";
  const seconds = unix - now;
  if (seconds <= 0) return "Deadline passed";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 1440) return `${counted(Math.ceil(minutes / 1440), "day")} left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

type NamedCard = Pick<Card, "id" | "name">;

export function cardIds(value: string | readonly number[] | undefined, cards: readonly NamedCard[]): number[] {
  if (value === undefined || value.length === 0) return [];
  const items: readonly (string | number)[] = typeof value === "string" ? value.split(",").map((s) => s.trim()) : value;
  return items.map((item) => {
    const c = typeof item === "number" ? cards.find((c) => c.id === item) : cards.find((c) => c.name === item);
    if (c === undefined)
      throw new Error("This page’s card file does not match the chain’s engine. Reload before playing.");
    return c.id;
  });
}

// The engine replayView plays with; without clans, the view's clans go unchecked.
type ReplayEngine = Pick<Engine, "hp" | "resolve"> & {
  cards: readonly NamedCard[];
  clans?: readonly Pick<Clan, "name">[];
};
// A replayed round, with the state it started in.
export type ReplayedRound = Round & { start: GameState };
export type Replay = {
  view: View;
  decks: Pair<number[]>;
  state: GameState;
  rounds: ReplayedRound[];
  result: Resolution["result"];
};

export function replayView(view: ArenaView, engine: ReplayEngine, address: Address | ""): Replay {
  const v = viewOf(view, address);
  const clans = engine.clans;
  if (clans !== undefined && v.clans.some((name) => name !== "" && !clans.some((c) => c.name === name)))
    throw new Error("This page’s card file does not match the chain’s engine. Reload before playing.");
  const decks: Pair<number[]> = [cardIds(v.challengerDeck, engine.cards), cardIds(v.acceptorDeck, engine.cards)];
  // The arena opens the challenger's deck from their box.
  if (v.side !== -1 && decks[v.side].length === 0) decks[v.side] = cardIds(view.planning?.deck, engine.cards);
  let state: GameState = startState(engine.hp);
  const rounds: ReplayedRound[] = [];
  let result: Resolution["result"] = "ongoing";
  for (const [i, pair] of (v.plans ?? []).entries()) {
    const [a, b] = pair;
    if (pair.length !== 2 || a === undefined || b === undefined)
      throw new Error("The arena returned an unreadable round.");
    const plans: Pair<number[]> = [cardIds(a, engine.cards), cardIds(b, engine.cards)];
    if (plans.some((p) => p.length === 0)) break; // Current sealed or incomplete round.
    if (decks.some((d) => d.length === 0))
      throw new Error("Public decks are needed to replay this match. Refresh the match.");
    const start = state;
    const resolved = engine.resolve({ state, decks, a: plans[0], b: plans[1] });
    const chainHP = v.hp?.[i];
    if (chainHP === undefined || chainHP.length !== 2 || resolved.state.gnomes.some((g, s) => g.hp !== chainHP[s]))
      throw new Error("This page’s card file does not match the chain’s engine. Reload before playing.");
    state = resolved.state;
    result = resolved.result;
    rounds.push({ plans, events: resolved.events, state, start });
  }
  const pending = view.pending; // the challenger's clash, which the arena resolves from their opened box
  if (pending !== undefined) {
    rounds.push({ plans: pending.plans, events: pending.events, state: pending.state, start: state });
    state = pending.state;
    result = pending.result;
  }
  return { view: v, decks, state, rounds, result };
}
