import test from "node:test";
import assert from "node:assert/strict";

import { cards, pickers } from "./fixture.ts";
import { newDeck, readiness, toggle } from "./deck.ts";

test("a new deck holds the clan's whole pool", () => {
  assert.deepEqual(newDeck(pickers), { clan: "Pickers", picks: pickers.cards });
});

test("leaving two pool cards out makes a full deck that keeps the Rare", () => {
  const deck = [2, 3].reduce((d, id) => toggle(d, id, pickers, cards), newDeck(pickers));
  assert.equal(deck.picks.length, 8);
  assert.ok(deck.picks.includes(9));
});

test("a card left out goes back in its pool place", () => {
  const out = toggle(newDeck(pickers), 4, pickers, cards);
  assert.deepEqual(out.picks, [2, 3, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(toggle(out, 4, pickers, cards).picks, pickers.cards);
});

test("the Rare cannot be left out", () => {
  const deck = newDeck(pickers);
  assert.deepEqual(toggle(deck, 9, pickers, cards), deck);
});

test("a card outside the pool leaves the deck unchanged", () => {
  const deck = newDeck(pickers);
  assert.deepEqual(toggle(deck, 12, pickers, cards), deck);
  assert.deepEqual(toggle(deck, 0, pickers, cards), deck);
});

test("readiness counts the cards still to leave out, or to put back", () => {
  const leave = (ids: number[]) => ids.reduce((d, id) => toggle(d, id, pickers, cards), newDeck(pickers));
  assert.equal(readiness(leave([])), "Leave out 2 more");
  assert.equal(readiness(leave([2])), "Leave out 1 more");
  assert.equal(readiness(leave([2, 3])), "Ready");
  assert.equal(readiness(leave([2, 3, 4])), "Put 1 back");
});

test("toggle returns a new deck and leaves its input unchanged", () => {
  const deck = newDeck(pickers);
  const next = toggle(deck, 2, pickers, cards);
  assert.notEqual(next, deck);
  assert.deepEqual(deck.picks, pickers.cards);
});
