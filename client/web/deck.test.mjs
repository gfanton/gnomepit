import test from "node:test";
import assert from "node:assert/strict";

import { cards, pickers } from "./fixture.ts";
import { newDeck, toggle } from "./deck.mjs";

const others = [2, 3, 4, 5, 6, 7, 8];

test("a new deck holds the clan's Rare", () => {
  assert.deepEqual(newDeck(pickers, cards), { clan: "Pickers", picks: [9] });
});

test("toggling seven other pool cards fills the deck", () => {
  const deck = others.reduce((d, id) => toggle(d, id, pickers, cards), newDeck(pickers, cards));
  assert.equal(deck.picks.length, 8);
  assert.ok(deck.picks.includes(9));
});

test("a ninth card leaves a full deck unchanged", () => {
  const full = others.reduce((d, id) => toggle(d, id, pickers, cards), newDeck(pickers, cards));
  assert.deepEqual(toggle(full, 10, pickers, cards), full);
});

test("the Rare cannot be removed", () => {
  const deck = newDeck(pickers, cards);
  assert.deepEqual(toggle(deck, 9, pickers, cards), deck);
});

test("a card outside the pool leaves the deck unchanged", () => {
  const deck = newDeck(pickers, cards);
  assert.deepEqual(toggle(deck, 12, pickers, cards), deck);
  assert.deepEqual(toggle(deck, 0, pickers, cards), deck);
});

test("toggling a picked card removes it", () => {
  const deck = toggle(newDeck(pickers, cards), 2, pickers, cards);
  assert.deepEqual(deck.picks, [9, 2]);
  assert.deepEqual(toggle(deck, 2, pickers, cards).picks, [9]);
});

test("toggle returns a new deck and leaves its input unchanged", () => {
  const deck = newDeck(pickers, cards);
  const next = toggle(deck, 2, pickers, cards);
  assert.notEqual(next, deck);
  assert.deepEqual(deck.picks, [9]);
});
