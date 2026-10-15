// The rule words a card text or a badge can carry, each with the one-paragraph rule a tip
// shows for it. Keys are the data-kw values the page marks up.

export const glossary = {
  interrupt:
    "In the Interrupt phase, if the opponent is winding up a card (one that lands on a later beat), that card is cancelled. A Parry card never winds up, so Interrupt cannot cancel it. The Interrupt card's other effects still resolve in their phases.",
  parry:
    "Parry N is active on every beat the card occupies. On each of those beats, an opponent attack that lands is cancelled. After N cancels the Parry ends and the card's later beats stay empty. Its other effects resolve on its last beat, unless the Parry ended before.",
  block: "Block absorbs damage point for point and is used up by what it absorbs. It lasts until the end of the round.",
  counter:
    "Counter N: until the end of the round, each opponent hit that lands on you, blocked or not, deals N damage back in the same step. Block reduces that damage; Strength and Vulnerable do not change it.",
  vulnerable:
    "Vulnerable N: each of the next N hits against the gnome deals double damage and removes one token, blocked or not. Tokens carry over to the next round.",
  strength: "Strength adds 1 damage to each hit the gnome deals, until the end of the round.",
  cancel: "A cancelled card is spent and has no effect, and its remaining beats stay empty. Any \"if cancelled\" text on it resolves this beat.",
  quick: "The card's effects resolve in the first tier of each phase, before Normal and Slow cards.",
  slow: "The card's effects resolve in the last tier of each phase, after Quick and Normal cards.",
  rare: "The clan's signature card. Every deck of the clan holds it.",
};

const forms = { cancelled: "cancel", cancels: "cancel" };
const words = /\b(Interrupt|Parry|Block|Counter|Vulnerable|Strength|cancelled|cancels)\b/g;

// markKeywords turns a card text into HTML with each rule word wrapped in a tip anchor.
export function markKeywords(text) {
  return escapeHTML(text).replace(words, (word) => `<span class="kw" data-kw="${forms[word] ?? word.toLowerCase()}">${word}</span>`);
}

export function escapeHTML(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
