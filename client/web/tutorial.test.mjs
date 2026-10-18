import test from "node:test";
import assert from "node:assert/strict";

import { nodeEngine } from "./engine-node.ts";
import { afterFiniteAnimations, coach, lessonsFor, railsNext, tutorialMatch, tutorialMemory } from "./tutorial.mjs";

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
  assert.deepEqual(
    one.state.gnomes.map((g) => g.hp),
    [13, 10],
  );
  const two = play(m, [
    [m.rails[0], m.opponent[0]],
    [m.rails[1], m.opponent[1]],
  ]);
  assert.deepEqual(
    two.state.gnomes.map((g) => g.hp),
    [13, 9],
  );
  assert.equal(two.result, "ongoing");
});

test("no legal round 3 plan loses the guided match", () => {
  const m = tutorialMatch(engine);
  const { state } = play(m, [
    [m.rails[0], m.opponent[0]],
    [m.rails[1], m.opponent[1]],
  ]);
  const plans = engine.legalPlans({ state, side: 0, deck: m.decks[0] });
  assert.equal(plans.length, 60);
  for (const plan of plans)
    assert.notEqual(engine.resolve({ state, decks: m.decks, a: plan, b: m.opponent[2] }).result, "b");
});

test("a card name the engine does not know is refused", () => {
  const cards = engine.cards.filter((c) => c.name !== "Kneecap");
  assert.throws(() => tutorialMatch({ ...engine, cards }), /unknown card: Kneecap/);
});

test("the rails offer the next card while the plan follows them", () => {
  assert.equal(railsNext([4, 6, 3], []), 4);
  assert.equal(railsNext([4, 6, 3], [4]), 6);
  assert.equal(railsNext([4, 6, 3], [4, 6, 3]), undefined);
  assert.equal(railsNext([4, 6, 3], [6]), undefined);
  assert.equal(railsNext(null, []), undefined);
});

test("each lesson shows once, at the first event it names", () => {
  const m = tutorialMatch(engine);
  const { events } = engine.resolve({ state: fresh(), decks: m.decks, a: m.rails[0], b: m.opponent[0] });
  const lessons = lessonsFor(1, events, engine.cards);
  assert.deepEqual(
    lessons.map((l) => l.text),
    coach.lessons.filter((l) => l.round === 1).map((l) => l.text),
  );
  assert.ok(lessons.every((l, i) => i === 0 || l.at > lessons[i - 1].at));
  assert.equal(events[lessons[0].at].kind, "Cancelled");
});

test("round 2 teaches Block then Parry, and round 3 teaches Counter", () => {
  const m = tutorialMatch(engine);
  const one = engine.resolve({ state: fresh(), decks: m.decks, a: m.rails[0], b: m.opponent[0] });
  const two = engine.resolve({ state: one.state, decks: m.decks, a: m.rails[1], b: m.opponent[1] });
  assert.deepEqual(
    lessonsFor(2, two.events, engine.cards).map((l) => l.text),
    coach.lessons.filter((l) => l.round === 2).map((l) => l.text),
  );
  const best = ["Undermine", "Boot and Heel"].map((name) => engine.cards.find((c) => c.name === name).id);
  const three = engine.resolve({ state: two.state, decks: m.decks, a: best, b: m.opponent[2] });
  const counter = lessonsFor(3, three.events, engine.cards);
  assert.deepEqual(
    counter.map((l) => l.text),
    coach.lessons.filter((l) => l.round === 3).map((l) => l.text),
  );
  // The lesson describes damage dealt back, so it waits for the first hit Counter answers.
  assert.equal(three.events[counter[0].at].kind, "CounterHit");
});

test("each rails round has one coach step per rails card", () => {
  const m = tutorialMatch(engine);
  m.rails.forEach((rails, i) => {
    if (rails !== null) assert.equal(coach.rounds[i].steps.length, rails.length);
  });
});

test("round 3's hint leaves Ironhide's plan for the player to work out", () => {
  const m = tutorialMatch(engine);
  for (const id of m.opponent[2]) assert.doesNotMatch(coach.rounds[2].hint, new RegExp(engine.cards[id].name));
  assert.match(coach.rounds[2].hint, /cards/);
});

test("a lesson whose event does not happen is skipped", () => {
  const m = tutorialMatch(engine);
  const pick = engine.cards.find((c) => c.name === "Pick").id;
  const { events } = engine.resolve({ state: fresh(), decks: m.decks, a: [pick, pick, pick], b: m.opponent[0] });
  assert.deepEqual(lessonsFor(1, events, engine.cards), []);
});

test("the flag reads done or skipped from storage", () => {
  const items = new Map();
  const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  assert.equal(tutorialMemory(storage).seen(), false);
  tutorialMemory(storage).remember("skipped");
  assert.equal(items.get("gnomehall:tutorial"), "skipped");
  assert.equal(tutorialMemory(storage).seen(), true);
  assert.equal(tutorialMemory(undefined).seen(), false);
});

test("storage that throws keeps the answer for the rest of the visit only", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const flag = tutorialMemory(broken);
  assert.equal(flag.seen(), false);
  assert.doesNotThrow(() => flag.remember("skipped"));
  assert.equal(flag.seen(), true);
  assert.equal(tutorialMemory(broken).seen(), false);
});

test("waiting on animations ignores the ones that never end", async () => {
  const endless = { effect: { getTiming: () => ({ iterations: Infinity }) }, finished: new Promise(() => {}) };
  let end;
  const once = {
    effect: { getTiming: () => ({ iterations: 1 }) },
    finished: new Promise((r) => {
      end = r;
    }),
  };
  let done = false;
  void afterFiniteAnimations([endless, once]).then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  end();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(done, true);
  await afterFiniteAnimations([]);
  await afterFiniteAnimations([endless]);
});
