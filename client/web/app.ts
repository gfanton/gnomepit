// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import {
  type BattleEvent,
  type Card,
  type Clan,
  type GameState,
  type Gnome,
  type Side,
  type Vitals,
  cardOf,
  loadEngine,
  otherSide,
  startState,
} from "./engine.ts";
import { type Action, type Flow, type Round, initial, reduce, botTurn } from "./flow.ts";
import { type Deck, deckSize, newDeck, readiness, toggle, rareOf } from "./deck.ts";
import { randomDeck, randomPlan } from "./bot.ts";
import { addCard, beatsUsed, canAdd, clearFrom, isSealable, slots } from "./plan.ts";
import { sentences, matchLog, sideNames, possessive } from "./log.ts";
import { type Verdict, verdict } from "./result.ts";
import { counted, glossary, markKeywords, escapeHTML } from "./keywords.ts";
import { type KnownCards, knownCards } from "./table.ts";
import { type StepFeedback, cardBehind, heavyHit, impact, stepFeedback } from "./battle-feedback.ts";
import { artIndex } from "./art.ts";
import { loadArena } from "./arena-provider.ts";
import { messageOf } from "./chain.ts";
import { elementById } from "./dom.ts";
import type { Address } from "./ids.ts";
import { type Lobby, createLobby, linkedMatch } from "./lobby.ts";
import { networkFor } from "./network.ts";
import { type View, matchBarText, replayView, sendingText } from "./online-model.ts";
import {
  type TutorialMatch,
  afterFiniteAnimations,
  coach,
  lessonsFor,
  railsNext,
  tutorialMatch,
  tutorialMemory,
} from "./tutorial.ts";
import { wordmarkHTML } from "./wordmark.ts";

// The build's network name, which esbuild's define writes in.
declare const GNOMEPIT_NETWORK: string;

type Pair<T> = [T, T];
// Where a player heads from home, or after the guided match.
type PlayMode = "online" | "bot" | "hotseat";
// What an online plan is sent as: a challenge or an acceptance, or a move in a match the
// player may only be reviewing.
type OnlineContext =
  | { intent: "challenge" | "accept"; view: View | null; opponent: string; account: Address | "" }
  | { intent: "move"; view: View; account: Address | ""; review: boolean };
// The unsent online plan the lobby holds while the player is back on the board.
type Draft = {
  flow: Flow;
  deck: Deck | null;
  plan: number[];
  legalPlans: number[][];
  onlineContext: OnlineContext | null;
  choosingClan: boolean;
};
type Step = Pick<BattleEvent, "beat" | "phase" | "tier" | "step"> & { from: number; to: number };
type Playback = {
  start: Pair<Vitals>;
  steps: Step[];
  lines: string[];
  shown: number;
  speed: number;
  timer: number | null;
  revealTimer: number | null;
  // performance.now() milliseconds at which revealTimer fires.
  revealAt: number;
  viewer: Side;
  lessons: { at: number; text: string; shown: boolean }[];
  lesson: { text: string; ready: boolean } | null;
};
// A gnome between rounds, which has no block or counter, or its vitals during one.
type ShownVitals = Pick<Vitals, "hp"> & Partial<Vitals>;
type CardOptions = {
  selected?: boolean;
  dimmed?: boolean;
  small?: boolean;
  locked?: boolean;
  pressed?: boolean | null;
  action?: string | null;
  data?: string;
  spentRound?: number;
  hand?: boolean;
  track?: boolean;
  coached?: boolean;
  sealed?: string;
};

const engine = await loadEngine("engine.wasm", "cards.json");
const art = artIndex(await (await fetch("art/assets.json")).json());
const app = elementById("app", HTMLElement);
const tip = elementById("tip", HTMLDivElement);
const basics = engine.cards.filter((c) => !c.special).map((c) => c.id);
const stepMs = 1050;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let handScroll = 0;
const flights = new Set<HTMLElement>();

let flow: Flow = initial;
let choosingClan = true;
let deck: Deck | null = null; // the deck being picked on the deck screen
let plan: number[] = []; // the plan being built on the plan screen
let legalPlans: number[][] = []; // the acting player's legal plans this round
let onlineContext: OnlineContext | null = null;
let onlineError = "";
let onlineSending = false;
let playback: Playback | null = null; // the round being played back
let guided: TutorialMatch | null = null; // the guided match's decks and plans, from tutorialMatch, while one runs
let onward: PlayMode | null = null; // where the player was heading before the guided match

// Shared cards, and any clan missing here, get no emblem and no blurb.
const clanLook: Record<string, { emblem: string; blurb: string }> = {
  Delvers: {
    emblem:
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M12 3h8M12 3 8 15M20 3l5 13M8 15l8-5 9 6-2 10-10 3-8-6ZM16 10l-3 8 6 2-6 9"/></svg>',
    blurb: "Bad ideas. Excellent timing. Push your luck and return the punishment.",
  },
  Pickers: {
    emblem:
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M14.5 8.5V28h3V8.5"/><path d="M4 11C10 2 22 2 28 11 20 7 12 7 4 11Z"/></svg>',
    blurb: "Quick hands. Dirty tricks. A miner’s tools, a duelist’s timing.",
  },
  Ironhide: {
    emblem:
      '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 6 16 3 26 6v12c0 5-6 9-10 12C12 27 6 23 6 18Z"/><path d="M16 8v15M10 15h12"/></svg>',
    blurb: "Stand firm. Strike hard. Iron shields and the weight of the mountain.",
  },
};
function cardClan(c: Card): string {
  return engine.clans.find((clan) => clan.cards.includes(c.id))?.name ?? "Shared";
}
function emblem(clan: string): string {
  return clanLook[clan]?.emblem ?? "";
}
function portraitHTML(clan: string, attributes: string): string {
  const file = art.portrait(clan);
  return file === undefined ? "" : `<img ${attributes} src="art/${file}" alt="${clan} clan champion">`;
}
function artHTML(c: Card): string {
  const file = art.card(c.name);
  return file !== undefined
    ? `<div class="card__art"><img src="art/${file}" alt="" loading="lazy"></div>`
    : `<div class="card__art card__art--pending">${emblem(cardClan(c))}<span>Clan study · art to come</span></div>`;
}
// collectionHTML lists every card, clan by clan, then the shared techniques.
function collectionHTML(): string {
  const groups = [
    ...engine.clans.map((clan) => ({ name: clan.name, ids: clan.cards })),
    { name: "Shared", ids: basics },
  ];
  return `<div class="collection">${groups.map(({ name, ids }) => `<section class="stack"><div class="frame__head"><h2 class="heading">${name === "Shared" ? "Shared techniques" : name}</h2><span class="label">${counted(ids.length, "card")}</span></div><div class="card-grid">${ids.map((id) => cardHTML(cardOf(engine.cards, id))).join("")}</div></section>`).join("")}</div>`;
}

function masthead(note = "A duel beneath the mountain"): string {
  return `<header class="masthead">${wordmarkHTML("./")}<span class="masthead__note">${note}</span></header>`;
}

const tutorialFlag = tutorialMemory(localStorage);
const built = networkFor(GNOMEPIT_NETWORK);
const arena = built === null ? null : loadArena(engine, built);
const lobby: Lobby<Draft> | null =
  arena === null
    ? null
    : createLobby<Draft>({
        app,
        arena,
        storage: localStorage,
        onRender: render,
        portrait: portraitHTML,
        emblem,
        onResume: () => {
          const draft = onlineLobby().model.draft;
          if (draft === null) return;
          ({ flow, deck, plan, legalPlans, onlineContext } = draft);
          choosingClan = draft.choosingClan;
          onlineLobby().model.inGame = true;
          app.classList.remove("lobby");
          render();
        },
        onExit: (offline) => {
          stopPlaying();
          playback = null;
          onlineContext = null;
          flow = initial;
          render(() => {
            if (offline) app.querySelector(".offline-row")?.scrollIntoView({ block: "center" });
          });
        },
        onCompose: (context) => {
          onlineContext = context;
          onlineError = "";
          onlineLobby().model.draft = null;
          app.classList.remove("lobby");
          const opponent = context.view?.clans[0] ?? "";
          if (opponent !== "" && clanNamed(opponent) === undefined)
            throw new Error("The arena returned an unknown clan. Reload before playing.");
          flow = {
            ...initial,
            screen: "deck",
            mode: "online",
            hp: engine.hp,
            acting: context.intent === "accept" ? 1 : 0,
            clans: context.intent === "accept" ? [opponent, null] : [null, ""],
            decks: [[], []],
            state: startState(engine.hp),
          };
          choosingClan = true;
          deck = newDeck(firstClan());
          render();
        },
        onPlay: (raw, address, review) => {
          const restored = replayView(raw, engine, address);
          const { view, decks, state, rounds, result } = restored;
          if (!review && view.side === 0 && view.phase === "reveal" && raw.pending === undefined)
            throw new Error(
              "This device cannot open your sealed plan yet. Approve the session on this device, then open the match again.",
            );
          if (!review && (view.side === -1 || decks[view.side].length === 0))
            throw new Error(
              "Your private deck is needed to resume this turn. The arena adapter must recover it before play.",
            );
          if (!review && rounds.length === 0 && (view.round ?? 0) > 1)
            throw new Error("The arena has not supplied the resolved round yet. Refresh this match.");
          onlineContext = { intent: "move", view, account: address, review };
          onlineError = "";
          flow = {
            ...initial,
            mode: "online",
            hp: engine.hp,
            acting: view.side === -1 ? 0 : view.side,
            clans: view.clans,
            decks,
            state,
            rounds,
            result,
            screen: rounds.length > 0 ? "playback" : "plan",
          };
          const round = rounds.at(-1);
          if (round !== undefined) {
            playback = {
              start: atRest(round.start),
              steps: groupSteps(round.events),
              lines: sentences(round.events, { cards: engine.cards, names: battleNames(), plans: round.plans }),
              shown: 0,
              timer: null,
              revealTimer: null,
              revealAt: 0,
              speed: 1,
              viewer: flow.acting,
              lessons: [],
              lesson: null,
            };
          } else {
            legalPlans = engine.legalPlans({ state, side: flow.acting, deck: decks[flow.acting] });
            plan = [];
          }
          onlineLobby().model.inGame = true;
          app.classList.remove("lobby");
          render();
        },
      });
// onlineLobby is the lobby; an offline build has none and draws no online action.
function onlineLobby(): Lobby<Draft> {
  if (lobby === null) throw new Error("This build plays offline only.");
  return lobby;
}
// onlineMatch is the online match being planned or played back, which online mode always has.
function onlineMatch(): OnlineContext {
  if (onlineContext === null) throw new Error("No online match is open.");
  return onlineContext;
}
// underway is the match the flow plays: every screen from the first plan on has one.
function underway(): { hp: number; state: GameState; decks: Pair<number[]>; clans: Pair<string> } {
  const {
    hp,
    state,
    decks: [deckA, deckB],
    clans: [clanA, clanB],
  } = flow;
  if (hp === null || state === null || deckA === null || deckB === null || clanA === null || clanB === null)
    throw new Error("No match is under way.");
  return { hp, state, decks: [deckA, deckB], clans: [clanA, clanB] };
}
function battleNames(): Pair<string> {
  const name = (clan: string | null, side: Side) =>
    side === flow.acting ? "You" : clan === null || clan === "" ? "Your rival" : clan;
  return flow.mode === "online"
    ? [name(flow.clans[0], 0), name(flow.clans[1], 1)]
    : sideNames(underway().clans, flow.mode);
}
function onlineBar(): string {
  return flow.mode !== "online"
    ? ""
    : `<section class="online-match-bar"><button class="button button--secondary" data-action="onlineBack" ${onlineSending ? "disabled" : ""}>Back to board</button><span>${escapeHTML(matchBarText(onlineMatch().intent, onlineMatch().view?.deadline))}</span><p role="status"${onlineSending ? ' class="busy-note"' : ""}>${escapeHTML(onlineError !== "" ? onlineError : onlineSending ? sendingText(onlineMatch().intent) : "")}</p></section>`;
}
async function sendOnlinePlan(): Promise<void> {
  if (onlineSending || !isSealable(plan, legalPlans)) return;
  onlineSending = true;
  onlineError = "";
  render();
  const saved = [...plan];
  try {
    const me = flow.acting;
    const { clans, decks } = underway();
    await onlineLobby().sendDraft(onlineMatch(), clans[me], decks[me], saved);
    stopPlaying();
    playback = null;
    flow = { ...initial, screen: "lobby" };
  } catch (error) {
    onlineError = messageOf(error);
  } finally {
    onlineSending = false;
    render();
  }
}

