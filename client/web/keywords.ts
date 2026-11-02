// The rule words a card text or a badge can carry, each with the one-paragraph rule a tip
// shows for it. Keys are the data-kw values the page marks up.

export const glossary = {
  interrupt:
    "Cancels the opponent's card if it is winding up on this beat. A card winds up on every beat before its last: a 2-cost card on its first beat, a 3-cost card on its first two. 1-cost cards and Parry cards never wind up, so an Interrupt never catches them, and nothing winds up on beat 3. The Interrupt card's other effects still resolve.",
  parry:
    "Parry N is active on every beat the card occupies. On each of those beats, an opponent attack that lands is cancelled. After N cancels the Parry ends and the card's later beats stay empty. Its other effects resolve on its last beat, unless the Parry ended before. A Parry card never winds up, so no Interrupt can cancel it.",
  block: "Block absorbs damage point for point and is used up by what it absorbs. It lasts until the end of the round.",
  counter:
    "Counter N: until the end of the round, each opponent hit that lands on you, blocked or not, deals N damage back in the same step. Block reduces that damage; Strength and Vulnerable do not change it.",
  vulnerable:
    "Vulnerable N: each of the next N hits against the gnome deals double damage and removes one token, blocked or not. Tokens carry over to the next round.",
  strength: "Strength adds 1 damage to each hit the gnome deals, until the end of the round.",
  cancel:
    'A cancelled card is spent and has no effect, and its remaining beats stay empty. Any "if cancelled" text on it resolves this beat.',
  quick: "The card's effects resolve in the first tier of each phase, before Normal and Slow cards.",
  slow: "The card's effects resolve in the last tier of each phase, after Quick and Normal cards.",
  rare: "The clan's signature card. Every deck of the clan holds it.",
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
      `<span class="kw" data-kw="${forms[word] ?? word.toLowerCase()}"${focusable ? ' tabindex="0"' : ""}>${word}</span>`,
  );
}

export function escapeHTML(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
