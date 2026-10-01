import test from "node:test";
import assert from "node:assert/strict";

import { cards, ironhide, id } from "./fixture.mjs";
import { unseen, spentIn } from "./table.mjs";

test("unseen lists the pack cards not yet spent, cheapest first", () => {
  const spent = [id("Hammer Blow"), id("Spiked Shield")];
  assert.deepEqual(
    unseen(ironhide.cards, spent, cards).map((i) => cards[i].name),
    ["Cobble Throw", "Avalanche", "Bulwark", "Anvil Stomp", "Feint", "Shield Catch", "Loose Timbers", "Stone Guard"],
  );
});

test("unseen is the whole pack when nothing was spent", () => {
  assert.equal(unseen(ironhide.cards, [], cards).length, 10);
});

const rounds = [
  { plans: [[id("Chalk Dust"), id("Double Tap")], [id("Hammer Blow"), id("Spiked Shield")]] },
  { plans: [[id("Pick"), id("Pick"), id("Kneecap")], [id("Bulwark"), id("Pick")]] },
];

test("spentIn names the round a side played a card in", () => {
  assert.equal(spentIn(rounds, 1, id("Spiked Shield")), 1);
  assert.equal(spentIn(rounds, 0, id("Kneecap")), 2);
});

test("spentIn is 0 for a card the side has not played", () => {
  assert.equal(spentIn(rounds, 0, id("Hammer Blow")), 0);
  assert.equal(spentIn([], 1, id("Hammer Blow")), 0);
});
