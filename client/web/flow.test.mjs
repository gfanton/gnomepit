import test from "node:test";
import assert from "node:assert/strict";

import { initial, reduce, botTurn } from "./flow.mjs";

const hp = 15;
const deckA = [2, 3, 4, 5, 6, 7, 8, 9];
const deckB = [12, 13, 14, 15, 16, 17, 18, 19];
const gnome = { hp, vulnerable: 0, strength: 0, spent: [] };
const startState = { round: 1, gnomes: [gnome, gnome] };
const nextState = { round: 2, gnomes: [{ ...gnome, hp: 7, spent: [6, 7] }, { ...gnome, hp: 12, spent: [14, 16] }] };

const start = (mode) => ({ type: "start", mode, hp });
const deckReady = (clan, deck) => ({ type: "deckReady", clan, deck });
const handoffDone = { type: "handoffDone" };
const planSealed = (plan) => ({ type: "planSealed", plan });
const resolved = (result, state = nextState) => ({ type: "resolved", state, result, events: [{ kind: "HitLanded" }] });
const playbackDone = { type: "playbackDone" };

const play = (actions, from = initial) => actions.reduce(reduce, from);
const bothDecks = (mode) => {
  const base = [start(mode), deckReady("Pickers", deckA)];
  return mode === "hotseat"
    ? [...base, handoffDone, deckReady("Ironhide", deckB), handoffDone]
    : [...base, deckReady("Ironhide", deckB)];
};
const bothPlans = (mode) => {
  const first = planSealed([0, 0, 0]);
  return mode === "hotseat" ? [first, handoffDone, planSealed([1, 1, 1])] : [first, planSealed([1, 1, 1])];
};

test("start opens the deck screen for player 1 with a fresh state", () => {
  const f = reduce(initial, start("hotseat"));
  assert.equal(f.screen, "deck");
  assert.equal(f.acting, 0);
  assert.equal(f.mode, "hotseat");
  assert.equal(f.hp, hp);
  assert.deepEqual(f.state, startState);
});

test("hot-seat: player 1's deck leads to a hand-off, then player 2's deck", () => {
  let f = play([start("hotseat"), deckReady("Pickers", deckA)]);
  assert.equal(f.screen, "handoff");
  assert.deepEqual(f.after, { screen: "deck", acting: 1 });
  f = reduce(f, handoffDone);
  assert.equal(f.screen, "deck");
  assert.equal(f.acting, 1);
  assert.deepEqual(f.clans, ["Pickers", null]);
  assert.deepEqual(f.decks, [deckA, null]);
});

test("bot: player 1's deck leads straight to the bot's deck turn", () => {
  const f = play([start("bot"), deckReady("Pickers", deckA)]);
  assert.equal(f.screen, "deck");
  assert.equal(f.acting, 1);
  assert.equal(botTurn(f), true);
});

test("hot-seat: player 2's deck hands off before player 1's plan", () => {
  let f = play([start("hotseat"), deckReady("Pickers", deckA), handoffDone, deckReady("Ironhide", deckB)]);
  assert.equal(f.screen, "handoff");
  assert.deepEqual(f.after, { screen: "plan", acting: 0 });
  f = reduce(f, handoffDone);
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 0);
  assert.deepEqual(f.decks, [deckA, deckB]);
  assert.deepEqual(f.clans, ["Pickers", "Ironhide"]);
});

test("bot: the bot's deck leads straight to player 1's plan", () => {
  const f = play(bothDecks("bot"));
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 0);
  assert.deepEqual(f.decks, [deckA, deckB]);
});

test("hot-seat: player 1's plan leads to a hand-off, then player 2's plan", () => {
  let f = play([...bothDecks("hotseat"), planSealed([0, 0, 0])]);
  assert.equal(f.screen, "handoff");
  assert.deepEqual(f.after, { screen: "plan", acting: 1 });
  f = reduce(f, handoffDone);
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 1);
  assert.deepEqual(f.plans, [[0, 0, 0], null]);
});

test("bot: player 1's plan leads straight to the bot's plan turn", () => {
  const f = play([...bothDecks("bot"), planSealed([0, 0, 0])]);
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 1);
  assert.equal(botTurn(f), true);
});

test("player 2's plan leads to playback", () => {
  const f = play([...bothDecks("hotseat"), ...bothPlans("hotseat")]);
  assert.equal(f.screen, "playback");
  assert.deepEqual(f.plans, [[0, 0, 0], [1, 1, 1]]);
});

test("resolved records the round, replaces the state and clears the plans", () => {
  const f = play([...bothDecks("hotseat"), ...bothPlans("hotseat"), resolved("ongoing")]);
  assert.equal(f.screen, "playback");
  assert.equal(f.rounds.length, 1);
  assert.deepEqual(f.rounds[0].plans, [[0, 0, 0], [1, 1, 1]]);
  assert.deepEqual(f.rounds[0].events, [{ kind: "HitLanded" }]);
  assert.deepEqual(f.rounds[0].state, nextState);
  assert.deepEqual(f.state, nextState);
  assert.deepEqual(f.plans, [null, null]);
  assert.equal(f.result, "ongoing");
});

