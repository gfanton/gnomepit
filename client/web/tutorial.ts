// The guided first match: a ready Pickers deck against a scripted Ironhide, with the coach's
// words for each planning step and each lesson the playback stops on.

import * as v from "valibot";

import type { BattleEvent, Card, Engine } from "./engine.ts";

export const tutorialKey = "gnomehall:tutorial";

const AnswerSchema = v.picklist(["done", "skipped"]);

export type TutorialAnswer = v.InferOutput<typeof AnswerSchema>;

export const coach = {
  rounds: [
    {
      title: "Timing beats strength.",
      steps: [
        "Hammer Blow takes two beats, so on beat 1 it is only winding up. Kneecap is Quick and Interrupts: play it on beat 1 and the blow never lands.",
        "Chalk Dust makes Ironhide Vulnerable: the next hit against it deals double. Play it on beat 2.",
        "Now Sling Stone on beat 3. Its 2 damage lands doubled.",
      ],
      seal: "Three beats filled. Seal your plan: both plans are revealed together and play out beat by beat.",
    },
    {
      title: "Read their deck.",
      steps: [
        "From round 2 both decks are open: Opponent & history shows all eight of Ironhide's cards. Bulwark lands on beat 2 with 5 Block, so hit first: play Pick on beat 1. Pick and Brace never run out.",
        "Avalanche deals damage equal to Ironhide's Block. Dodge Roll's Parry guards beats 2 and 3 and cancels a hit that lands there.",
      ],
      seal: "Kneecap, Chalk Dust and Sling Stone are spent: a special card plays once per match. Seal your plan.",
    },
    {
      title: "Read the card.",
      hint: "Your call: Ironhide's plan is hidden now, as in a real match. Look at the cards it still has, read what each does, and guess what it will play. Then plan your three beats. After this round the higher health wins.",
      look: "See Ironhide's cards",
    },
  ],
  lessons: [
    {
      round: 1,
      kind: "Cancelled",
      card: "Hammer Blow",
      text: "Hammer Blow was still winding up, so Kneecap's Interrupt cancelled it. A cancelled card is spent and does nothing.",
    },
    {
      round: 1,
      kind: "VulnerableApplied",
      card: "Chalk Dust",
      text: "Ironhide is Vulnerable 1: the next hit against it deals double.",
    },
    {
      round: 1,
      kind: "HitLanded",
      card: "Sling Stone",
      doubled: true,
      text: "Sling Stone hit for double and used up the Vulnerable.",
    },
    {
      round: 2,
      kind: "BlockGained",
      card: "Bulwark",
      text: "Bulwark's 5 Block soaks up damage until the round ends. Your Pick landed before it.",
    },
    {
      round: 2,
      kind: "Cancelled",
      card: "Avalanche",
      text: "Dodge Roll's Parry was up on beat 3, so Avalanche's hit was cancelled.",
    },
    { round: 3, kind: "CounterHit", text: "Spiked Shield's Counter hits back for every hit that lands on Ironhide." },
  ],
  offer: {
    title: "First duel?",
    body: "Learn the game in one guided match against Ironhide.",
    start: "Start the guided match",
    skip: "Skip",
  },
  result: {
    real: "In a real match you choose a clan, pick eight cards from its ten, and plan without seeing your rival's plan.",
    again: "Play the guided match again",
    onward: { online: "Play online", bot: "Play the bot", hotseat: "Two players", home: "Back to the hall" },
  },
};

const script = {
  clans: ["Pickers", "Ironhide"],
  decks: [
    [
      "Undermine",
      "Kneecap",
      "Chalk Dust",
      "Sling Stone",
      "Dodge Roll",
      "Double Tap",
      "Pickaxe Flurry",
      "Boot and Heel",
    ],
    ["Avalanche", "Hammer Blow", "Bulwark", "Cobble Throw", "Spiked Shield", "Anvil Stomp", "Feint", "Shield Catch"],
  ],
  opponent: [
    ["Hammer Blow", "Cobble Throw"],
    ["Bulwark", "Avalanche"],
    ["Feint", "Spiked Shield"],
  ],
  rails: [["Kneecap", "Chalk Dust", "Sling Stone"], ["Pick", "Dodge Roll"], null],
} as const;

export type TutorialMatch = {
  clans: [string, string];
  decks: [number[], number[]];
  opponent: number[][];
  rails: (number[] | null)[];
};

// tutorialMatch resolves the script's card names to the engine's card ids.
export function tutorialMatch(engine: Engine): TutorialMatch {
  const ids = (names: readonly string[]) =>
    names.map((name) => {
      const card = engine.cards.find((c) => c.name === name);
      if (card === undefined) throw new Error(`unknown card: ${name}`);
      return card.id;
    });
  const deck = (names: readonly string[]) => ids(names).sort((a, b) => a - b);
  const [mine, theirs] = script.decks;
  return {
    clans: [...script.clans],
    decks: [deck(mine), deck(theirs)],
    opponent: script.opponent.map(ids),
    rails: script.rails.map((plan) => (plan === null ? null : ids(plan))),
  };
}

// railsNext is the card the rails ask for next, or undefined once the plan is complete, has
// left the rails, or the round has none.
export function railsNext(rails: number[] | null, plan: number[]): number | undefined {
  if (rails === null || plan.length >= rails.length) return undefined;
  return plan.every((id, i) => id === rails[i]) ? rails[plan.length] : undefined;
}

// lessonsFor places each of the round's lessons at the index of the first event it describes.
export function lessonsFor(round: number, events: BattleEvent[], cards: Card[]): { at: number; text: string }[] {
  const lessons: { at: number; text: string }[] = [];
  for (const lesson of coach.lessons.filter((l) => l.round === round)) {
    const at = events.findIndex(
      (ev) =>
        ev.kind === lesson.kind &&
        (lesson.card === undefined || cards[ev.card]?.name === lesson.card) &&
        (lesson.doubled === undefined || ev.doubled === lesson.doubled),
    );
    if (at >= 0) lessons.push({ at, text: lesson.text });
  }
  return lessons.sort((a, b) => a.at - b.at);
}

// tutorialMemory keeps whether this browser finished or skipped the guided match. Storage
// that throws keeps the answer for this visit only, so the offer shows again on the next.
export function tutorialMemory(storage: Pick<Storage, "getItem" | "setItem"> | undefined): {
  seen(): boolean;
  remember(value: TutorialAnswer): void;
} {
  let answer: TutorialAnswer | null = null;
  return {
    seen() {
      if (answer !== null) return true;
      try {
        return v.is(AnswerSchema, storage?.getItem(tutorialKey));
      } catch {
        return false;
      }
    },
    remember(value) {
      answer = value;
      try {
        storage?.setItem(tutorialKey, value);
      } catch {}
    },
  };
}

// afterFiniteAnimations waits for the animations that end; looping ones, like a breathing
// portrait, would never let it resolve.
export async function afterFiniteAnimations(
  animations: { effect: { getTiming(): EffectTiming } | null; finished: Promise<unknown> }[],
): Promise<void> {
  const ending = animations.filter((a) => Number.isFinite(a.effect?.getTiming().iterations));
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}
