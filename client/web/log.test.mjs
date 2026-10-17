import test from "node:test";
import assert from "node:assert/strict";

import { cards, id } from "./fixture.mjs";
import { sentences, matchLog, sideNames, possessive } from "./log.mjs";

const A = (hp) => ({ hp, block: 0, counter: 0, vulnerable: 0, strength: 0 });
const B = (hp, block, counter, vulnerable) => ({ hp, block, counter, vulnerable, strength: 0 });
const e = (beat, phase, tier, step, kind, side, card, n, blocked, doubled, after) => ({
  beat,
  phase,
  tier,
  step,
  kind,
  side,
  card: id(card),
  n,
  blocked,
  doubled,
  after,
});

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
const plans = [
  [id("Chalk Dust"), id("Double Tap")],
  [id("Hammer Blow"), id("Spiked Shield")],
];
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
  const kneecapPlans = [
    [id("Kneecap"), id("Double Tap")],
    [id("Hammer Blow"), id("Spiked Shield")],
  ];
  assert.deepEqual(sentences([cancelled], { ...ctx, plans: kneecapPlans }), ["Kneecap cancels Hammer Blow."]);
});

test("a Parry that made its last cancel ends", () => {
  const ended = e(2, "Interrupt", "Normal", 1, "ParryEnded", 1, "Stone Guard", 0, 0, false, [A(15), B(15, 0, 0, 0)]);
  assert.deepEqual(sentences([ended], ctx), ["Stone Guard's Parry ends."]);
});

test("a gain of Strength names the gainer", () => {
  const gained = e(1, "Damage", "Normal", 1, "StrengthGained", 0, "Momentum", 1, 0, false, [
    { ...A(15), strength: 1 },
    B(15, 0, 0, 0),
  ]);
  assert.deepEqual(sentences([gained], ctx), ["Momentum: Pickers +1 Strength."]);
});

const delversCtx = { cards, names: ["Delvers", "Ironhide"], plans };

test("Vulnerable a gnome gives itself names the gnome and its tokens", () => {
  const gained = e(1, "Damage", "Normal", 2, "VulnerableGained", 0, "Overdig", 1, 0, false, [
    B(15, 0, 0, 2),
    B(9, 0, 0, 0),
  ]);
  assert.deepEqual(sentences([gained], delversCtx), ["Overdig: Delvers is Vulnerable 2."]);
});

test("a Vulnerable move names the tokens moved and the receiver's total", () => {
  const moved = e(2, "Block", "Normal", 1, "VulnerableMoved", 0, "Blowback", 2, 0, false, [A(11), B(13, 0, 0, 3)]);
  assert.deepEqual(sentences([moved], delversCtx), [
    "Blowback: Delvers moves 2 Vulnerable to Ironhide, who is Vulnerable 3.",
  ]);
});

test("stripped Block names what the opponent lost", () => {
  const stripped = e(3, "Damage", "Slow", 1, "BlockStripped", 0, "Cave-In", 5, 0, false, [A(15), B(15, 0, 0, 0)]);
  assert.deepEqual(sentences([stripped], delversCtx), ["Cave-In: Ironhide loses 5 Block."]);
});

test("a move or a strip with nothing to take says so", () => {
  const moved = e(2, "Block", "Normal", 1, "VulnerableMoved", 0, "Blowback", 0, 0, false, [A(11), A(13)]);
  const stripped = e(3, "Damage", "Slow", 1, "BlockStripped", 0, "Cave-In", 0, 0, false, [A(15), A(15)]);
  assert.deepEqual(sentences([moved, stripped], delversCtx), [
    "Blowback: Delvers has no Vulnerable to move.",
    "Cave-In: Ironhide has no Block to lose.",
  ]);
});