test("playbackDone with the match ongoing hands off to player 1's plan in hot-seat", () => {
  const f = play([...bothDecks("hotseat"), ...bothPlans("hotseat"), resolved("ongoing"), playbackDone]);
  assert.equal(f.screen, "handoff");
  assert.deepEqual(f.after, { screen: "plan", acting: 0 });
});

test("playbackDone with the match ongoing goes straight to player 1's plan against the bot", () => {
  const f = play([...bothDecks("bot"), ...bothPlans("bot"), resolved("ongoing"), playbackDone]);
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 0);
});

test("playbackDone after a knockout leads to the result", () => {
  const f = play([...bothDecks("hotseat"), ...bothPlans("hotseat"), resolved("a"), playbackDone]);
  assert.equal(f.screen, "result");
  assert.equal(f.result, "a");
});

test("rematch keeps the decks, restarts the state and hands off in hot-seat", () => {
  const f = play([...bothDecks("hotseat"), ...bothPlans("hotseat"), resolved("b"), playbackDone, { type: "rematch" }]);
  assert.equal(f.screen, "handoff");
  assert.deepEqual(f.after, { screen: "plan", acting: 0 });
  assert.deepEqual(f.decks, [deckA, deckB]);
  assert.deepEqual(f.state, startState);
  assert.deepEqual(f.rounds, []);
  assert.deepEqual(f.plans, [null, null]);
  assert.equal(f.result, "ongoing");
});

test("rematch against the bot goes straight to player 1's plan", () => {
  const f = play([...bothDecks("bot"), ...bothPlans("bot"), resolved("draw"), playbackDone, { type: "rematch" }]);
  assert.equal(f.screen, "plan");
  assert.equal(f.acting, 0);
});

test("newMatch returns to the initial flow", () => {
  const f = play([...bothDecks("bot"), ...bothPlans("bot"), resolved("a"), playbackDone, { type: "newMatch" }]);
  assert.deepEqual(f, initial);
});

test("botTurn is false in hot-seat and for player 1", () => {
  assert.equal(botTurn(play([start("hotseat"), deckReady("Pickers", deckA), handoffDone])), false);
  assert.equal(botTurn(play([start("bot")])), false);
});

test("an action that does not fit the screen leaves the flow unchanged", () => {
  const f = play([start("hotseat")]);
  assert.deepEqual(reduce(f, planSealed([0, 0, 0])), f);
  assert.deepEqual(reduce(f, { type: "nonsense" }), f);
});

test("reduce returns a new object and never mutates its input", () => {
  const f = play([start("hotseat")]);
  const before = structuredClone(f);
  const next = reduce(f, deckReady("Pickers", deckA));
  assert.notEqual(next, f);
  assert.deepEqual(f, before);
});

test("a hot-seat match with a knockout in round 2 reaches the result with two rounds", () => {
  const round2 = { round: 3, gnomes: [{ ...gnome, hp: 2, spent: [6, 7, 8] }, { ...gnome, hp: -1, spent: [14, 16, 13] }] };
  const f = play([
    ...bothDecks("hotseat"),
    ...bothPlans("hotseat"), resolved("ongoing"), playbackDone, handoffDone,
    ...bothPlans("hotseat"), resolved("a", round2), playbackDone,
  ]);
  assert.equal(f.screen, "result");
  assert.equal(f.rounds.length, 2);
  assert.deepEqual(f.state, round2);
});

const startTutorial = { type: "startTutorial", hp, clans: ["Pickers", "Ironhide"], decks: [deckA, deckB] };

test("the guided match starts on your round 1 plan with both decks set", () => {
  const flow = reduce(initial, startTutorial);
  assert.equal(flow.screen, "plan");
  assert.equal(flow.mode, "tutorial");
  assert.equal(flow.acting, 0);
  assert.deepEqual(flow.clans, ["Pickers", "Ironhide"]);
  assert.deepEqual(flow.decks, [deckA, deckB]);
  assert.deepEqual(flow.state, startState);
});

test("in the guided match the script plays Ironhide's turn, with no hand-off", () => {
  const flow = play([startTutorial, planSealed([0, 0, 0])]);
  assert.equal(flow.screen, "plan");
  assert.equal(flow.acting, 1);
  assert.equal(botTurn(flow), true);
  assert.equal(play([planSealed([1, 1, 1])], flow).screen, "playback");
});

test("the guided match starts only from the title screen", () => {
  const library = { ...initial, screen: "library" };
  assert.equal(reduce(library, startTutorial), library);
});
