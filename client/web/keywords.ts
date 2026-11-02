// The rule words a card text or a badge can carry, each with the one-paragraph rule a tip
// shows for it. Keys are the data-kw values the page marks up.

import type { Card } from "./engine.ts";

export const glossary = {
  interrupt:
    "Interrupt cancels the opponent's card if that card is still winding up on this beat. A card that fills 2 or 3 beats winds up on each beat before its last and lands on the last one. So an Interrupt never catches a 1-beat card or a Parry card, and catches nothing on beat 3. The Interrupt card's other effects still happen.",
  parry:
    "Parry N guards every beat the card fills: an opponent attack that lands on one of those beats is cancelled. After N cancels the Parry is done, and the card's remaining beats stay empty. Its other effects happen on its last beat, unless the Parry ran out on an earlier beat. An Interrupt never cancels a Parry card.",
  block: "Block soaks up damage point for point and is used up by what it soaks. It lasts until the end of the round.",
  counter:
    "Counter N: until the end of the round, each hit this gnome takes, blocked or not, deals N damage back to the attacker at once. The attacker's Block soaks it; Strength and Vulnerable don't change it.",
  vulnerable:
    "Vulnerable N: the next N hits this gnome takes deal double damage, blocked or not, and each uses up one Vulnerable. Unused Vulnerable carries over to the next round.",
  strength: "Strength adds 1 damage to each hit this gnome deals, until the end of the round.",
  cancel:
    'A cancelled card is spent and does nothing, and its remaining beats stay empty. Any "if cancelled" text on it happens on that beat.',
  quick:
    "Quick cards act first on their beat: they cancel and hit before Normal and Slow cards. A Quick hit that drops a gnome to 0 HP ends the match before slower hits land.",
  slow: "Slow cards act last on their beat: they cancel and hit after Quick and Normal cards.",
  rare: "The Rare is the clan's signature card. Every deck of the clan holds it.",
};

const forms: Record<string, string> = { cancelled: "cancel", cancels: "cancel" };
const words = /\b(Interrupt|Parry|Block|Counter|Vulnerable|Strength|cancelled|cancels)\b/g;

// markKeywords turns a card text into HTML with each rule word wrapped in a tip anchor. Focusable
// anchors take keyboard focus; a card that is itself a button keeps them out, since a button
// may hold no focusable content.
export function markKeywords(text: string, { focusable = false } = {}): string {
  return escapeHTML(text).replace(
    words,
    (word) =>
      `<span class="kw" data-kw="${keyOf(word)}"${focusable ? ` tabindex="0" aria-describedby="rule-${keyOf(word)}"` : ""}>${word}</span>`,
  );
}

function keyOf(word: string): string {
  return forms[word] ?? word.toLowerCase();
}

// rulesHTML is every rule, hidden, each under the id a keyword's aria-describedby names.
export function rulesHTML(): string {
  return `<div hidden>${Object.entries(glossary)
    .map(([key, rule]) => `<p id="rule-${key}">${escapeHTML(rule)}</p>`)
    .join("")}</div>`;
}

// ruleRefs is the aria-describedby value for a card: the rule of its tier and Rare badges, then
// of each rule word in its text, once each; empty when it carries none.
export function ruleRefs(card: Pick<Card, "tier" | "rare" | "text">): string {
  const keys = [
    ...(card.tier === "Normal" ? [] : [card.tier.toLowerCase()]),
    ...(card.rare ? ["rare"] : []),
    ...Array.from(card.text.matchAll(words), ([word]) => keyOf(word)),
  ];
  return [...new Set(keys)].map((key) => `rule-${key}`).join(" ");
}

export function escapeHTML(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

// counted is n of a thing, with its noun plural for any n but one.
export function counted(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}