// ---- Actions

function dispatch(action: Action): void {
  const before = flow;
  flow = reduce(flow, action);
  enter(before);
  render();
}

// enter runs what a screen needs on arrival: a fresh deck or plan to build, the legal
// plans from the engine, the bot's move, or the round's resolution.
function enter(before: Flow): void {
  const arrived = flow.screen !== before.screen || flow.acting !== before.acting;
  if (!arrived) return;
  if (before.screen === "playback") {
    stopPlaying();
    playback = null;
  }
  if (flow.screen === "deck") {
    if (botTurn(flow)) {
      const clan = engine.clans[Math.floor(Math.random() * engine.clans.length)];
      if (clan === undefined) throw new Error("The card file names no clan.");
      dispatch({ type: "deckReady", clan: clan.name, deck: randomDeck(clan, engine.cards, Math.random) });
      return;
    }
    choosingClan = true;
    deck = newDeck(firstClan());
  }
  if (flow.screen === "plan") {
    const { state, decks } = underway();
    const plans = engine.legalPlans({ state, side: flow.acting, deck: decks[flow.acting] });
    if (botTurn(flow)) {
      dispatch({
        type: "planSealed",
        plan: flow.mode === "tutorial" ? guidedRound().opponent : randomPlan(plans, Math.random),
      });
      return;
    }
    legalPlans = plans;
    plan = [];
  }
  if (flow.screen === "playback") {
    const { state: current, decks } = underway();
    const [a, b] = flow.plans;
    if (a === null || b === null) throw new Error("A plan is not sealed yet.");
    const start = atRest(current);
    const { state, result, events } = engine.resolve({
      state: current,
      decks,
      a,
      b,
    });
    const names = battleNames();
    playback = {
      start,
      steps: groupSteps(events),
      lines: sentences(events, { cards: engine.cards, names, plans: [a, b] }),
      shown: 0,
      timer: null,
      speed: 1,
      revealTimer: null,
      revealAt: 0,
      viewer: flow.mode === "bot" || flow.mode === "tutorial" ? 0 : flow.acting,
      // The guided match's lessons for this round, each {at, text, shown}, and the one on show
      // as {text, ready}, ready once the step's motion has ended.
      lessons:
        flow.mode === "tutorial"
          ? lessonsFor(current.round, events, engine.cards).map((l) => ({ ...l, shown: false }))
          : [],
      lesson: null,
    };
    dispatch({ type: "resolved", state, result, events });
  }
  if (flow.screen === "result" && flow.mode === "tutorial") tutorialFlag.remember("done");
}

// groupSteps turns the event list into [from, to) ranges of events that resolve together.
function groupSteps(events: BattleEvent[]): Step[] {
  const steps: Step[] = [];
  events.forEach((ev, i) => {
    const last = steps.at(-1);
    const same = last !== undefined && (["beat", "phase", "tier", "step"] as const).every((k) => ev[k] === last[k]);
    if (same) last.to = i + 1;
    else steps.push({ beat: ev.beat, phase: ev.phase, tier: ev.tier, step: ev.step, from: i, to: i + 1 });
  });
  return steps;
}

// atRest is each gnome's vitals before a round's first step.
function atRest({ gnomes }: GameState): Pair<Vitals> {
  const vitals = ({ hp, vulnerable, strength }: Gnome): Vitals => ({ hp, block: 0, counter: 0, vulnerable, strength });
  return [vitals(gnomes[0]), vitals(gnomes[1])];
}

// firstClan is the clan a deck starts from until the player picks one.
function firstClan(): Clan {
  const [clan] = engine.clans;
  if (clan === undefined) throw new Error("The card file names no clan.");
  return clan;
}

// picking is the deck the deck screen builds.
function picking(): Deck {
  if (deck === null) throw new Error("No deck is being picked.");
  return deck;
}

// playModeOf reads a data-mode the page wrote; anything else is no mode.
function playModeOf(mode: string | undefined): PlayMode | null {
  return mode === "online" || mode === "bot" || mode === "hotseat" ? mode : null;
}

function enterMode(mode: string | undefined): void {
  if (mode === "online") handlers.online();
  else handlers.start({ mode });
}

const handlers = {
  start: ({ mode }: DOMStringMap) => {
    if (mode !== "bot" && mode !== "hotseat") throw new Error(`No offline mode ${mode}`);
    dispatch({ type: "start", mode, hp: engine.hp });
  },
  online: () => {
    flow = { ...initial, screen: "lobby" };
    void onlineLobby().enter();
  },
  onlineBack: () => {
    if (onlineSending) return;
    stopPlaying();
    playback = null;
    if (["plan", "deck"].includes(flow.screen))
      onlineLobby().model.draft = { flow, deck, plan, legalPlans, onlineContext, choosingClan };
    void onlineLobby().returnToBoard();
  },
  library: () => {
    flow = { ...initial, screen: "library" };
    render();
  },
  // playMode enters a mode from home, offering the guided match first to a browser that has
  // neither played nor skipped it.
  playMode: ({ mode }: DOMStringMap): void => {
    if (tutorialFlag.seen()) return enterMode(mode);
    const offer = elementById("tutorial-offer", HTMLDialogElement);
    for (const button of offer.querySelectorAll("[data-action]")) {
      if (button instanceof HTMLElement) button.dataset.mode = mode;
    }
    openDialog(offer);
  },
  tutorialSkip: ({ mode }: DOMStringMap) => {
    closeBattleDialogs();
    tutorialFlag.remember("skipped");
    enterMode(mode);
  },
  tutorial: ({ mode }: DOMStringMap) => {
    closeBattleDialogs();
    onward = playModeOf(mode);
    guided = tutorialMatch(engine);
    flow = initial;
    dispatch({ type: "startTutorial", hp: engine.hp, clans: guided.clans, decks: guided.decks });
  },
  home: () => {
    flow = initial;
    render();
  },
  changeClan: () => {
    choosingClan = true;
    render();
  },
  clan: ({ name }: DOMStringMap) => {
    const clan = clanNamed(name);
    if (clan === undefined) return;
    if (deck?.clan !== name) deck = newDeck(clan);
    choosingClan = false;
    // The chosen clan's picture carries over into the deck banner's portrait.
    const art = app.querySelector(`.clan-choice[data-name="${clan.name}"] .clan-choice__art`);
    if (art instanceof HTMLElement) art.style.viewTransitionName = "champion-near";
    render();
  },
  toggle: ({ id }: DOMStringMap) => {
    const picked = picking();
    const clan = clanNamed(picked.clan);
    if (clan === undefined) throw new Error(`No clan ${picked.clan}`);
    deck = toggle(picked, Number(id), clan, engine.cards);
    render();
  },
  deckReady: (): void => {
    const picked = picking();
    if (flow.mode !== "online")
      return dispatch({ type: "deckReady", clan: picked.clan, deck: [...picked.picks].sort((a, b) => a - b) });
    const me = flow.acting;
    flow.clans[me] = picked.clan;
    flow.decks[me] = [...picked.picks].sort((a, b) => a - b);
    flow = { ...flow, screen: "plan" };
    const { state, decks } = underway();
    legalPlans = engine.legalPlans({ state, side: me, deck: decks[me] });
    plan = [];
    render();
  },
  handoffDone: () => dispatch({ type: "handoffDone" }),
  addCard: ({ id }: DOMStringMap) => {
    const cardId = Number(id);
    const source = app.querySelector(`.battle-hand [data-action="addCard"][data-id="${cardId}"]`);
    const from = source?.getBoundingClientRect();
    const next = addCard(plan, cardId, engine.cards, available());
    if (next === plan) return;
    const index = plan.length;
    closeBattleDialogs();
    plan = next;
    render();
    app.querySelectorAll(".hand-entry").forEach((el) => el.classList.add("hand-entry--resting"));
    flyCard(source, from, app.querySelector(`[data-plan-index="${index}"]`));
    elementById("plan-status", HTMLSpanElement).textContent =
      `${cardOf(engine.cards, cardId).name} added. ${beatsUsed(plan, engine.cards)} of 3 beats filled.`;
  },
  clearFrom: ({ beat }: DOMStringMap) => returnCards(clearFrom(plan, Number(beat), engine.cards)),
  clearPlan: () => returnCards([]),
  inspectCard: ({ id }: DOMStringMap) => {
    if (flow.screen === "playback") stopPlaying();
    const c = cardOf(engine.cards, Number(id));
    const legal = flow.screen === "plan" && canAdd(plan, c.id, engine.cards, available());
    const reader = elementById("card-reader", HTMLDialogElement);
    elementById("reader-content", HTMLDivElement).innerHTML =
      `${cardHTML(c)}<p class="muted">${counted(c.cost, "beat")}${c.special ? " · Once per match" : " · Reusable basic"}</p>
      ${legal ? `<button class="button" type="button" data-action="addCard" data-id="${c.id}">Play ${c.name}</button>` : `<p class="muted">${unplayable(c)}</p>`}`;
    openDialog(reader);
  },
  playedCards: () => {
    if (flow.screen === "playback") stopPlaying();
    openDialog(elementById("played-cards", HTMLDialogElement));
  },
  intel: () => {
    if (flow.screen === "playback") stopPlaying();
    openDialog(elementById("battle-info", HTMLDialogElement));
  },
  roundLog: () => {
    stopPlaying();
    openDialog(elementById("round-log", HTMLDialogElement));
  },
  closeDialog: () => closeBattleDialogs(),
  seal: () => {
    closeBattleDialogs();
    if (flow.mode === "online") {
      void sendOnlinePlan();
      return;
    }
    dispatch({ type: "planSealed", plan });
  },
  next: () => {
    stopPlaying();
    showStep(playing().shown + 1);
  },
  play: () => {
    const { timer, revealTimer } = playing();
    if (timer !== null || revealTimer !== null) stopPlaying();
    else startPlaying();
  },
  skip: () => {
    stopPlaying();
    for (const card of app.querySelectorAll(".card--sealed")) card.classList.remove("card--sealed");
    const session = playing();
    const lesson = session.lessons.find((l) => !l.shown);
    if (lesson === undefined) return showStep(session.steps.length, false);
    // In the guided match, skipping runs only as far as the next lesson.
    const target = session.steps.findIndex((s) => lesson.at >= s.from && lesson.at < s.to) + 1;
    showStep(Math.max(target, session.shown), false);
    lesson.shown = true;
    session.lesson = { text: lesson.text, ready: true };
    patchPlayback();
    elementById("lesson-continue", HTMLButtonElement).focus({ preventScroll: true });
  },
  lessonDone: () => {
    if (playback === null || playback.lesson === null) return;
    playback.lesson = null;
    patchPlayback();
    startPlaying();
  },
  playbackDone: (): void => {
    if (flow.mode !== "online") return dispatch({ type: "playbackDone" });
    stopPlaying();
    playback = null;
    const context = onlineMatch();
    if (context.intent !== "move" || context.review || context.view.action !== "move") {
      void onlineLobby().returnToBoard();
      return;
    }
    flow = { ...flow, screen: "plan" };
    const { state, decks } = underway();
    legalPlans = engine.legalPlans({ state, side: flow.acting, deck: decks[flow.acting] });
    plan = [];
    render();
  },
  // tutorialLeave ends the guided match early, as a skip if the browser had not finished it.
  tutorialLeave: () => {
    if (!tutorialFlag.seen()) tutorialFlag.remember("skipped");
    handlers.tutorialOnward();
  },
  tutorialOnward: () => {
    const mode = onward;
    guided = null;
    onward = null;
    flow = initial;
    if (mode === null) render();
    else enterMode(mode);
  },
  rematch: () => dispatch({ type: "rematch" }),
  newMatch: () => dispatch({ type: "newMatch" }),
  copyLog: () => copyMatchLog(),
};

