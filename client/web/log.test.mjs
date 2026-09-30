import test from "node:test";
import assert from "node:assert/strict";

import { cards, id } from "./fixture.mjs";
import { sentences, matchLog, sideNames } from "./log.mjs";

const A = (hp) => ({ hp, block: 0, counter: 0, vulnerable: 0, strength: 0 });
const B = (hp, block, counter, vulnerable) => ({ hp, block, counter, vulnerable, strength: 0 });
const e = (beat, phase, tier, step, kind, side, card, n, blocked, doubled, after) =>
  ({ beat, phase, tier, step, kind, side, card: id(card), n, blocked, doubled, after });

// The duel spec's worked example: Chalk Dust, Double Tap against Hammer Blow, Spiked Shield.
const tap = (step, hpA, hpB) => [
  e(3, "Damage", "Normal", step, "HitLanded", 0, "Double Tap", 1, 0, false, [A(hpA), B(hpB, 0, 1, 0)]),
  e(3, "Damage", "Normal", step, "CounterHit", 0, "Double Tap", 1, 0, false, [A(hpA), B(hpB, 0, 1, 0)]),
];
const events = [
  e(1, "Damage", "Quick", 1, "VulnerableApplied", 0, "Chalk Dust", 1, 0, false, [A(15), B(15, 0, 0, 1)]),
  e(2, "Damage", "Slow", 1, "HitLanded", 1, "Hammer Blow", 4, 0, false, [A(11), B(15, 0, 0, 1)]),
  e(3, "Block", "Normal", 1, "BlockGained", 1, "Spiked Shield", 1, 0, false, [A(11), B(15, 1, 1, 1)]),
  e(3, "Block", "Normal", 1, "CounterGained", 1, "Spiked Shield", 1, 0, false, [A(11), B(15, 1, 1, 1)]),
  e(3, "Damage", "Normal", 1, "HitLanded", 0, "Double Tap", 1, 1, true, [A(10), B(14, 0, 1, 0)]),
  e(3, "Damage", "Normal", 1, "CounterHit", 0, "Double Tap", 1, 0, false, [A(10), B(14, 0, 1, 0)]),
  ...tap(2, 9, 13),
  ...tap(3, 8, 12),
  ...tap(4, 7, 11),
];
const plans = [[id("Chalk Dust"), id("Double Tap")], [id("Hammer Blow"), id("Spiked Shield")]];
const ctx = { cards, names: ["Pickers", "Ironhide"], plans };

test("sentences narrate the worked example", () => {
  assert.deepEqual(sentences(events, ctx), [
    "Chalk Dust: Ironhide is Vulnerable 1.",
    "Hammer Blow: 4 damage. Pickers 11.",
    "Spiked Shield: Ironhide +1 Block.",
    "Spiked Shield: Counter 1.",
    "Double Tap, hit 1: 2 damage, doubled by Vulnerable, 1 blocked. Ironhide 14.",
    "Counter deals 1 to Pickers. Pickers 10.",
    "Double Tap, hit 2: 1 damage. Ironhide 13.",
    "Counter deals 1 to Pickers. Pickers 9.",
    "Double Tap, hit 3: 1 damage. Ironhide 12.",
    "Counter deals 1 to Pickers. Pickers 8.",
    "Double Tap, hit 4: 1 damage. Ironhide 11.",
    "Counter deals 1 to Pickers. Pickers 7.",
  ]);
});

test("a cancel names the opponent's card on that beat", () => {
  const cancelled = e(1, "Interrupt", "Quick", 1, "Cancelled", 1, "Hammer Blow", 0, 0, false, [A(15), B(15, 0, 0, 0)]);
  const kneecapPlans = [[id("Kneecap"), id("Double Tap")], [id("Hammer Blow"), id("Spiked Shield")]];
  assert.deepEqual(sentences([cancelled], { ...ctx, plans: kneecapPlans }), ["Kneecap cancels Hammer Blow."]);
});

test("a Parry that made its last cancel ends", () => {
  const ended = e(2, "Interrupt", "Normal", 1, "ParryEnded", 1, "Stone Guard", 0, 0, false, [A(15), B(15, 0, 0, 0)]);
  assert.deepEqual(sentences([ended], ctx), ["Stone Guard's Parry ends."]);
});

test("a gain of Strength names the gainer", () => {
  const gained = e(1, "Damage", "Normal", 1, "StrengthGained", 0, "Momentum", 1, 0, false, [{ ...A(15), strength: 1 }, B(15, 0, 0, 0)]);
  assert.deepEqual(sentences([gained], ctx), ["Momentum: Pickers +1 Strength."]);
});

test("a single-hit card gets no hit number", () => {
  assert.equal(sentences(events, ctx)[1], "Hammer Blow: 4 damage. Pickers 11.");
});

test("sideNames uses clan names, or player names in a mirror", () => {
  assert.deepEqual(sideNames(["Pickers", "Ironhide"], "hotseat"), ["Pickers", "Ironhide"]);
  assert.deepEqual(sideNames(["Pickers", "Pickers"], "hotseat"), ["Player 1", "Player 2"]);
  assert.deepEqual(sideNames(["Ironhide", "Ironhide"], "bot"), ["You", "Bot"]);
});

test("matchLog prints each round's plans, sentences and HP, then the result", () => {
  const state = { round: 2, gnomes: [{ hp: 7, vulnerable: 0, strength: 0, spent: [] }, { hp: 11, vulnerable: 0, strength: 0, spent: [] }] };
  const rounds = [{ plans, events, state }];
  const text = matchLog(rounds, "b", { cards, names: ["Pickers", "Ironhide"] });
  assert.ok(text.startsWith("Round 1\nPickers: Chalk Dust, Double Tap\nIronhide: Hammer Blow, Spiked Shield\nChalk Dust: Ironhide is Vulnerable 1.\n"), text);
  assert.ok(text.endsWith("Counter deals 1 to Pickers. Pickers 7.\nPickers 7, Ironhide 11\n\nIronhide wins.\n"), text);
  assert.ok(matchLog(rounds, "draw", { cards, names: ["Pickers", "Ironhide"] }).endsWith("Draw.\n"));
  assert.ok(matchLog(rounds, "a", { cards, names: ["Pickers", "Ironhide"] }).endsWith("Pickers wins.\n"));
});
