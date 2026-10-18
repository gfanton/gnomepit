import test from "node:test";
import assert from "node:assert/strict";

import { cards, pickers } from "./fixture.ts";
import { randomDeck, randomPlan } from "./bot.ts";

const isLegal = (deck: number[]) =>
  deck.length === 8 && new Set(deck).size === 8 && deck.includes(9) && deck.every((id) => pickers.cards.includes(id));

test("randomDeck draws the Rare and seven other pool cards, ascending", () => {
  const deck = randomDeck(pickers, cards, () => 0);
  assert.ok(isLegal(deck), deck.join(","));
  assert.deepEqual(
    deck,
    [...deck].sort((a, b) => a - b),
  );
});

test("every random deck is legal", () => {
  for (let i = 0; i < 200; i++) {
    const deck = randomDeck(pickers, cards, Math.random);
    assert.ok(isLegal(deck), deck.join(","));
  }
});

test("randomDeck reaches every pool card over many draws", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) randomDeck(pickers, cards, Math.random).forEach((id) => seen.add(id));
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    pickers.cards,
  );
});

test("randomPlan picks by the random number", () => {
  const plans = [
    [0, 0, 0],
    [0, 5],
  ];
  assert.deepEqual(
    randomPlan(plans, () => 0),
    [0, 0, 0],
  );
  assert.deepEqual(
    randomPlan(plans, () => 0.99),
    [0, 5],
  );
});