document.addEventListener("pointermove", (event) => {
  for (const entry of app.querySelectorAll(".hand-entry--resting")) {
    const rect = entry.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      entry.classList.remove("hand-entry--resting");
  }
});
app.addEventListener("pointerout", (event) => {
  const entry = event.target instanceof Element ? event.target.closest(".hand-entry--resting") : null;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (entry !== null && !entry.contains(related)) entry.classList.remove("hand-entry--resting");
});
document.addEventListener("keydown", () =>
  app.querySelectorAll(".hand-entry--resting").forEach((el) => el.classList.remove("hand-entry--resting")),
);
// The wordmark leads home, which would throw away a match or a deck under way, so it asks first.
// Online, the match lives on the chain and the draft is kept, so it leads back to the board.
app.addEventListener("click", (event) => {
  const mark = event.target instanceof Element ? event.target.closest("a.wordmark:not([data-action])") : null;
  if (mark === null || !atStake()) return;
  event.preventDefault();
  if (flow.mode === "online") handlers.onlineBack();
  else confirmLeave();
});

// atStake holds while leaving would lose something: a match under way or a deck being built.
function atStake(): boolean {
  if (flow.screen === "plan" || flow.screen === "playback" || flow.screen === "handoff") return true;
  return flow.screen === "deck" && (!choosingClan || flow.decks[0] !== null);
}

const leaveDialog = document.createElement("dialog");
leaveDialog.className = "offer";
leaveDialog.setAttribute("aria-labelledby", "leave-title");
document.body.append(leaveDialog);
leaveDialog.addEventListener("click", (event) => {
  const choice = event.target instanceof Element ? event.target.closest("[data-leave]") : null;
  if (event.target === leaveDialog || choice?.getAttribute("data-leave") === "stay") leaveDialog.close();
  else if (choice?.getAttribute("data-leave") === "go") {
    leaveDialog.close();
    leaveMatch();
  }
});

function confirmLeave(): void {
  const [title, text] =
    flow.mode === "tutorial"
      ? ["Leave the guided match?", "You can play it again from How to play."]
      : flow.screen === "deck" && flow.decks[0] === null
        ? ["Leave this deck?", "The cards you chose are not kept."]
        : ["Leave this match?", "The match ends here and cannot be picked up again."];
  leaveDialog.innerHTML = `<h2 id="leave-title">${title}</h2><p>${text}</p><div class="button-row"><button class="button" type="button" data-leave="stay">Keep playing</button><button class="button button--secondary" type="button" data-leave="go">Leave</button></div>`;
  leaveDialog.showModal();
}

// leaveMatch drops the match under way and goes home; leaving the guided match counts as skipping
// it for a browser that never finished it.
function leaveMatch(): void {
  if (flow.mode === "tutorial" && !tutorialFlag.seen()) tutorialFlag.remember("skipped");
  closeBattleDialogs();
  stopPlaying();
  playback = null;
  guided = null;
  onward = null;
  flow = initial;
  render();
}

const isHandled = (action: string): action is keyof typeof handlers => Object.hasOwn(handlers, action);

app.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement) || (target instanceof HTMLButtonElement && target.disabled)) return;
  const action = target.dataset.action ?? "";
  if (action.startsWith("online") && action !== "onlineBack") {
    if (target.tagName === "A") event.preventDefault();
    if (action === "online") handlers.online();
    else void onlineLobby().action(action.slice(6), target.dataset);
    return;
  }
  if (onlineSending) return;
  if (event.detail > 0) target.blur();
  if (isHandled(action)) handlers[action](target.dataset);
});

// ---- Tips: the full card behind a small one, and the rule behind a keyword or badge

const tipAnchors = "[data-peek], [data-kw]";
const tipTitles: Record<string, string> = { cancel: "Cancelled" };
const tipRules: Record<string, string> = glossary;
let tipAnchor: HTMLElement | null = null;

function anchorAt(target: EventTarget | null): HTMLElement | null {
  const anchor = target instanceof Element ? target.closest(tipAnchors) : null;
  return anchor instanceof HTMLElement ? anchor : null;
}

app.addEventListener("mouseover", (event) => showTip(anchorAt(event.target)));
app.addEventListener("mouseout", (event) => {
  if (tipAnchor !== null && !tipAnchor.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null))
    showTip(null);
});
app.addEventListener("focusin", (event) => showTip(anchorAt(event.target)));
app.addEventListener("focusout", () => showTip(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") showTip(null);
});

function showTip(anchor: HTMLElement | null): void {
  if (anchor === tipAnchor) return;
  tipAnchor = anchor;
  tip.hidden = anchor === null;
  if (anchor === null) return;
  const peek = anchor.dataset.peek;
  tip.classList.toggle("tip--card", peek !== undefined);
  if (peek !== undefined) tip.innerHTML = cardHTML(cardOf(engine.cards, Number(peek)));
  else {
    const key = anchor.dataset.kw ?? "";
    tip.innerHTML = `<span class="tip__title">${tipTitles[key] ?? key}</span>${tipRules[key]}`;
  }
  placeTip(anchor);
}

