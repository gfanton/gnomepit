import test from "node:test";
import assert from "node:assert/strict";

import { cards, ironhide, id } from "./fixture.mjs";
import { knownCards, spentIn } from "./table.mjs";

const deck = [
  id("Stone Guard"),
  id("Bulwark"),
  id("Hammer Blow"),
  id("Cobble Throw"),
  id("Spiked Shield"),
  id("Anvil Stomp"),
  id("Feint"),
  id("Avalanche"),
];

test("before the first reveal, a side knows the other's clan pool, not its deck", () => {
  const known = knownCards([], 1, ironhide.cards, deck, cards);
  assert.equal(known.open, false);
  assert.deepEqual(
    known.cards.map((c) => [cards[c.id].name, c.spentRound]),
    [
      ["Cobble Throw", 0],
      ["Spiked Shield", 0],
      ["Avalanche", 0],
      ["Bulwark", 0],
      ["Hammer Blow", 0],
      ["Anvil Stomp", 0],
      ["Feint", 0],
      ["Shield Catch", 0],
      ["Loose Timbers", 0],
      ["Stone Guard", 0],
    ],
  );
});

test("after a reveal, the deck is open with each spent card marked by its round", () => {
  const rounds = [
    {
      plans: [
        [id("Pick"), id("Pick"), id("Pick")],
        [id("Hammer Blow"), id("Spiked Shield")],
      ],
    },
  ];
  const known = knownCards(rounds, 1, ironhide.cards, deck, cards);
  assert.equal(known.open, true);
  assert.deepEqual(
    known.cards.map((c) => [cards[c.id].name, c.spentRound]),
    [
      ["Cobble Throw", 0],
      ["Spiked Shield", 1],
      ["Avalanche", 0],
      ["Bulwark", 0],
      ["Hammer Blow", 1],
      ["Anvil Stomp", 0],
      ["Feint", 0],
      ["Stone Guard", 0],
    ],
  );
});

const rounds = [
  {
    plans: [
      [id("Chalk Dust"), id("Double Tap")],
      [id("Hammer Blow"), id("Spiked Shield")],
    ],
  },
  {
    plans: [
      [id("Pick"), id("Pick"), id("Kneecap")],
      [id("Bulwark"), id("Pick")],
    ],
  },
];

test("spentIn names the round a side played a card in", () => {
  assert.equal(spentIn(rounds, 1, id("Spiked Shield")), 1);
  assert.equal(spentIn(rounds, 0, id("Kneecap")), 2);
});

test("spentIn is 0 for a card the side has not played", () => {
  assert.equal(spentIn(rounds, 0, id("Hammer Blow")), 0);
  assert.equal(spentIn([], 1, id("Hammer Blow")), 0);
});
