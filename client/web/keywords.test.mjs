import test from "node:test";
import assert from "node:assert/strict";

import { glossary, markKeywords, escapeHTML } from "./keywords.mjs";

const kw = (key, word) => `<span class="kw" data-kw="${key}">${word}</span>`;

test("markKeywords wraps each rule word in a span naming its glossary entry", () => {
  assert.equal(markKeywords("Gain 1 Block. Counter 1."), `Gain 1 ${kw("block", "Block")}. ${kw("counter", "Counter")} 1.`);
  assert.equal(markKeywords("Parry 2."), `${kw("parry", "Parry")} 2.`);
  assert.equal(markKeywords("Gain 1 Strength."), `Gain 1 ${kw("strength", "Strength")}.`);
});

test("markKeywords maps every form of cancel to one entry", () => {
  assert.equal(
    markKeywords("Interrupt. If this cancels a card, apply 2 Vulnerable."),
    `${kw("interrupt", "Interrupt")}. If this ${kw("cancel", "cancels")} a card, apply 2 ${kw("vulnerable", "Vulnerable")}.`,
  );
  assert.equal(
    markKeywords("If this card is cancelled, gain 4 Block. Otherwise, deal 4 damage."),
    `If this card is ${kw("cancel", "cancelled")}, gain 4 ${kw("block", "Block")}. Otherwise, deal 4 damage.`,
  );
});

test("markKeywords leaves a word that merely contains a keyword alone", () => {
  assert.equal(markKeywords("Blockade counters."), "Blockade counters.");
});

test("markKeywords escapes the text before adding markup", () => {
  assert.equal(markKeywords("a < b & Block"), `a &lt; b &amp; ${kw("block", "Block")}`);
  assert.equal(escapeHTML("<b>&</b>"), "&lt;b>&amp;&lt;/b>");
});

// A Parry card covers beats before its last, which the Interrupt rule alone reads as winding up.
test("the Interrupt tip says a Parry card cannot be interrupted", () => {
  assert.match(glossary.interrupt, /Parry cards never wind up, so an Interrupt never catches them/);
});

test("every key the markup and the badges use has a glossary entry", () => {
  for (const key of ["interrupt", "parry", "block", "counter", "vulnerable", "strength", "cancel", "quick", "slow", "rare"]) {
    assert.equal(typeof glossary[key], "string", key);
    assert.ok(glossary[key].length > 0, key);
  }
});
