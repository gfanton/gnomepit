import test from "node:test";
import assert from "node:assert/strict";

import { nodeEngine } from "./engine-node.mjs";
import { tutorialMatch } from "./tutorial.mjs";

const engine = await nodeEngine();
const g = () => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] });
const fresh = () => ({ round: 1, gnomes: [g(), g()] });

// play resolves each [a, b] pair of plans in turn from a fresh match.
function play(match, rounds) {
  let out = { state: fresh(), result: "ongoing" };
  for (const [a, b] of rounds) out = engine.resolve({ state: out.state, decks: match.decks, a, b });
  return out;
}

test("both guided decks are legal decks of their clans", () => {
  const m = tutorialMatch(engine);
  assert.equal(engine.legalDeck({ clan: "Pickers", deck: m.decks[0] }), true);
  assert.equal(engine.legalDeck({ clan: "Ironhide", deck: m.decks[1] }), true);
});

test("the rails rounds leave you at 13 and Ironhide at 10, then 9", () => {
  const m = tutorialMatch(engine);
  const one = play(m, [[m.rails[0], m.opponent[0]]]);
  assert.deepEqual(one.state.gnomes.map((g) => g.hp), [13, 10]);
  const two = play(m, [[m.rails[0], m.opponent[0]], [m.rails[1], m.opponent[1]]]);
  assert.deepEqual(two.state.gnomes.map((g) => g.hp), [13, 9]);
  assert.equal(two.result, "ongoing");
});

test("no legal round 3 plan loses the guided match", () => {
  const m = tutorialMatch(engine);
  const { state } = play(m, [[m.rails[0], m.opponent[0]], [m.rails[1], m.opponent[1]]]);
  const plans = engine.legalPlans({ state, side: 0, deck: m.decks[0] });
  assert.equal(plans.length, 60);
  for (const plan of plans) assert.notEqual(engine.resolve({ state, decks: m.decks, a: plan, b: m.opponent[2] }).result, "b");
});

test("a card name the engine does not know is refused", () => {
  const cards = engine.cards.filter((c) => c.name !== "Kneecap");
  assert.throws(() => tutorialMatch({ ...engine, cards }), /unknown card: Kneecap/);
});
