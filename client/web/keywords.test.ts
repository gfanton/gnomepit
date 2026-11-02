import test from "node:test";
import assert from "node:assert/strict";

import { glossary, markKeywords, escapeHTML, counted, rulesHTML, ruleRefs } from "./keywords.ts";

const kw = (key: string, word: string) => `<span class="kw" data-kw="${key}">${word}</span>`;

test("markKeywords wraps each rule word in a span naming its glossary entry", () => {
  assert.equal(
    markKeywords("Gain 1 Block. Counter 1."),
    `Gain 1 ${kw("block", "Block")}. ${kw("counter", "Counter")} 1.`,
  );
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

test("focusable keywords take keyboard focus, so their tip opens without a mouse", () => {
  assert.equal(
    markKeywords("Gain 1 Block.", { focusable: true }),
    `Gain 1 <span class="kw" data-kw="block" tabindex="0" aria-describedby="rule-block">Block</span>.`,
  );
});

// The tip is drawn for sighted players only; a screen reader hears the rule as the word's description.
test("rulesHTML holds every rule, hidden, under the id a keyword points to", () => {
  const html = rulesHTML();
  assert.match(html, /^<div hidden>/);
  for (const [key, rule] of Object.entries(glossary))
    assert.ok(html.includes(`<p id="rule-${key}">${escapeHTML(rule)}</p>`), key);
});

test("ruleRefs names the rule of each badge and rule word a card carries, once each", () => {
  assert.equal(
    ruleRefs({ tier: "Quick", rare: true, text: "Interrupt. If this cancels a card, apply 2 Vulnerable." }),
    "rule-quick rule-rare rule-interrupt rule-cancel rule-vulnerable",
  );
  assert.equal(ruleRefs({ tier: "Normal", rare: false, text: "Gain 1 Block. Gain 1 Block." }), "rule-block");
  assert.equal(ruleRefs({ tier: "Normal", rare: false, text: "Deal 1 damage." }), "");
});

test("the tips speak in table terms, not the engine's", () => {
  for (const [key, rule] of Object.entries(glossary))
    assert.doesNotMatch(rule, /\b(tier|phase|resolves?|step)\b/i, key);
});

// A card's description strings several rules together, so each must say which word it explains.
test("each tip names its own rule word in its opening words", () => {
  const words: Record<string, string> = { cancel: "cancelled" };
  for (const [key, rule] of Object.entries(glossary))
    assert.ok(
      rule
        .toLowerCase()
        .slice(0, 24)
        .includes(words[key] ?? key),
      `${key}: ${rule}`,
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
  assert.match(glossary.interrupt, /never catches a 1-beat card or a Parry card/);
});

test("every key the markup and the badges use has a glossary entry", () => {
  for (const key of [
    "interrupt",
    "parry",
    "block",
    "counter",
    "vulnerable",
    "strength",
    "cancel",
    "quick",
    "slow",
    "rare",
  ] as const) {
    assert.equal(typeof glossary[key], "string", key);
    assert.ok(glossary[key].length > 0, key);
  }
});

test("counted names one of a thing in the singular and any other number in the plural", () => {
  assert.equal(counted(1, "beat"), "1 beat");
  assert.equal(counted(2, "beat"), "2 beats");
  assert.equal(counted(0, "card"), "0 cards");
});
