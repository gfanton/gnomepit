// The guided first match: a ready Pickers deck against a scripted Ironhide, with the coach's
// words for each planning step and each lesson the playback stops on.

export const tutorialKey = "gnomehall:tutorial";

export const coach = {
  rounds: [
    { title: "Timing beats strength.", steps: [
      "Hammer Blow takes two beats, so on beat 1 it is only winding up. Kneecap is Quick and Interrupts: play it on beat 1 and the blow never lands.",
      "Chalk Dust makes Ironhide Vulnerable: the next hit against it deals double. Play it on beat 2.",
      "Now Sling Stone on beat 3. Its 2 damage lands doubled.",
    ], seal: "Three beats filled. Seal your plan: both plans are revealed together and play out beat by beat." },
    { title: "Read their deck.", steps: [
      "From round 2 both decks are open: Opponent & history shows all eight of Ironhide's cards. Bulwark lands on beat 2 with 5 Block, so hit first: play Pick on beat 1. Pick and Brace never run out.",
      "Avalanche deals damage equal to Ironhide's Block. Dodge Roll's Parry guards beats 2 and 3 and cancels a hit that lands there.",
    ], seal: "Kneecap, Chalk Dust and Sling Stone are spent: a special card plays once per match. Seal your plan." },
    { title: "Read the card.", hint: "Your call: Ironhide's plan is hidden now, as in a real match. Look at the cards it still has, read what each does, and guess what it will play. Then plan your three beats. After this round the higher health wins.", look: "See Ironhide's cards" },
  ],
  lessons: [
    { round: 1, kind: "Cancelled", card: "Hammer Blow", text: "Hammer Blow was still winding up, so Kneecap's Interrupt cancelled it. A cancelled card is spent and does nothing." },
    { round: 1, kind: "VulnerableApplied", card: "Chalk Dust", text: "Ironhide is Vulnerable 1: the next hit against it deals double." },
    { round: 1, kind: "HitLanded", card: "Sling Stone", doubled: true, text: "Sling Stone hit for double and used up the Vulnerable." },
    { round: 2, kind: "BlockGained", card: "Bulwark", text: "Bulwark's 5 Block soaks up damage until the round ends. Your Pick landed before it." },
    { round: 2, kind: "Cancelled", card: "Avalanche", text: "Dodge Roll's Parry was up on beat 3, so Avalanche's hit was cancelled." },
    { round: 3, kind: "CounterHit", text: "Spiked Shield's Counter hits back for every hit that lands on Ironhide." },
  ],
  offer: { title: "First duel?", body: "Learn the game in one guided match against Ironhide.", start: "Start the guided match", skip: "Skip" },
  result: {
    real: "In a real match you choose a clan, pick eight cards from its ten, and plan without seeing your rival's plan.",
    again: "Play the guided match again",
    onward: { online: "Play online", bot: "Play the bot", hotseat: "Two players", home: "Back to the hall" },
  },
};

const script = {
  clans: ["Pickers", "Ironhide"],
  decks: [
    ["Undermine", "Kneecap", "Chalk Dust", "Sling Stone", "Dodge Roll", "Double Tap", "Pickaxe Flurry", "Boot and Heel"],
    ["Avalanche", "Hammer Blow", "Bulwark", "Cobble Throw", "Spiked Shield", "Anvil Stomp", "Feint", "Shield Catch"],
  ],
  opponent: [["Hammer Blow", "Cobble Throw"], ["Bulwark", "Avalanche"], ["Feint", "Spiked Shield"]],
  rails: [["Kneecap", "Chalk Dust", "Sling Stone"], ["Pick", "Dodge Roll"], null],
};

// tutorialMatch resolves the script's card names to the engine's card ids.
export function tutorialMatch(engine) {
  const ids = (names) => names.map((name) => {
    const card = engine.cards.find((c) => c.name === name);
    if (card === undefined) throw new Error(`unknown card: ${name}`);
    return card.id;
  });
  return {
    clans: [...script.clans],
    decks: script.decks.map((deck) => ids(deck).sort((a, b) => a - b)),
    opponent: script.opponent.map(ids),
    rails: script.rails.map((plan) => (plan === null ? null : ids(plan))),
  };
}

// railsNext is the card the rails ask for next, or undefined once the plan is complete, has
// left the rails, or the round has none.
export function railsNext(rails, plan) {
  if (rails === null || plan.length >= rails.length) return undefined;
  return plan.every((id, i) => id === rails[i]) ? rails[plan.length] : undefined;
}

// lessonsFor places each of the round's lessons at the index of the first event it describes.
export function lessonsFor(round, events, cards) {
  const lessons = [];
  for (const lesson of coach.lessons.filter((l) => l.round === round)) {
    const at = events.findIndex((ev) => ev.kind === lesson.kind
      && (lesson.card === undefined || cards[ev.card]?.name === lesson.card)
      && (lesson.doubled === undefined || ev.doubled === lesson.doubled));
    if (at >= 0) lessons.push({ at, text: lesson.text });
  }
  return lessons.sort((a, b) => a.at - b.at);
}

export function tutorialSeen(storage) {
  try {
    return ["done", "skipped"].includes(storage.getItem(tutorialKey));
  } catch {
    return false;
  }
}

export function rememberTutorial(storage, value) {
  try {
    storage.setItem(tutorialKey, value);
  } catch {
    // Without storage the offer simply shows again on the next visit.
  }
}

// afterFiniteAnimations waits for the animations that end; looping ones, like a breathing
// portrait, would never let it resolve.
export async function afterFiniteAnimations(animations) {
  const ending = animations.filter((a) => Number.isFinite(a.effect?.getTiming().iterations));
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}
