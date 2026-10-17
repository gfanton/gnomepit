import test from "node:test";
import assert from "node:assert/strict";
import { cards, id } from "./fixture.mjs";
import { stepFeedback, cardBehind } from "./battle-feedback.mjs";

test("a fully blocked hit has shield feedback without HP damage", () => {
  const f = stepFeedback([{ kind: "HitLanded", side: 0, n: 0, blocked: 3 }]);
  assert.equal(f.sides[1].damage, 0);
  assert.equal(f.sides[1].blocked, 3);
});

test("simultaneous hits and counter damage reach the correct fighter", () => {
  const f = stepFeedback([
    { kind: "HitLanded", side: 0, n: 2, blocked: 1 },
    { kind: "HitLanded", side: 1, n: 3, blocked: 0 },
    { kind: "CounterHit", side: 0, n: 1, blocked: 0 },
  ]);
  assert.equal(f.sides[0].damage, 4);
  assert.equal(f.sides[0].blocked, 0);
  assert.equal(f.sides[1].damage, 2);
  assert.equal(f.sides[1].blocked, 1);
});

test("status gains and cancellations retain their side and beat", () => {
  const f = stepFeedback([
    { kind: "BlockGained", side: 0, n: 5 },
    { kind: "CounterGained", side: 0, n: 1 },
    { kind: "StrengthGained", side: 1, n: 1 },
    { kind: "VulnerableApplied", side: 0, n: 2 },
    { kind: "Cancelled", side: 1, card: 4, beat: 2, n: 0 },
  ]);
  assert.equal(f.sides[0].block, 5);
  assert.equal(f.sides[0].counter, 1);
  assert.equal(f.sides[1].strength, 1);
  assert.equal(f.sides[1].vulnerable, 2);
  assert.deepEqual(f.cancelled, [{ side: 1, card: 4, beat: 2 }]);
});

test("self-given, moved and stripped tokens reach the gnome they change", () => {
  const gained = stepFeedback([{ kind: "VulnerableGained", side: 0, n: 1 }]);
  assert.equal(gained.sides[0].vulnerable, 1);
  const moved = stepFeedback([{ kind: "VulnerableMoved", side: 0, n: 2 }]);
  assert.equal(moved.sides[0].vulnerable, -2);
  assert.equal(moved.sides[1].vulnerable, 2);
  const stripped = stepFeedback([{ kind: "BlockStripped", side: 0, n: 5 }]);
  assert.equal(stripped.sides[1].block, -5);
  assert.equal(stripped.sides[0].block, 0);
});

// Kneecap on beat 2 cancels Bulwark, which spans beats 1 and 2.
const plans = [[id("Pick"), id("Kneecap"), id("Pick")], [id("Bulwark"), id("Brace")]];

test("the card behind a cancellation is the opponent's card on that beat", () => {
  const ev = { kind: "Cancelled", side: 1, card: id("Bulwark"), beat: 2, n: 0 };
  assert.deepEqual(cardBehind(ev, plans, cards), { side: 0, index: 1 });
});

test("the card behind any other event is its own side's card on that beat", () => {
  assert.deepEqual(cardBehind({ kind: "HitLanded", side: 0, card: id("Pick"), beat: 3, n: 1 }, plans, cards), { side: 0, index: 2 });
  assert.deepEqual(cardBehind({ kind: "BlockGained", side: 1, card: id("Brace"), beat: 3, n: 1 }, plans, cards), { side: 1, index: 1 });
});