// placeTip puts the tip under the anchor, or above it when the viewport ends first, and keeps
// it inside the viewport sideways.
function placeTip(anchor: HTMLElement): void {
  const gap = 8;
  const at = anchor.getBoundingClientRect();
  let top = anchor.closest(".battle-hand") !== null ? at.top - gap - tip.offsetHeight : at.bottom + gap;
  if (top + tip.offsetHeight > window.innerHeight && at.top - gap - tip.offsetHeight >= 0)
    top = at.top - gap - tip.offsetHeight;
  top = Math.max(gap, Math.min(top, window.innerHeight - tip.offsetHeight - gap));
  const left = Math.max(gap, Math.min(at.left, window.innerWidth - tip.offsetWidth - gap));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

// returnCards keeps kept, the start of the plan, and flies the cards after it back to the hand.
function returnCards(kept: number[]): void {
  const leaving = plan.slice(kept.length).map((id, i) => {
    const card = app.querySelector(`[data-plan-index="${kept.length + i}"] .card`);
    return { id, card, from: card?.getBoundingClientRect() };
  });
  plan = kept;
  render();
  for (const { id, card, from } of leaving)
    flyCard(card, from, app.querySelector(`.battle-hand .card[data-id="${id}"]`));
}

// available lists the ids the acting player may play: the basics and the deck's unspent specials,
// or only the card a guided round's rails ask for next.
function available(): number[] {
  if (flow.mode === "tutorial" && guidedRound().rails !== null) {
    const next = coachedCard();
    return next === undefined ? [] : [next];
  }
  const { state, decks } = underway();
  const spent = state.gnomes[flow.acting].spent;
  return [...basics, ...decks[flow.acting].filter((id) => !spent.includes(id))];
}

// coachedCard is the card the guided match's rails ask for next, if any.
function coachedCard(): number | undefined {
  if (flow.mode !== "tutorial") return undefined;
  const { rails } = guidedRound();
  return rails === null ? undefined : railsNext(rails, plan);
}

// guidedRound is the guided match's script for the round being planned: the cards its rails
// ask for, null in a free round, and the opponent's plan.
function guidedRound(): { rails: number[] | null; opponent: number[] } {
  const round = underway().state.round - 1;
  const rails = guided?.rails[round];
  const opponent = guided?.opponent[round];
  if (rails === undefined || opponent === undefined) throw new Error(`The guided match has no round ${round + 1}.`);
  return { rails, opponent };
}

// unplayable says why the card reader offers no Play button for c.
function unplayable(c: Card): string {
  if (flow.screen === "playback") return "Committed this round.";
  if (underway().state.gnomes[flow.acting].spent.includes(c.id)) return "Already spent this match.";
  const coached = coachedCard();
  return coached === undefined
    ? "This card does not fit your current plan."
    : `The guided match asks for ${cardOf(engine.cards, coached).name} now.`;
}

// ---- Playback

// Timers belong to their playback session; exiting, skipping or pausing cancels them.
function showStep(n: number, animate = true): void {
  if (playback === null || flow.screen !== "playback") return;
  if (playback.revealTimer !== null) clearTimeout(playback.revealTimer);
  playback.revealTimer = null;
  const target = Math.min(n, playback.steps.length);
  const sequential = target === playback.shown + 1;
  playback.shown = target;
  if (target === playback.steps.length && playback.timer !== null) {
    clearInterval(playback.timer);
    playback.timer = null;
  }
  const step = playback.steps[target - 1];
  const events = animate && sequential && step !== undefined ? shownRound().events.slice(step.from, step.to) : null;
  const feedback = events === null ? null : stepFeedback(events);
  // The HP bar's trailing drain lingers in proportion to the hit; it takes its pace before the bar moves.
  for (const side of [0, 1] as const)
    elementById(`hp-ghost-${side}`, HTMLDivElement).style.setProperty(
      "--impact",
      String(impact(feedback?.sides[side].damage ?? 0)),
    );
  patchPlayback();
  if (events !== null && feedback !== null && step !== undefined) {
    animateStep(events, feedback);
    pauseForLesson(step);
  } else for (const side of [0, 1]) elementById(`float-${side}`, HTMLDivElement).replaceChildren();
}

// shownRound is the round the playback screen shows: the flow's last.
function shownRound(): Round {
  const round = flow.rounds.at(-1);
  if (round === undefined) throw new Error("No round has been played.");
  return round;
}

// playing is the round being played back, which every playback control acts on.
function playing(): Playback {
  if (playback === null) throw new Error("No round is being played back.");
  return playback;
}

// pauseForLesson stops the clash on a step that holds a guided lesson, and shows the lesson
// once the step's own motion has ended.
function pauseForLesson(step: Step): void {
  const session = playing();
  const lesson = session.lessons.find((l) => !l.shown && l.at >= step.from && l.at < step.to);
  if (lesson === undefined) return;
  lesson.shown = true;
  stopPlaying();
  session.lesson = { text: lesson.text, ready: false };
  patchPlayback();
  void afterFiniteAnimations(document.getAnimations()).then(() => {
    if (playback !== session || flow.screen !== "playback" || session.lesson === null) return;
    session.lesson.ready = true;
    patchPlayback();
    elementById("lesson-continue", HTMLButtonElement).focus({ preventScroll: true });
  });
}

function queueReveal(session: Playback, delay: number): void {
  session.revealAt = performance.now() + delay;
  session.revealTimer = setTimeout(() => {
    if (playback === session && flow.screen === "playback") {
      session.revealTimer = null;
      startPlaying();
    }
  }, delay);
  patchPlayback();
}

function startPlaying(immediate = true): void {
  if (
    playback === null ||
    flow.screen !== "playback" ||
    playback.shown >= playback.steps.length ||
    playback.timer !== null
  )
    return;
  if (playback.revealTimer !== null) clearTimeout(playback.revealTimer);
  playback.revealTimer = null;
  const session = playback;
  session.timer = setInterval(() => {
    if (playback === session && flow.screen === "playback") showStep(session.shown + 1);
  }, stepMs / session.speed);
  if (immediate) showStep(session.shown + 1);
  else patchPlayback();
}

function stopPlaying(): void {
  if (playback === null) return;
  if (playback.timer !== null) clearInterval(playback.timer);
  if (playback.revealTimer !== null) clearTimeout(playback.revealTimer);
  playback.timer = null;
  playback.revealTimer = null;
  if (flow.screen === "playback" && app.dataset.screen === "playback") patchPlayback();
}

function animateElement(
  element: Element | null,
  frames: Keyframe[],
  options: KeyframeAnimationOptions = {},
): Animation | null {
  if (element === null || reducedMotion.matches) return null;
  return element.animate(frames, { duration: 440, easing: "cubic-bezier(.2,.8,.2,1)", ...options });
}

function flyCard(source: Element | null, from: DOMRect | undefined, destination: Element | null): void {
  if (source === null || from === undefined || destination === null || reducedMotion.matches) return;
  const to = destination.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  if (!(ghost instanceof HTMLElement)) return;
  ghost.removeAttribute("data-action");
  ghost.removeAttribute("data-peek");
  ghost.setAttribute("aria-hidden", "true");
  ghost.tabIndex = -1;
  ghost.classList.add("flying-card");
  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  document.body.append(ghost);
  flights.add(ghost);
  const x = to.left + to.width / 2 - from.left - from.width / 2;
  const y = to.top + to.height / 2 - from.top - from.height / 2;
  const animation = animateElement(
    ghost,
    [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${x}px,${y}px) scale(.65)`, opacity: 0 },
    ],
    { duration: 440 },
  );
  animateElement(
    destination,
    [
      { opacity: 0.15, transform: "scale(.92)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    { delay: 180, duration: 280 },
  );
  animation?.finished.then(
    () => {
      ghost.remove();
      flights.delete(ghost);
    },
    () => {
      ghost.remove();
      flights.delete(ghost);
    },
  );
}

// animateStep plays one step's feedback. A hit's force, from impact, sets how far the struck
// portrait recoils, how large its number rises and how far the striking card lunges; a heavy
// hit also jolts the table.
function animateStep(events: BattleEvent[], feedback: StepFeedback): void {
  const round = shownRound();
  const laid = round.plans.map((p) => slots(p, engine.cards));
  for (const side of [0, 1] as const) {
    const f = feedback.sides[side];
    const force = impact(f.damage);
    const labels = [
      f.damage > 0
        ? `<span class="combat-float combat-float--damage" style="--impact:${force}">−${f.damage} HP</span>`
        : "",
      f.blocked > 0 ? `<span class="combat-float combat-float--block">Blocked ${f.blocked}</span>` : "",
      f.block > 0 ? `<span class="combat-float combat-float--block">+${f.block} Block</span>` : "",
      f.block < 0 ? `<span class="combat-float combat-float--debuff">−${-f.block} Block</span>` : "",
      f.counter > 0 ? `<span class="combat-float combat-float--buff">Counter +${f.counter}</span>` : "",
      f.strength > 0 ? `<span class="combat-float combat-float--buff">Strength +${f.strength}</span>` : "",
      f.vulnerable > 0 ? `<span class="combat-float combat-float--debuff">Vulnerable +${f.vulnerable}</span>` : "",
      f.vulnerable < 0 ? `<span class="combat-float combat-float--buff">Vulnerable −${-f.vulnerable}</span>` : "",
    ].join("");
    elementById(`float-${side}`, HTMLDivElement).innerHTML = labels;
    if (f.damage > 0) {
      // Away from the table: the near fighter is pushed left, the far one right.
      const away = elementById(`fighter-${side}`, HTMLDivElement).matches(":first-child") ? -1 : 1;
      const reach = away * (5 + 11 * force);
      animateElement(
        elementById(`sprite-${side}`, HTMLImageElement),
        [
          { transform: "translateX(0) rotate(0)", filter: "brightness(1)" },
          {
            transform: `translateX(${reach}px) rotate(${away * 7 * force}deg)`,
            filter: `brightness(${1.4 + 0.5 * force})`,
            offset: 0.25,
          },
          { transform: `translateX(${-0.4 * reach}px) rotate(0)`, offset: 0.6 },
          { transform: "translateX(0) rotate(0)", filter: "brightness(1)" },
        ],
        { duration: 320 + 260 * force },
      );
    }
    if (f.blocked > 0 || f.block > 0)
      animateElement(
        elementById(`portrait-frame-${side}`, HTMLDivElement),
        [
          { boxShadow: "0 0 0 0 transparent" },
          { boxShadow: "0 0 0 9px color-mix(in srgb, var(--gh-color-block) 53%, transparent)" },
          { boxShadow: "0 0 0 15px transparent" },
        ],
        { duration: 600 },
      );
    if (f.strength !== 0 || f.counter !== 0 || f.vulnerable !== 0)
      animateElement(elementById(`chips-${side}`, HTMLDivElement), [
        { opacity: 0.3, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ]);
  }
  const active = new Set<string>();
  for (const event of events) {
    const { side, index } = cardBehind(event, round.plans, engine.cards);
    const key = `${side}:${index}`;
    if (active.has(key)) continue;
    active.add(key);
    const card = app.querySelector(`.card--track[data-side="${side}"][data-index="${index}"]`);
    if (event.kind === "HitLanded")
      lunge(card, elementById(`portrait-frame-${otherSide(side)}`, HTMLDivElement), impact(event.n + event.blocked));
    else
      animateElement(
        card,
        [{ transform: "translateY(0)" }, { transform: "translateY(-7px) scale(1.03)" }, { transform: "translateY(0)" }],
        { duration: 500 },
      );
  }
  if (Math.max(feedback.sides[0].damage, feedback.sides[1].damage) >= heavyHit)
    animateElement(
      app.querySelector(".duel-table"),
      [
        { translate: "0 0" },
        { translate: "-5px 2px" },
        { translate: "5px -2px" },
        { translate: "-3px 1px" },
        { translate: "2px 0" },
        { translate: "0 0" },
      ],
      { duration: 420, delay: 80, easing: "linear" },
    );
  for (const cancelled of feedback.cancelled) {
    const index = laid[cancelled.side]?.[cancelled.beat - 1]?.index;
    const card = app.querySelector(`.card--track[data-side="${cancelled.side}"][data-index="${index}"]`);
    animateElement(
      card,
      [
        { transform: "rotate(0)" },
        { transform: "rotate(-3deg)" },
        { transform: "rotate(3deg)" },
        { transform: "rotate(0)" },
      ],
      { duration: 350 },
    );
  }
}

// lunge drives a striking card toward the portrait it hits and back, further the harder the hit.
function lunge(card: Element | null, target: Element, force: number): void {
  if (card === null) return;
  const from = card.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const reach = (10 + 16 * force) / Math.max(1, Math.hypot(dx, dy));
  animateElement(
    card,
    [
      { transform: "translate(0, 0) scale(1)", easing: "cubic-bezier(0.5, 0, 0.75, 0)" },
      {
        transform: `translate(${dx * reach}px, ${dy * reach}px) scale(${1.04 + 0.04 * force})`,
        offset: 0.35,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      { transform: "translate(0, 0) scale(1)" },
    ],
    { duration: 520, easing: "linear" },
  );
}

function openDialog(dialog: HTMLDialogElement): void {
  showTip(null);
  if (!dialog.open) {
    dialog.showModal();
    dialog.append(tip);
  }
}
function closeBattleDialogs(): void {
  for (const dialog of app.querySelectorAll("dialog[open]")) if (dialog instanceof HTMLDialogElement) dialog.close();
  document.body.append(tip);
  showTip(null);
}
app.addEventListener(
  "close",
  () => {
    document.body.append(tip);
    showTip(null);
  },
  true,
);
app.addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLSelectElement) || event.target.id !== "playback-speed" || playback === null) return;
  const running = playback.timer !== null;
  const revealing = playback.revealTimer !== null;
  const remaining = revealing ? Math.max(0, playback.revealAt - performance.now()) : 0;
  stopPlaying();
  playback.speed = Number(event.target.value);
  if (revealing) queueReveal(playback, remaining);
  else if (running) startPlaying(false);
});
app.addEventListener("scroll", () => showTip(null), true);
app.addEventListener("click", (event) => {
  if (event.target instanceof HTMLDialogElement) {
    const box = event.target.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
      event.target.close();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlaying();
});

// copyMatchLog copies the log shown on the result screen; the text stays visible either way.
function copyMatchLog(): void {
  const area = elementById("match-log", HTMLTextAreaElement);
  area.select();
  const done = () => {
    elementById("copied", HTMLSpanElement).textContent = "Copied.";
  };
  const copyBySelection = () => {
    document.execCommand("copy");
    done();
  };
  if (navigator.clipboard?.writeText !== undefined)
    navigator.clipboard.writeText(area.value).then(done, copyBySelection);
  else copyBySelection();
}

// ---- Rendering

// pageOf is the page the state calls for: one per screen, one per deck stage, and the lobby's
// board or one of its matches. A move between two pages runs a view transition.
function pageOf(): string {
  if (lobby !== null && lobby.model.active && !lobby.model.inGame) return `lobby:${lobby.model.view?.id ?? ""}`;
  return flow.screen === "deck" ? `deck:${choosingClan ? "clan" : "cards"}` : flow.screen;
}
let drawnPage = "";
// The callbacks waiting on a draw the browser has deferred to capture the page it leaves; null
// while none is deferred.
let deferred: (() => void)[] | null = null;

// render draws the state. A move to another page lets the browser capture the page it leaves
// first, so the draw runs a frame later; after runs once the state is drawn. A render while a draw
// is deferred joins it, since that draw shows the state as it is by then.
function render(after?: () => void): void {
  if (deferred !== null) {
    if (after !== undefined) deferred.push(after);
    return;
  }
  const leaving = drawnPage !== "" && pageOf() !== drawnPage;
  if (!leaving || reducedMotion.matches || document.hidden || !("startViewTransition" in document)) {
    draw();
    after?.();
    return;
  }
  const waiting = after === undefined ? [] : [after];
  deferred = waiting;
  document.startViewTransition(() => {
    deferred = null;
    draw();
    for (const run of waiting) run();
  });
}

function draw(): void {
  const arrived = drawnPage !== "" && drawnPage !== pageOf();
  drawnPage = pageOf();
  if (lobby !== null && lobby.model.active && !lobby.model.inGame) {
    if (app.contains(tip)) document.body.append(tip);
    tip.hidden = true;
    lobby.render();
    if (arrived) arrive();
    return;
  }
  app.classList.remove("lobby");
  const screens = {
    title,
    library: libraryScreen,
    deck: deckScreen,
    handoff,
    plan: planScreen,
    playback: playbackScreen,
    result: resultScreen,
  };
  if (flow.screen === "playback" && app.dataset.screen === "playback") return;
  if (flow.screen === "lobby") throw new Error("The lobby draws the lobby screen.");
  const previousScreen = app.dataset.screen;
  const previousStage = app.dataset.stage;
  const replanning = flow.screen === "plan" && previousScreen === "plan";
  const repicking = flow.screen === "deck" && !choosingClan && previousScreen === "deck" && previousStage === "cards";
  const focus = document.activeElement;
  const key =
    focus instanceof HTMLElement && focus.matches(":focus-visible") && (focus.dataset.action ?? "") !== ""
      ? { action: focus.dataset.action, id: focus.dataset.id, beat: focus.dataset.beat }
      : null;
  handScroll = app.querySelector(".battle-hand")?.scrollLeft ?? 0;
  if (!replanning) {
    for (const ghost of flights) ghost.remove();
    flights.clear();
  }
  if (app.contains(tip)) document.body.append(tip);
  if (replanning) patchPlan();
  else if (repicking) patchDeck();
  else app.innerHTML = onlineBar() + screens[flow.screen]();
  app.dataset.screen = flow.screen;
  app.dataset.stage = flow.screen === "deck" ? (choosingClan ? "clan" : "cards") : "";
  app.classList.toggle("board--battle", ["plan", "playback"].includes(flow.screen));
  if (flow.screen === "plan") {
    const hand = app.querySelector(".battle-hand");
    if (hand === null) throw new Error("The plan screen has no hand.");
    hand.scrollLeft = previousScreen === "plan" ? handScroll : 0;
    // A phone's hand scrolls sideways; bring the card the guided match asks for into view.
    const coached = hand.querySelector(".card--coached")?.closest(".hand-entry");
    if (coached instanceof HTMLElement)
      hand.scrollLeft +=
        coached.getBoundingClientRect().left -
        hand.getBoundingClientRect().left -
        (hand.clientWidth - coached.offsetWidth) / 2;
    if (previousScreen === "plan" && key !== null) {
      let target: Element | null | undefined = [...app.querySelectorAll("[data-action]")].find(
        (el) =>
          el instanceof HTMLButtonElement &&
          el.dataset.action === key.action &&
          el.dataset.id === key.id &&
          el.dataset.beat === key.beat &&
          !el.disabled,
      );
      const seal = elementById("seal", HTMLButtonElement);
      target ??= seal.disabled ? app.querySelector('.battle-hand [data-action="addCard"]:not(:disabled)') : seal;
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }
  }
  if (flow.screen === "playback") {
    patchPlayback();
    const session = playing();
    queueReveal(session, reducedMotion.matches ? 450 : 1050);
  }
  if (arrived) arrive();
  dropStaleTip();
}

// arrive starts a new page at its top, with keyboard focus on what the page is about: its
// heading, the plan's heading or the coach's words, or the clash's Pause. The next Tab then starts
// inside the page instead of on its wordmark.
function arrive(): void {
  const landmark =
    app.dataset.screen === "plan"
      ? ".hand-zone__title .heading, .coach__words"
      : app.dataset.screen === "playback"
        ? "#play"
        : "h1, h2";
  const target = app.querySelector(landmark);
  if (target instanceof HTMLElement) {
    if (!(target instanceof HTMLButtonElement)) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  scrollTo(0, 0);
}

// The parts of the plan screen a pick, a clear or a send can change. The rest of the table stays
// in place, so the fighters' idle motion runs on across picks.
const planParts = [
  ".online-match-bar",
  ".track-row--yours",
  "#plan-status",
  ".coach__words",
  ".coach__step",
  ".hand-zone__hint",
  ".hand-zone__heading > .button-row",
  ".battle-hand",
];

function patchPlan(): void {
  const fresh = document.createElement("template");
  fresh.innerHTML = onlineBar() + planScreen();
  const before = handPlaces();
  for (const selector of planParts) {
    const now = app.querySelector(selector);
    const next = fresh.content.querySelector(selector);
    if (now === null && next === null) continue;
    if (now === null || next === null) throw new Error(`The plan screen lost or gained ${selector}.`);
    if (now.outerHTML === next.outerHTML) continue;
    // A live region is announced only when its text changes in place.
    if (now.getAttribute("role") === "status") now.textContent = next.textContent;
    else now.replaceWith(next);
  }
  slideHand(before);
}

// patchDeck carries a pick onto the deck screen in place: each card takes its new state, so its fade
// runs and keyboard focus stays on it, and the tray takes the new count.
function patchDeck(): void {
  const fresh = document.createElement("template");
  fresh.innerHTML = onlineBar() + deckScreen();
  for (const next of fresh.content.querySelectorAll(".card-grid > .card[data-id]")) {
    const now = app.querySelector(`.card-grid > .card[data-id="${next.getAttribute("data-id")}"]`);
    if (now === null) throw new Error("The deck screen lost a card.");
    now.className = next.className;
    now.setAttribute("aria-pressed", next.getAttribute("aria-pressed") ?? "false");
  }
  const tray = app.querySelector(".deck-tray");
  const next = fresh.content.querySelector(".deck-tray");
  if (tray === null || next === null) throw new Error("The deck screen has no tray.");
  const count = next.querySelector(".deck-count strong");
  const changed = tray.querySelector(".deck-count strong")?.textContent !== count?.textContent;
  tray.replaceWith(next);
  if (changed)
    animateElement(count, [{ scale: 1.5, color: "var(--gh-color-highlight)" }, { scale: 1 }], {
      duration: 360,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
}

// handPlaces is each hand card's entry and its offset in the fan, by card id.
function handPlaces(): Map<string, { entry: HTMLElement; left: number }> {
  const places = new Map<string, { entry: HTMLElement; left: number }>();
  for (const entry of app.querySelectorAll(".battle-hand .hand-entry")) {
    const id = entry.querySelector("[data-id]")?.getAttribute("data-id");
    if (entry instanceof HTMLElement && id !== null && id !== undefined)
      places.set(id, { entry, left: entry.offsetLeft });
  }
  return places;
}

// slideHand moves each card still in the hand from its place before to its place now, so the fan
// closes over a played card and opens for a returned one.
function slideHand(before: ReturnType<typeof handPlaces>): void {
  for (const [id, { entry, left }] of handPlaces()) {
    const was = before.get(id)?.left;
    if (was === undefined || Math.abs(was - left) < 1) continue;
    animateElement(entry, [{ translate: `${was - left}px 0` }, { translate: "0 0" }], {
      duration: 320,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  }
}

// dropStaleTip hides the tip once its anchor has been rendered away.
function dropStaleTip(): void {
  if (tipAnchor !== null && !tipAnchor.isConnected) showTip(null);
}

const clanPresentation = [
  {
    name: "Pickers",
    file: "pickers-selection-v1.jpg",
    tag: "QUICK HANDS · DIRTY TRICKS",
    description: "Strike before they’re ready. Nimble miners turn everyday tools into a flurry of blows.",
    style: "Fast attacks · Disruption",
  },
  {
    name: "Ironhide",
    file: "ironhide-selection-v1.jpg",
    tag: "HOLD FIRM · HIT HARD",
    description: "Weather the blow, then answer with force. Heavy shields and patient timing win the day.",
    style: "Block · Heavy hits",
  },
  {
    name: "Delvers",
    file: "delvers-selection-v5.jpg",
    tag: "BAD IDEAS · EXCELLENT TIMING",
    description: "Push your luck. Exploit an opening. Take the hit—and send the punishment back.",
    style: "Risk · Big payoffs · Retaliation",
  },
];
function clanChoicesHTML(): string {
  return `<div class="clan-choices">${clanPresentation
    .map((c) => {
      const available = Boolean(clanNamed(c.name));
      const body = `<div class="clan-choice__art"><img src="art/${c.file}" alt="" loading="eager"></div><div class="clan-choice__body"><span class="clan-choice__eyebrow">${c.tag}</span><h2 class="clan-choice__name">${emblem(c.name)}${c.name}</h2><p>${c.description}</p><span class="clan-choice__style">${c.style}</span><span class="clan-choice__cta">${available ? `Choose ${c.name} →` : "Coming soon"}</span></div>`;
      return `<button class="clan-choice clan-choice--${c.name.toLowerCase()}" type="button" data-action="clan" data-name="${c.name}" ${available ? "" : "disabled"}>${body}</button>`;
    })
    .join("")}</div>`;
}
function title(): string {
  return `<header class="masthead">${wordmarkHTML("./")}<nav class="home-nav" aria-label="Explore the game">${lobby !== null ? '<a href="leaderboard.html">Leaderboard</a>' : ""}<button type="button" data-action="tutorial">How to play</button><button type="button" data-action="library">Card library</button></nav></header>
    ${
      lobby === null && linkedMatch(location.hash) !== undefined
        ? `<section class="notice" role="status"><div><strong>That link opens an online match</strong><p>This copy of Gnomepit plays offline only, so it can’t open the match. Play the bot, or two players on one screen, here.</p></div></section>`
        : ""
    }
    <section class="intro intro--home">
      <div class="intro__copy"><span class="eyebrow">A TACTICAL CARD DUEL</span>
        <h1>Small gnomes.<br>Big grudges.</h1>
        <p>Choose a clan. Plot three beats. Settle your grudge beneath the mountain.</p>
        <div class="home-play">${
          lobby !== null
            ? `<button class="button" type="button" data-action="playMode" data-mode="online">Play online <span aria-hidden="true">→</span></button><button class="button button--secondary" type="button" data-action="playMode" data-mode="bot">Play the bot</button>`
            : `<button class="button" type="button" data-action="playMode" data-mode="bot">Play the bot <span aria-hidden="true">→</span></button><button class="button button--secondary" type="button" data-action="tutorial">How to play</button>`
        }</div>
        <p class="home-play__note">${lobby !== null ? "Online: 24 hours per move · needs the Adena wallet" : "Plays in this browser · no wallet needed"}</p>
      </div>
      <div class="intro__art"><img src="art/hall-hero-v2.jpg" alt="Gnomes gather around a card table in the underground hall"><span class="intro__art-label">WELCOME TO GNOMEPIT<span>Different clans. Shared grudges.</span></span></div>
    </section>
    <section class="home-library"><button type="button" class="text-button" data-action="library">Meet the clans and every card in the card library <span aria-hidden="true">→</span></button></section>
    <footer class="hall-footer"><span>Forged below. Settled at the table.</span><nav class="offline-row" aria-label="Play offline"><span>Play offline:</span><button type="button" class="text-button" data-action="playMode" data-mode="bot">Bot</button><button type="button" class="text-button" data-action="playMode" data-mode="hotseat">Two players</button><button type="button" class="text-button" data-action="library">Card library</button></nav></footer>
    <dialog class="offer" id="tutorial-offer" aria-labelledby="offer-title"><h2 id="offer-title">${coach.offer.title}</h2><p>${coach.offer.body}</p>
      <div class="button-row"><button class="button" type="button" data-action="tutorial">${coach.offer.start}</button><button class="button button--secondary" type="button" data-action="tutorialSkip">${coach.offer.skip}</button></div></dialog>`;
}
function libraryScreen(): string {
  return `${masthead("Know your tools. Read your rival.")}<div class="section-intro"><div><span class="eyebrow">THE CLAN ARCHIVES</span><h1 class="heading">Card library</h1><p>Every card available in this build. Read the rules and find your favorites.</p></div><button class="button button--secondary" data-action="home">Back to the hall</button></div>${collectionHTML()}`;
}
function clanSelectionScreen(): string {
  const heading = flow.mode === "hotseat" ? `Player ${flow.acting + 1}, choose your clan` : "Choose your clan";
  return `${masthead("Different clans. Shared grudges.")}<section class="clan-selection" aria-labelledby="clan-select-title"><nav class="setup-steps" aria-label="Match setup"><span aria-current="step">1 · Choose clan</span><span>2 · Build deck</span><span>3 · Plan your round</span></nav><div class="section-intro"><div><span class="eyebrow">CHOOSE YOUR ALLEGIANCE</span><h1 id="clan-select-title">${heading}</h1><p>Find your fighting style. You’ll choose your cards next.</p></div>${flow.mode === "online" ? "" : '<button class="button button--secondary" data-action="home">Back to the hall</button>'}</div>${clanChoicesHTML()}<p class="clan-selection__note">${engine.clans.some((c) => c.name === "Delvers") ? "Every clan brings its own tools. Your timing makes the difference." : "The Delvers are preparing their tools. Choose Pickers or Ironhide to play now."}</p></section>`;
}

function deckScreen(): string {
  if (choosingClan) return clanSelectionScreen();
  const deck = picking();
  const clan = clanNamed(deck.clan);
  if (clan === undefined) throw new Error(`No clan ${deck.clan}`);
  const rare = rareOf(clan, engine.cards);
  const legal = engine.legalDeck({ clan: deck.clan, deck: deck.picks });
  const heading =
    flow.mode === "bot" || flow.mode === "online" ? "Pick your deck" : `Player ${flow.acting + 1} picks a deck`;
  const pool = clan.cards
    .map((id) => {
      const kept = deck.picks.includes(id);
      return cardHTML(cardOf(engine.cards, id), {
        selected: kept,
        pressed: kept,
        locked: id === rare,
        action: "toggle",
      });
    })
    .join("");
  return `
    ${masthead()}
    <nav class="setup-steps" aria-label="Match setup"><button class="text-button" data-action="changeClan">1 · Choose clan</button><span aria-current="step">2 · Build deck</span><span>3 · Plan your round</span></nav>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${heading}</h2><span class="hint">Every card starts in. Leave out ${clan.cards.length - deckSize}; the Rare stays.</span></div>
      <div class="clan-banner clan-banner--${deck.clan.toLowerCase()}">${portraitHTML(deck.clan, `class="clan-banner__portrait"`)}<div><span class="eyebrow">CHOOSE YOUR ALLEGIANCE</span><h3 class="heading clan-banner__name">${emblem(deck.clan)}${deck.clan}</h3><p>${clanLook[deck.clan]?.blurb ?? ""}</p></div><button class="button button--secondary" type="button" data-action="changeClan">Change clan</button></div>
      <div class="card-grid">${pool}</div>
      <div class="deck-tray"><span class="deck-count"><strong>${deck.picks.length}</strong> of ${clan.cards.length} cards kept</span><button class="button" type="button" data-action="deckReady" ${legal ? "" : "disabled"}>${readiness(deck)}</button></div>
    </section>`;
}

function handoff(): string {
  if (flow.after === null) throw new Error("The hand-off leads nowhere.");
  const next = flow.after.acting;
  const clan = flow.clans[next] ?? "";
  const task =
    flow.after.screen === "plan"
      ? `Player ${next + 1} plans round ${flow.state?.round ?? 1} in secret.`
      : `Player ${next + 1} chooses a clan and builds a deck in secret.`;
  return `
    <div class="curtain">
      <section class="handoff" aria-labelledby="handoff-title">
        ${clan === "" ? "" : `<div class="handoff__crest fighter--${clan.toLowerCase()}">${portraitHTML(clan, 'class="sprite"')}</div>`}
        <h1 id="handoff-title">Pass to Player ${next + 1}</h1>
        <p>${task} Player ${2 - next}, look away.</p>
        <button class="button" type="button" data-action="handoffDone">I am Player ${next + 1}</button>
      </section>
    </div>`;
}

function battleHeaderHTML(round: number, phase: string): string {
  return `<header class="battle-header"><span class="battle-header__brand"><a class="wordmark" href="./">Gnomepit</a><span class="battle-header__note">A quarrel in three rounds</span></span>${roundHTML(round, phase)}
    <button class="button button--secondary battle-intel-button" type="button" data-action="intel">Opponent & history</button></header>`;
}

function roundHTML(round: number, phase: string): string {
  return `<div class="round-medallion"><span class="eyebrow">${phase}</span><span class="round-medallion__number">${round}<small> / 3</small></span>
    <div class="round-pips" aria-label="Round ${round} of 3">${[1, 2, 3].map((n) => `<span class="${n === round ? "round-pip--current" : n < round ? "round-pip--done" : ""}"></span>`).join("")}</div></div>`;
}

function beatMarkersHTML(): string {
  return `<div class="beat-markers">${[1, 2, 3].map((n) => `<span class="timeline__beat" id="beat-${n}"><span class="beat-marker__gem" aria-hidden="true"></span><span><span class="beat-marker__word">Beat </span>${n}</span></span>`).join("")}</div>`;
}

function battleDialogsHTML(viewer: Side): string {
  const opponent = otherSide(viewer);
  const names = battleNames();
  const { decks, clans } = underway();
  const past = flow.screen === "playback" ? flow.rounds.slice(0, -1) : flow.rounds;
  const known = knownCards(past, opponent, clanNamed(clans[opponent])?.cards ?? [], decks[opponent], engine.cards);
  const knownHead = known.open
    ? `<h3 class="heading">${possessive(names[opponent])} deck</h3><p class="muted">Decks are open from round 2. Spent cards show the round they were played in; the current plan stays hidden until the reveal.</p>`
    : `<h3 class="heading">${possessive(names[opponent])} clan pool</h3><p class="muted">${deckSize} of these ${known.cards.length} cards are in their deck. The Rare always is. Decks open from round 2; the current plan stays hidden until the reveal.</p>`;
  const knownGrid = (list: KnownCards["cards"]) =>
    `<div class="card-grid">${list.map(({ id, spentRound }) => cardHTML(cardOf(engine.cards, id), { spentRound })).join("")}</div>`;
  const left = known.cards.filter((c) => c.spentRound === 0);
  const spent = known.cards.filter((c) => c.spentRound > 0);
  const knownCardsHTML = known.open
    ? `<span class="label">Still to play · ${left.length}</span>${knownGrid(left)}${spent.length > 0 ? `<span class="label">Already played · ${spent.length}</span>${knownGrid(spent)}` : ""}`
    : knownGrid(known.cards);
  const history = past
    .map(
      (round, i) =>
        `<section class="stack"><h3 class="heading">Round ${i + 1}</h3>${([0, 1] as const).map((side) => `<div><span class="label">${names[side]}</span><div class="row">${smallCards(round.plans[side])}</div></div>`).join("")}</section>`,
    )
    .join("");
  const played = past
    .map(
      (round, i) =>
        `<section class="stack"><h3 class="heading">Round ${i + 1}</h3><div class="card-grid">${round.plans[viewer].map((id) => cardHTML(cardOf(engine.cards, id))).join("")}</div></section>`,
    )
    .join("");
  return `<dialog class="battle-drawer" id="played-cards" aria-labelledby="played-title"><div class="dialog-heading"><h2 class="heading" id="played-title">Your played cards</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close played cards">×</button></div>${played !== "" ? played : `<p class="muted">No cards played yet.</p>`}</dialog><dialog class="battle-drawer" id="battle-info" aria-labelledby="intel-title"><div class="dialog-heading"><h2 class="heading" id="intel-title">Across the table</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close opponent information">×</button></div>
    <section class="stack">${knownHead}
      ${knownCardsHTML}</section>
    <section class="stack intel-history"><h3 class="heading">Earlier rounds</h3>${history !== "" ? history : `<p class="muted">No rounds played yet.</p>`}</section></dialog>
    <dialog class="card-reader" id="card-reader" aria-label="Card details"><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close card details">×</button><div id="reader-content" class="stack"></div></dialog>`;
}

function planScreen(): string {
  const me = flow.acting,
    opponent = otherSide(me);
  const { state, decks, clans } = underway();
  const names = battleNames();
  const used = beatsUsed(plan, engine.cards);
  const sealable = isSealable(plan, legalPlans);
  const handIds = [...basics, ...decks[me].filter((id) => !state.gnomes[me].spent.includes(id) && !plan.includes(id))];
  const playedCount = flow.rounds.reduce((n, round) => n + round.plans[me].length, 0);
  const coached = coachedCard();
  const hand = handIds
    .map((id, index) => {
      const c = cardOf(engine.cards, id);
      return `<div class="hand-entry" style="--hand-order:${index};--hand-tilt:${(index - (handIds.length - 1) / 2) * 4}deg;--hand-rise:${Math.pow(index - (handIds.length - 1) / 2, 2) * 2}px">
      ${cardHTML(c, { action: matchMedia("(hover: none)").matches ? "inspectCard" : "addCard", hand: true, dimmed: !canAdd(plan, id, engine.cards, available()), coached: id === coached })}
      <button class="card-inspect" type="button" data-action="inspectCard" data-id="${id}" aria-label="Details: ${c.name}" tabindex="-1">Details</button></div>`;
    })
    .join("");
  const backs = [1, 2, 3].map(() => cardBackHTML(clans[opponent])).join("");
  const practice = flow.mode === "tutorial" && guidedRound().rails !== null ? guidedRound().opponent : null;
  const opponentTrack =
    practice === null
      ? `<div class="plan-track plan-track--hidden" aria-label="Opponent plan hidden">${backs}</div>`
      : `<div class="plan-track">${practiceTrackHTML(practice)}</div>`;
  const title =
    flow.mode === "tutorial"
      ? coachHTML(sealable)
      : `<div class="hand-zone__title"><h2 class="heading">Plot your next move</h2><span class="muted" id="plan-status" role="status">${sealable ? "Your plan is ready. Confirm it when you're sure." : "Play cards to fill all three beats."}</span></div>`;
  return `${battleHeaderHTML(state.round, "Planning")}
    <section class="duel-table" aria-label="Round ${state.round} battle table">
      <div class="duel-fighters">${gnomeHTML(me, state.gnomes[me], names[me])}${gnomeHTML(opponent, state.gnomes[opponent], names[opponent])}</div>
      <div class="duel-center">
        <div class="track-row track-row--opponent"><div class="track-row__label"><span class="label">${possessive(names[opponent])} plan</span><span class="track-hint">${practice === null ? "Sealed in secret" : "Shown for practice"}</span></div>${opponentTrack}</div>
        ${beatMarkersHTML()}
        <div class="track-row track-row--yours"><div class="track-row__label"><span class="label">Your plan</span><span class="track-hint">${used} of 3 beats filled</span></div>${slotsHTML()}</div>
        <p class="table-caption">Choose the order. Anticipate their move.</p>
      </div>
    </section>
    <section class="hand-zone" aria-label="Your hand"><div class="hand-zone__heading">
      ${title}
      <div class="hand-zone__hint"><span class="label">Your hand <span>${counted(handIds.length, "card")}</span></span><span class="muted">Lift a card to read · click to play · tap to inspect</span></div>
      <div class="button-row"><button class="button button--secondary" type="button" data-action="clearPlan" ${plan.length > 0 ? "" : "disabled"}>Clear</button><button class="button" type="button" data-action="seal" id="seal" ${sealable && !onlineSending ? "" : "disabled"}${onlineSending ? ' aria-busy="true"' : ""}>${flow.mode === "online" ? (onlineMatch().intent === "challenge" ? "Post challenge" : onlineMatch().intent === "accept" ? "Accept challenge" : "Send plan") : "Seal plan"}</button></div></div>
      <div class="hand-layout"><div class="battle-hand card-grid" style="--hand-count:${handIds.length}">${hand}</div><button class="played-pile" type="button" data-action="playedCards" ${playedCount > 0 ? "" : "disabled"} aria-label="Open played cards, ${counted(playedCount, "card")}">${cardBackHTML(clans[me], "pile-back")}<span class="label">Played cards</span><span class="muted">${counted(playedCount, "card")} · inspect</span></button></div></section>
    ${battleDialogsHTML(me)}`;
}

// Cards retain playing-card proportions; their brackets span the occupied beats.
function slotsHTML(): string {
  let beat = 0;
  const filled = plan.map((id, index) => {
    const c = cardOf(engine.cards, id);
    const from = beat;
    beat += c.cost;
    return `<div class="slot" data-plan-index="${index}" style="--beats:${c.cost}">${cardHTML(c, { track: true, action: "clearFrom", data: `data-beat="${from}"` })}<span class="track-note">${c.parry > 0 ? `Guards ${c.cost === 1 ? `beat ${beat}` : `beats ${from + 1}–${beat}`}` : c.cost > 1 ? `Lands on beat ${beat}` : "Click to remove"}</span></div>`;
  });
  const coached = coachedCard();
  const empty = Array.from(
    { length: 3 - beat },
    (_, index) =>
      `<div class="slot"><div class="slot__well"><span class="slot__number">${beat + index + 1}</span>${index === 0 && coached !== undefined ? `<span class="slot__coach">${cardOf(engine.cards, coached).name} goes here</span>` : "<span>Choose a card</span>"}</div><span class="track-note">Empty beat</span></div>`,
  );
  return `<div class="plan-track plan-track--yours">${filled.join("")}${empty.join("")}</div>`;
}

// trackNote names the beats a revealed card guards or lands on; from and to are 1-based.
function trackNote(c: Card, from: number, to: number): string {
  if (c.parry > 0) return `Guards ${from === to ? `beat ${to}` : `beats ${from}–${to}`}`;
  return c.cost > 1 ? `Lands on beat ${to}` : `Beat ${to}`;
}

// practiceTrackHTML lays out the guided match opponent's plan face up, as small cards that show
// the full card on hover or focus, so the row stays as short as the hidden backs it stands for.
function practiceTrackHTML(ids: number[]): string {
  let beat = 0;
  return ids
    .map((id) => {
      const c = cardOf(engine.cards, id);
      const from = beat + 1;
      beat += c.cost;
      return `<div class="slot" style="--beats:${c.cost}">${cardHTML(c, { small: true })}<span class="track-note">${trackNote(c, from, beat)}</span></div>`;
    })
    .join("");
}

// coachHTML is the guided match's coach strip: the round's lesson title, what to do now, and
// the step count while the rails lead.
function coachHTML(sealable: boolean): string {
  const round = underway().state.round;
  const words = coach.rounds[round - 1];
  if (words === undefined) throw new Error(`The coach has no words for round ${round}.`);
  const { rails } = guidedRound();
  const line = rails === null ? words.hint : coachedCard() !== undefined ? words.steps?.[plan.length] : words.seal;
  const step =
    rails === null
      ? `<button class="button button--secondary" type="button" data-action="intel">${words.look}</button>`
      : `<span class="coach__step">Round ${round} · step ${plan.length + 1} of ${(words.steps?.length ?? 0) + 1}</span>`;
  return `<div class="coach">${portraitHTML("Pickers", 'class="coach__portrait"')}<p class="coach__words"><strong>${words.title}</strong> ${line}</p>${step}
    <button class="text-button coach__skip" type="button" data-action="tutorialLeave">Skip the guide</button>
    <span class="coach__status" id="plan-status" role="status">${sealable ? "Your plan is ready. Confirm it when you're sure." : "Play cards to fill all three beats."}</span></div>`;
}

function playbackScreen(): string {
  const round = shownRound();
  const names = battleNames();
  const { clans } = underway();
  const session = playing();
  const me = session.viewer,
    opponent = otherSide(me);
  const row = (side: Side) => {
    let beat = 0;
    return `<div class="track-row ${side === me ? "track-row--yours" : "track-row--opponent"}"><div class="track-row__label"><span class="label">${possessive(names[side])} plan</span><span class="track-hint">Revealed</span></div><div class="plan-track">${round.plans[
      side
    ]
      .map((id, index) => {
        const c = cardOf(engine.cards, id);
        const from = beat + 1;
        beat += c.cost;
        return `<div class="slot" style="--beats:${c.cost};--reveal-delay:${index * 140}ms">${cardHTML(c, { track: true, action: "inspectCard", data: `data-side="${side}" data-index="${index}"`, sealed: side === me ? "" : clans[side] })}<span class="track-note">${trackNote(c, from, beat)}</span></div>`;
      })
      .join("")}</div></div>`;
  };
  return `${battleHeaderHTML(round.state.round - 1, "The clash")}
    <section class="duel-table duel-table--playback" aria-label="Round ${round.state.round - 1} battle table">
      <div class="duel-fighters">${gnomeHTML(me, session.start[me], names[me])}${gnomeHTML(opponent, session.start[opponent], names[opponent])}</div>
      <div class="duel-center">
        ${row(opponent)}${beatMarkersHTML()}${row(me)}
        <p class="battle-event" id="battle-event" role="status" aria-live="polite">Both plans revealed. The clash begins.</p>
      </div>
    </section>
    <div class="battle-controls playback-controls">${flow.mode === "tutorial" ? `<div class="coach coach--lesson" id="lesson" hidden>${portraitHTML("Pickers", 'class="coach__portrait"')}<p class="coach__words" id="lesson-text" role="status"></p><button class="button" type="button" data-action="lessonDone" id="lesson-continue" aria-describedby="lesson-text">Continue</button></div>` : ""}<div class="button-row"><button class="button" type="button" data-action="play" id="play">Pause</button><button class="button button--secondary" type="button" data-action="next" id="next">Next step</button><button class="button button--secondary" type="button" data-action="skip" id="skip">Skip</button></div>
      <div class="playback-meta"><span class="label" id="progress"></span><button class="button button--secondary round-log-button" type="button" data-action="roundLog">Round details</button><label class="speed-control">Speed <select id="playback-speed"><option value=".7">Slow</option><option value="1" selected>Normal</option><option value="1.7">Fast</option></select></label></div><div class="battle-finish" id="finish"></div></div>
    <dialog class="battle-drawer" id="round-log" aria-labelledby="log-title"><div class="dialog-heading"><h2 class="heading" id="log-title">Round details</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close round details">×</button></div><p class="muted">Every hit, block and interruption so far.</p><div class="log log--grid" id="log"></div></dialog>
    ${battleDialogsHTML(me)}`;
}

function patchPlayback(): void {
  if (playback === null || flow.screen !== "playback" || app.dataset.screen !== "playback") return;
  const round = shownRound();
  const { steps, shown, lines, start } = playback;
  const current = shown > 0 ? steps[shown - 1] : undefined;
  const vitals = current === undefined ? start : eventAt(round, current.to - 1).after;
  for (const side of [0, 1] as const) {
    elementById(`hp-fill-${side}`, HTMLDivElement).style.width = hpWidth(vitals[side].hp);
    elementById(`hp-ghost-${side}`, HTMLDivElement).style.width = hpWidth(vitals[side].hp);
    elementById(`hp-num-${side}`, HTMLSpanElement).textContent = `${vitals[side].hp} / ${flow.hp}`;
    elementById(`chips-${side}`, HTMLDivElement).innerHTML = chipsHTML(vitals[side]);
    elementById(`fighter-${side}`, HTMLDivElement).classList.toggle("fighter--defeated", vitals[side].hp <= 0);
  }
  const laid = round.plans.map((p) => slots(p, engine.cards));
  const acting = new Set(
    current !== undefined
      ? round.events.slice(current.from, current.to).map((ev) => {
          const { side, index } = cardBehind(ev, round.plans, engine.cards);
          return `${side}:${index}`;
        })
      : [],
  );
  const until = current?.to ?? 0;
  const cancelled = new Set(
    round.events
      .slice(0, until)
      .filter((ev) => ev.kind === "Cancelled")
      .map((ev) => `${ev.side}:${laid[ev.side]?.[ev.beat - 1]?.index}`),
  );
  for (const b of [1, 2, 3]) {
    elementById(`beat-${b}`, HTMLSpanElement).classList.toggle("timeline__beat--current", current?.beat === b);
    elementById(`beat-${b}`, HTMLSpanElement).classList.toggle("timeline__beat--past", (current?.beat ?? 0) > b);
  }
  for (const el of app.querySelectorAll(".card--track[data-side][data-index]")) {
    if (!(el instanceof HTMLElement)) continue;
    const key = `${el.dataset.side}:${el.dataset.index}`;
    el.classList.toggle("card--acting", acting.has(key));
    el.classList.toggle("card--cancelled", cancelled.has(key));
    el.setAttribute(
      "aria-label",
      `${cardOf(engine.cards, Number(el.dataset.id)).name}${cancelled.has(key) ? ", cancelled" : ""}. Inspect card.`,
    );
  }
  elementById("log", HTMLDivElement).innerHTML = logHTML(round, steps, shown, lines);
  const done = shown >= steps.length;
  const names = battleNames();
  const caption = done
    ? `Round complete. ${names[playback.viewer]}: ${vitals[playback.viewer].hp} HP · ${names[otherSide(playback.viewer)]}: ${vitals[otherSide(playback.viewer)].hp} HP.`
    : current !== undefined
      ? lines.slice(current.from, current.to).join(" · ")
      : "Both plans revealed. The clash begins.";
  const battleEvent = elementById("battle-event", HTMLParagraphElement);
  if (battleEvent.textContent !== caption) battleEvent.textContent = caption;
  const held = playback.lesson !== null;
  elementById("next", HTMLButtonElement).disabled = done || held;
  elementById("skip", HTMLButtonElement).disabled = done || held;
  elementById("play", HTMLButtonElement).disabled = done || held;
  if (flow.mode === "tutorial") {
    const lesson = elementById("lesson", HTMLDivElement);
    lesson.hidden = playback.lesson?.ready !== true;
    elementById("lesson-text", HTMLParagraphElement).textContent =
      playback.lesson?.ready === true ? playback.lesson.text : "";
  }
  elementById("play", HTMLButtonElement).textContent =
    playback.timer !== null || playback.revealTimer !== null ? "Pause" : "Play";
  elementById("progress", HTMLSpanElement).textContent = done
    ? "Round resolved"
    : current !== undefined
      ? `Beat ${current.beat} · ${current.phase}`
      : "Plans revealed";
  elementById("finish", HTMLDivElement).innerHTML = done && !held ? finishHTML() : "";
  // A control that just turned off would strand keyboard focus; the round's way on takes it.
  const active = document.activeElement;
  const wayOn = app.querySelector("#finish .button");
  if (done && !held && active instanceof HTMLButtonElement && active.disabled && wayOn instanceof HTMLElement)
    wayOn.focus({ preventScroll: true });
  dropStaleTip();
}

// eventAt is the round's event at index i, which every step's range holds.
function eventAt(round: Round, i: number): BattleEvent {
  const event = round.events[i];
  if (event === undefined) throw new RangeError(`the round has no event ${i}`);
  return event;
}

function logHTML(round: Round, steps: Step[], shown: number, lines: string[]): string {
  const step = shown > 0 ? steps[shown - 1] : undefined;
  const until = step?.to ?? 0;
  const fresh = step?.from ?? 0;
  const groups: { beat: number; lines: string[] }[] = [];
  for (let i = 0; i < until; i++) {
    const beat = eventAt(round, i).beat;
    const last = groups.at(-1);
    const line = `<span class="log__line ${i >= fresh ? "log__line--new" : ""}">${lines[i]}</span>`;
    if (last !== undefined && last.beat === beat) last.lines.push(line);
    else groups.push({ beat, lines: [line] });
  }
  if (until === 0) return `<span class="muted">Press Next to resolve the first step.</span>`;
  return groups
    .map(
      (g) =>
        `<span class="log__beat" style="grid-row: span ${g.lines.length}">Beat ${g.beat}</span>${g.lines.join("")}`,
    )
    .join("");
}

function finishHTML(): string {
  if (flow.mode === "online") {
    const context = onlineMatch();
    return `<div class="button-row"><button class="button" data-action="playbackDone">${context.intent === "move" && context.review ? "Back to match" : "Plan your next round"}</button></div>`;
  }
  const { state } = underway();
  if (flow.result === "ongoing") {
    return `<div class="button-row"><button class="button" type="button" data-action="playbackDone">Round ${state.round}</button></div>`;
  }
  const { title, detail } = verdict(flow.rounds, flow.result, battleNames());
  return `
    <p class="banner">${title}. ${detail}</p>
    <div class="button-row"><button class="button" type="button" data-action="playbackDone">Continue</button></div>`;
}

function resultScreen(): string {
  if (flow.mode === "tutorial") return guidedResultHTML();
  const names = battleNames();
  const { state, decks } = underway();
  const unplayed = ([0, 1] as const)
    .map((side) => {
      const cards = decks[side]
        .filter((id) => !state.gnomes[side].spent.includes(id))
        .map((id) => cardHTML(cardOf(engine.cards, id), { small: true }))
        .join("");
      return `<div class="stack"><span class="label">${possessive(names[side])} unplayed cards</span><div class="row">${cards !== "" ? cards : `<span class="muted">Every card was played.</span>`}</div></div>`;
    })
    .join("");
  return `
    ${masthead()}
    ${resultStageHTML(
      verdict(flow.rounds, flow.result, names),
      "",
      `<button class="button" type="button" data-action="rematch">Rematch</button>
      <button class="button button--secondary" type="button" data-action="newMatch">New match</button>`,
    )}
    <details class="result-details">
      <summary>Match log and unplayed cards</summary>
      <div class="split">${unplayed}</div>
      <div class="stack">
        <div class="frame__head"><span class="label">Match log</span><span class="button-row"><button class="button button--secondary" type="button" data-action="copyLog">Copy match log</button><span class="muted" id="copied"></span></span></div>
        <textarea class="log-text" id="match-log" readonly rows="10">${escapeHTML(matchLog(flow.rounds, flow.result, { cards: engine.cards, names }))}</textarea>
      </div>
    </details>`;
}

// guidedResultHTML closes the guided match on its verdict and leads where the player was heading
// before it.
function guidedResultHTML(): string {
  return `
    ${masthead()}
    ${resultStageHTML(
      verdict(flow.rounds, flow.result, battleNames()),
      `<p class="result-stage__note">${coach.result.real}</p>`,
      `<button class="button" type="button" data-action="tutorialOnward">${coach.result.onward[onward ?? "home"]}</button>
      <button class="button button--secondary" type="button" data-action="tutorial"${onward === null ? "" : ` data-mode="${onward}"`}>${coach.result.again}</button>`,
    )}`;
}

// resultStageHTML stages a finished match: the verdict between the two champions, the winner lit
// and the loser greyed, the viewer's champion nearest, then body and the actions.
function resultStageHTML(v: Verdict, body: string, actions: string): string {
  const viewer: Side = flow.mode === "hotseat" ? flow.acting : 0;
  const names = battleNames();
  const { state, clans } = underway();
  const champion = (side: Side, place: "near" | "far") => {
    const outcome = v.winner === null ? "" : v.winner === side ? "result-champion--winner" : "result-champion--loser";
    return `<figure class="result-champion result-champion--${place} fighter--${clans[side].toLowerCase()} ${outcome}"><div class="result-champion__portrait">${portraitHTML(clans[side], 'class="sprite"')}</div><figcaption><span class="result-champion__name">${names[side]}</span><span class="label">${clans[side]}</span><span class="result-champion__hp">${Math.max(0, state.gnomes[side].hp)} HP</span></figcaption></figure>`;
  };
  const blow =
    v.blow === null || v.winner === null
      ? ""
      : `<p class="result-blow"><span class="label">${possessive(names[v.winner])} ${v.blow.finishing ? "finishing blow" : "hardest hit"}</span>${cardHTML(cardOf(engine.cards, v.blow.card), { small: true })}<span>${v.blow.damage} damage in round ${v.blow.round}</span></p>`;
  return `<section class="result-stage" aria-labelledby="result-title">
      <div class="result-stage__duel">
        <div class="result-verdict"><h1 id="result-title">${v.title}</h1><p>${v.detail}</p>${blow}</div>
        ${champion(viewer, "near")}${champion(otherSide(viewer), "far")}
      </div>
      ${body}
      <div class="button-row">${actions}</div>
    </section>`;
}

// gnomeHTML draws a side's portrait, HP bar and status chips from a gnome or vitals object.
function gnomeHTML(side: Side, vitals: ShownVitals, name: string): string {
  const named = flow.clans[side];
  const clan = named === null || named === "" ? "Shared" : named;
  return `<div class="fighter fighter--${clan.toLowerCase()}" id="fighter-${side}">
    <div class="fighter__portrait" id="portrait-frame-${side}">${portraitHTML(clan, `class="sprite" id="sprite-${side}"`)}<span class="fighter__crest">${emblem(clan)}</span><div class="combat-floats" id="float-${side}" aria-hidden="true"></div></div>
    <div class="fighter__vitals"><div class="fighter__name"><h2>${name}</h2><span class="label">${clan}</span></div><div class="hp__row"><span class="fighter__health-label">Health</span><span class="number" id="hp-num-${side}">${vitals.hp} / ${flow.hp}</span></div>
    <div class="hp__bar"><div class="hp__ghost" id="hp-ghost-${side}" style="width:${hpWidth(vitals.hp)}"></div><div class="hp__fill" id="hp-fill-${side}" style="width:${hpWidth(vitals.hp)}"></div></div><div class="chips" id="chips-${side}">${chipsHTML(vitals)}</div></div></div>`;
}

function chipsHTML(vitals: ShownVitals): string {
  return (
    [
      ["block", "Block"],
      ["counter", "Counter"],
      ["vulnerable", "Vulnerable"],
      ["strength", "Strength"],
    ] as const
  )
    .filter(([key]) => (vitals[key] ?? 0) > 0)
    .map(
      ([key, label]) => `<span class="chip chip--${key}" data-kw="${key}" tabindex="0">${label} ${vitals[key]}</span>`,
    )
    .join("");
}

function hpWidth(hp: number): string {
  return `${Math.max(0, Math.min(100, (hp / underway().hp) * 100))}%`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card.
// pressed marks a toggle's state, locked a toggle that does nothing, coached the card the
// guided match asks for next. A small card shows cost, name and badges and peeks the full
// card on hover or focus. spentRound, when above 0, marks the round the card was played in.
// sealed names the clan whose back the card shows until it turns over.
function cardHTML(
  c: Card,
  {
    selected = false,
    dimmed = false,
    small = false,
    locked = false,
    pressed = null,
    action = null,
    data = "",
    spentRound = 0,
    hand = false,
    track = false,
    coached = false,
    sealed = "",
  }: CardOptions = {},
): string {
  const clan = cardClan(c);
  const classes = [
    "card",
    `card--${clan.toLowerCase()}`,
    hand ? "card--hand" : "",
    track ? "card--track" : "",
    c.rare ? "card--rare" : "",
    c.special ? "" : "card--basic",
    selected ? "card--selected" : "",
    dimmed ? "card--dimmed" : "",
    small ? "card--small" : "",
    locked ? "card--locked" : "",
    coached ? "card--coached" : "",
    sealed !== "" ? "card--sealed" : "",
    spentRound > 0 ? "card--spent" : "",
  ].join(" ");
  const state = [
    pressed === null ? "" : `aria-pressed="${pressed}"`,
    locked ? `aria-disabled="true" title="The Rare stays in"` : "",
    small ? `data-peek="${c.id}"` : "",
  ].join(" ");
  // A plain full card lets keyboard and touch reach the rules behind its words and badges.
  const tips = action === null && !small;
  const tipStop = tips ? ' tabindex="0"' : "";
  const badges = [
    c.tier !== "Normal"
      ? `<span class="badge badge--${c.tier.toLowerCase()}" data-kw="${c.tier.toLowerCase()}"${tipStop}>${c.tier}</span>`
      : "",
    c.rare
      ? `<span class="badge badge--rare" data-kw="rare"${tipStop}><span aria-hidden="true">✦</span> Rare</span>`
      : "",
    spentRound > 0 ? `<span class="badge badge--spent">Spent R${spentRound}</span>` : "",
  ].join("");
  const body = small
    ? `<span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span><span class="card__foot">${badges}</span>`
    : `
    <span class="card__ornament" aria-hidden="true"></span>
    <div class="card__head"><span class="card__cost" aria-label="${counted(c.cost, "beat")}">${c.cost}</span><span class="card__name">${c.name}</span></div>
    ${artHTML(c)}
    <div class="card__text">${markKeywords(c.text, { focusable: tips })}</div>
    <div class="card__foot"><span class="card__clan">${emblem(clan)}${clan}</span>${badges}</div>${sealed !== "" ? cardBackHTML(sealed, "card__back") : ""}`;
  if (action === null) return `<div class="${classes}" ${state} ${small ? `tabindex="0"` : ""} ${data}>${body}</div>`;
  return `<button class="${classes}" type="button" data-action="${action}" data-id="${c.id}" ${hand ? `aria-label="${escapeHTML(`${c.name}, ${counted(c.cost, "beat")}. ${c.text}`).replaceAll('"', "&quot;")}"` : ""} ${state} ${data} ${dimmed ? "disabled" : ""}>${body}</button>`;
}

// cardBackHTML is the back of a card of clan, hidden from assistive technology; an empty clan, a
// rival still to come, shows the shared back.
function cardBackHTML(clan: string, extra = ""): string {
  return `<span class="card-back card-back--${(clan === "" ? "shared" : clan).toLowerCase()}${extra === "" ? "" : ` ${extra}`}" aria-hidden="true"><span>${emblem(clan)}</span></span>`;
}

function smallCards(ids: number[]): string {
  return ids.map((id) => cardHTML(cardOf(engine.cards, id), { small: true })).join("");
}

function clanNamed(name: string | undefined): Clan | undefined {
  return engine.clans.find((c) => c.name === name);
}

// openLinkedMatch opens the match the page's #match= fragment names, and says whether it named one.
async function openLinkedMatch(): Promise<boolean> {
  const id = linkedMatch(location.hash);
  if (lobby === null || id === undefined) return false;
  flow = { ...initial, screen: "lobby" };
  await lobby.enter(id);
  return true;
}

if (!(await openLinkedMatch())) render();
// A notification's click on an open page changes only its fragment, which loads nothing.
addEventListener("hashchange", () => void openLinkedMatch());