test("a sentence about You takes the verb You takes", () => {
  const mirrorCtx = { cards, names: ["You", "Bot"], plans };
  const ev = (kind, side, card, n) =>
    e(1, "Damage", "Normal", 1, kind, side, card, n, 0, false, [B(15, 0, 0, 2), B(15, 0, 0, 2)]);
  const events = [
    ev("VulnerableApplied", 1, "Chalk Dust", 1),
    ev("VulnerableGained", 0, "Overdig", 1),
    ev("VulnerableMoved", 0, "Blowback", 0),
    ev("VulnerableMoved", 0, "Blowback", 2),
    ev("VulnerableMoved", 1, "Blowback", 2),
    ev("BlockStripped", 1, "Cave-In", 0),
    ev("BlockStripped", 1, "Cave-In", 3),
  ];
  assert.deepEqual(sentences(events, mirrorCtx), [
    "Chalk Dust: You are Vulnerable 2.",
    "Overdig: You are Vulnerable 2.",
    "Blowback: You have no Vulnerable to move.",
    "Blowback: You move 2 Vulnerable to Bot, who is Vulnerable 2.",
    "Blowback: Bot moves 2 Vulnerable to You, who are Vulnerable 2.",
    "Cave-In: You have no Block to lose.",
    "Cave-In: You lose 3 Block.",
  ]);
});

test("a single-hit card gets no hit number", () => {
  assert.equal(sentences(events, ctx)[1], "Hammer Blow: 4 damage. Pickers 11.");
});

test("the same basic played twice in a round counts hits per beat", () => {
  const picks = [
    e(1, "Damage", "Normal", 1, "HitLanded", 0, "Pick", 1, 0, false, [A(15), B(14, 0, 0, 0)]),
    e(2, "Damage", "Normal", 1, "HitLanded", 0, "Pick", 1, 0, false, [A(15), B(13, 0, 0, 0)]),
  ];
  const pickPlans = [
    [id("Pick"), id("Pick"), id("Sling Stone")],
    [id("Brace"), id("Brace"), id("Brace")],
  ];
  assert.deepEqual(sentences(picks, { ...ctx, plans: pickPlans }), [
    "Pick: 1 damage. Ironhide 14.",
    "Pick: 1 damage. Ironhide 13.",
  ]);
});

test("sideNames uses clan names, or player names in a mirror", () => {
  assert.deepEqual(sideNames(["Pickers", "Ironhide"], "hotseat"), ["Pickers", "Ironhide"]);
  assert.deepEqual(sideNames(["Pickers", "Pickers"], "hotseat"), ["Player 1", "Player 2"]);
  assert.deepEqual(sideNames(["Ironhide", "Ironhide"], "bot"), ["You", "Bot"]);
});

test("possessive reads naturally for every side name", () => {
  assert.deepEqual(["You", "Bot", "Player 1", "Pickers", "Ironhide"].map(possessive), [
    "Your",
    "Bot's",
    "Player 1's",
    "Pickers'",
    "Ironhide's",
  ]);
});

test("matchLog prints each round's plans, sentences and HP, then the result", () => {
  const state = {
    round: 2,
    gnomes: [
      { hp: 7, vulnerable: 0, strength: 0, spent: [] },
      { hp: 11, vulnerable: 0, strength: 0, spent: [] },
    ],
  };
  const rounds = [{ plans, events, state }];
  const text = matchLog(rounds, "b", { cards, names: ["Pickers", "Ironhide"] });
  assert.ok(
    text.startsWith(
      "Round 1\nPickers: Chalk Dust, Double Tap\nIronhide: Hammer Blow, Spiked Shield\nChalk Dust: Ironhide is Vulnerable 1.\n",
    ),
    text,
  );
  assert.ok(
    text.endsWith("Counter deals 1 to Pickers. Pickers 7.\nPickers 7, Ironhide 11\n\nWinner: Ironhide.\n"),
    text,
  );
  assert.ok(matchLog(rounds, "draw", { cards, names: ["Pickers", "Ironhide"] }).endsWith("Draw.\n"));
  assert.ok(matchLog(rounds, "a", { cards, names: ["Pickers", "Ironhide"] }).endsWith("Winner: Pickers.\n"));
});

test("the guided match calls you You and the opponent by its clan", () => {
  assert.deepEqual(sideNames(["Pickers", "Ironhide"], "tutorial"), ["You", "Ironhide"]);
});
