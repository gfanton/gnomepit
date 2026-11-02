import test from "node:test";
import assert from "node:assert/strict";

import { nodeEngine } from "./engine-node.ts";
import { cards, pickers } from "./fixture.ts";
import { type Deck, deckSize, newDeck, rareOf, readiness, sitOutText, toggle } from "./deck.ts";

const engine = await nodeEngine();
const wholePool = (): Deck => ({ clan: "Pickers", picks: [...pickers.cards] });

// A first match should not wait on ten toggles: the deck opens ready to play.
test("a new deck is its clan's suggested eight, legal, Rare in, in pool order", () => {
  for (const clan of engine.clans) {
    const deck = newDeck(clan, engine.cards);
    assert.equal(deck.clan, clan.name);
    assert.equal(deck.picks.length, deckSize, clan.name);
    assert.ok(deck.picks.includes(rareOf(clan, engine.cards) ?? -1), clan.name);
    assert.deepEqual(
      deck.picks,
      clan.cards.filter((id) => deck.picks.includes(id)),
      clan.name,
    );
    assert.ok(engine.legalDeck({ clan: clan.name, deck: deck.picks }), clan.name);
  }
});

test("leaving two pool cards out makes a full deck that keeps the Rare", () => {
  const deck = [2, 3].reduce((d, id) => toggle(d, id, pickers, cards), wholePool());
  assert.equal(deck.picks.length, 8);
  assert.ok(deck.picks.includes(9));
});

test("a card left out goes back in its pool place", () => {
  const out = toggle(wholePool(), 4, pickers, cards);
  assert.deepEqual(out.picks, [2, 3, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(toggle(out, 4, pickers, cards).picks, pickers.cards);
});

test("the Rare cannot be left out", () => {
  const deck = wholePool();
  assert.deepEqual(toggle(deck, 9, pickers, cards), deck);
});

test("a card outside the pool leaves the deck unchanged", () => {
  const deck = wholePool();
  assert.deepEqual(toggle(deck, 12, pickers, cards), deck);
  assert.deepEqual(toggle(deck, 0, pickers, cards), deck);
});

test("readiness counts the cards still to leave out, or to put back", () => {
  const leave = (ids: number[]) => ids.reduce((d, id) => toggle(d, id, pickers, cards), wholePool());
  assert.equal(readiness(leave([])), "Leave out 2 more");
  assert.equal(readiness(leave([2])), "Leave out 1 more");
  assert.equal(readiness(leave([2, 3])), "Ready");
  assert.equal(readiness(leave([2, 3, 4])), "Put 1 back");
});

test("toggle returns a new deck and leaves its input unchanged", () => {
  const deck = wholePool();
  const next = toggle(deck, 2, pickers, cards);
  assert.notEqual(next, deck);
  assert.deepEqual(deck.picks, pickers.cards);
});

test("sitOutText names the pool cards left out, in pool order", () => {
  const leave = (ids: number[]) => ids.reduce((d, id) => toggle(d, id, pickers, cards), wholePool());
  assert.equal(sitOutText(wholePool(), pickers, cards), "");
  assert.equal(sitOutText(leave([4]), pickers, cards), "Sling Stone sits out");
  assert.equal(sitOutText(leave([4, 3]), pickers, cards), "Kneecap and Sling Stone sit out");
  assert.equal(sitOutText(leave([2, 3, 4]), pickers, cards), "Pickaxe Flurry, Kneecap and Sling Stone sit out");
});
