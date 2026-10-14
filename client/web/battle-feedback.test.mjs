import test from "node:test";
import assert from "node:assert/strict";
import { stepFeedback } from "./battle-feedback.mjs";

test("a fully blocked hit has shield feedback without HP damage", () => {
  const f = stepFeedback([{ kind: "HitLanded", side: 0, n: 0, blocked: 3 }]);
  assert.equal(f.sides[1].damage, 0);
  assert.equal(f.sides[1].blocked, 3);
  assert.deepEqual(f.attackers, [0]);
});

test("simultaneous hits and counter damage reach the correct fighter", () => {
  const f = stepFeedback([
    { kind: "HitLanded", side: 0, n: 2, blocked: 1 },
    { kind: "HitLanded", side: 1, n: 3, blocked: 0 },
    { kind: "CounterHit", side: 0, n: 1, blocked: 2 },
  ]);
  assert.equal(f.sides[0].damage, 4);
  assert.equal(f.sides[0].blocked, 2);
  assert.equal(f.sides[1].damage, 2);
  assert.equal(f.sides[1].blocked, 1);
  assert.deepEqual(f.attackers, [0, 1]);
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
