// The match flow: a pure reducer over the page's screens. It knows which screen shows,
// who is acting and what has been chosen; rendering and the engine live elsewhere.

import { type BattleEvent, type GameState, type Resolution, type Side, startState } from "./engine.ts";

type Pair<T> = [T, T];

export type Screen = "title" | "library" | "lobby" | "deck" | "handoff" | "plan" | "playback" | "result";
export type Mode = "hotseat" | "bot" | "tutorial" | "online";
export type Round = { plans: Pair<number[]>; events: BattleEvent[]; state: GameState };

export type Flow = {
  screen: Screen;
  mode: Mode | null;
  hp: number | null;
  acting: Side;
  clans: Pair<string | null>;
  decks: Pair<number[] | null>;
  state: GameState | null;
  plans: Pair<number[] | null>;
  rounds: Round[];
  result: Resolution["result"];
  after: { screen: Screen; acting: Side } | null;
};

export type Action =
  | { type: "start"; mode: "hotseat" | "bot"; hp: number }
  | { type: "startTutorial"; hp: number; clans: Pair<string>; decks: Pair<number[]> }
  | { type: "deckReady"; clan: string; deck: number[] }
  | { type: "handoffDone" }
  | { type: "planSealed"; plan: number[] }
  | ({ type: "resolved" } & Resolution)
  | { type: "playbackDone" }
  | { type: "rematch" }
  | { type: "newMatch" };

export const initial: Readonly<Flow> = Object.freeze<Flow>({
  screen: "title",
  mode: null,
  hp: null,
  acting: 0, // the player choosing a deck or a plan
  clans: [null, null],
  decks: [null, null],
  state: null, // the engine state between rounds
  plans: [null, null], // the current round's sealed plans
  rounds: [],
  result: "ongoing",
  after: null, // the screen a hand-off leads to
});

// botTurn is true when the bot has to choose a deck or a plan, or the guided match's script
// has to play Ironhide's plan.
export function botTurn(flow: Flow): boolean {
  if (flow.mode === "tutorial") return flow.acting === 1 && flow.screen === "plan";
  return flow.mode === "bot" && flow.acting === 1 && (flow.screen === "deck" || flow.screen === "plan");
}

// The screen each action belongs to; on any other screen an action leaves the flow as it is.
const screenOf = {
  start: "title",
  startTutorial: "title",
  deckReady: "deck",
  handoffDone: "handoff",
  planSealed: "plan",
  resolved: "playback",
  playbackDone: "playback",
  rematch: "result",
  newMatch: "result",
} as const satisfies Record<Action["type"], Screen>;

export function reduce(flow: Flow, action: Action): Flow {
  if (flow.screen !== screenOf[action.type]) return flow;
  switch (action.type) {
    case "start":
      return { ...initial, screen: "deck", mode: action.mode, hp: action.hp, state: startState(action.hp) };
    case "startTutorial":
      return {
        ...initial,
        screen: "plan",
        mode: "tutorial",
        hp: action.hp,
        clans: action.clans,
        decks: action.decks,
        state: startState(action.hp),
      };
    case "deckReady": {
      const next = {
        ...flow,
        clans: withAt(flow.clans, flow.acting, action.clan),
        decks: withAt(flow.decks, flow.acting, action.deck),
      };
      return flow.acting === 0 ? toward(next, "deck", 1) : toward(next, "plan", 0);
    }
    case "handoffDone":
      if (flow.after === null) return flow;
      return { ...flow, screen: flow.after.screen, acting: flow.after.acting, after: null };
    case "planSealed": {
      const next = { ...flow, plans: withAt(flow.plans, flow.acting, action.plan) };
      return flow.acting === 0 ? toward(next, "plan", 1) : { ...next, screen: "playback" };
    }
    case "resolved": {
      const [a, b] = flow.plans;
      if (a === null || b === null) return flow;
      return {
        ...flow,
        rounds: [...flow.rounds, { plans: [a, b], events: action.events, state: action.state }],
        state: action.state,
        result: action.result,
        plans: [null, null],
      };
    }
    case "playbackDone":
      return flow.result === "ongoing" ? toward(flow, "plan", 0) : { ...flow, screen: "result" };
    case "rematch":
      if (flow.hp === null) return flow;
      return toward(
        { ...flow, state: startState(flow.hp), rounds: [], plans: [null, null], result: "ongoing" },
        "plan",
        0,
      );
    case "newMatch":
      if (flow.mode !== "bot" && flow.mode !== "hotseat") return initial;
      return reduce(initial, { type: "start", mode: flow.mode, hp: flow.hp ?? 0 });
  }
}

// toward moves to a screen for a player, through the hand-off curtain in hot-seat since the
// next player must not see what the current one sees.
function toward(flow: Flow, screen: Screen, acting: Side): Flow {
  if (flow.mode === "hotseat") return { ...flow, screen: "handoff", after: { screen, acting } };
  return { ...flow, screen, acting, after: null };
}

function withAt<T>(list: Pair<T>, index: Side, value: T): Pair<T> {
  const out: Pair<T> = [...list];
  out[index] = value;
  return out;
}
