import test from "node:test";
import assert from "node:assert/strict";

import { cards, pickers } from "./fixture.mjs";
import { beatsUsed, canAdd, addCard, clearFrom, slots, isSealable } from "./plan.mjs";

const available = [0, 1, ...pickers.cards.filter((c) => c !== 10 && c !== 11)];

test("beatsUsed sums the costs of the plan's cards", () => {
  assert.equal(beatsUsed([], cards), 0);
  assert.equal(beatsUsed([0, 5], cards), 3);
});

test("canAdd refuses a card that does not fit the remaining beats", () => {
  assert.equal(canAdd([0, 0], 5, cards, available), false);
  assert.equal(canAdd([0, 0, 0], 0, cards, available), false);
});

test("canAdd refuses a special already in the plan", () => {
  assert.equal(canAdd([2], 2, cards, available), false);
});

test("canAdd refuses a special the player does not have", () => {
  assert.equal(canAdd([], 2, cards, [0, 1]), false);
  assert.equal(canAdd([], 0, cards, [0, 1]), true);
});

test("canAdd allows a basic any number of times", () => {
  assert.equal(canAdd([0, 0], 0, cards, available), true);
});

test("addCard appends when allowed and returns the same array when refused", () => {
  const plan = [0];
  assert.deepEqual(addCard(plan, 5, cards, available), [0, 5]);
  assert.deepEqual(plan, [0]);
  assert.equal(addCard(plan, 10, cards, available), plan);
});

test("clearFrom drops the card occupying a beat and every card after it", () => {
  assert.deepEqual(clearFrom([2, 5], 1, cards), [2]);
  assert.deepEqual(clearFrom([5, 2], 1, cards), []);
  assert.deepEqual(clearFrom([2, 5], 0, cards), []);
  assert.deepEqual(clearFrom([2, 5], 2, cards), [2]);
});

test("slots lays the plan's cards over the three beats", () => {
  assert.deepEqual(slots([2, 5], cards), [
    { cardId: 2, index: 0, lands: true },
    { cardId: 5, index: 1, lands: false },
    { cardId: 5, index: 1, lands: true },
  ]);
  assert.deepEqual(slots([0], cards), [{ cardId: 0, index: 0, lands: true }, null, null]);
  assert.deepEqual(slots([], cards), [null, null, null]);
});

test("isSealable is true only for a plan in the legal list, in order", () => {
  const legal = [[0, 0, 0], [0, 5]];
  assert.equal(isSealable([0, 5], legal), true);
  assert.equal(isSealable([5, 0], legal), false);
  assert.equal(isSealable([], legal), false);
});
