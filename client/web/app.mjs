// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import { loadEngine } from "./engine.ts";
import { initial, reduce, botTurn } from "./flow.ts";
import { deckSize, newDeck, toggle, rareOf } from "./deck.ts";
import { randomDeck, randomPlan } from "./bot.ts";
import { addCard, beatsUsed, canAdd, clearFrom, isSealable, slots } from "./plan.ts";
import { sentences, matchLog, resultLine, sideNames, possessive } from "./log.ts";
import { glossary, markKeywords, escapeHTML } from "./keywords.ts";
import { knownCards } from "./table.ts";
import { stepFeedback, cardBehind } from "./battle-feedback.ts";
import { artIndex } from "./art.ts";
import { loadArena } from "./arena-provider.ts";
import { createLobby } from "./lobby.mjs";
import { networkFor } from "./network.ts";
import { replayView, viewOf } from "./online-model.ts";
import { afterFiniteAnimations, coach, lessonsFor, railsNext, tutorialMatch, tutorialMemory } from "./tutorial.ts";

const engine = await loadEngine("engine.wasm", "cards.json");
const art = artIndex(await (await fetch("art/assets.json")).json());
const app = document.getElementById("app");
const tip = document.getElementById("tip");
const basics = engine.cards.filter((c) => !c.special).map((c) => c.id);
const stepMs = 1050;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let handScroll = 0;
const flights = new Set();

let flow = initial;
let choosingClan = true;
let deck = null; // the deck being picked on the deck screen
let plan = []; // the plan being built on the plan screen
let legalPlans = []; // the acting player's legal plans this round
let onlineContext = null;
let onlineError = "";
let onlineSending = false;
let playback = null; // {start, steps, lines, shown, speed, timer, revealTimer, revealAt, viewer, lessons, lesson} for the round being played back
let guided = null; // the guided match's decks and plans, from tutorialMatch, while one runs
let onward = null; // where the player was heading before the guided match: "online", "bot", "hotseat" or null

// Shared cards, and any clan missing here, get no emblem and no blurb.
const clanLook = {
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
function cardClan(c) {
  return engine.clans.find((clan) => clan.cards.includes(c.id))?.name ?? "Shared";
}
function emblem(clan) {
  return clanLook[clan]?.emblem ?? "";
}
function portraitHTML(clan, attributes) {
  const file = art.portrait(clan);
  return file === undefined ? "" : `<img ${attributes} src="art/${file}" alt="${clan} clan champion">`;
}
function artHTML(c) {
  const file = art.card(c.name);
  return file !== undefined
    ? `<div class="card__art"><img src="art/${file}" alt="" loading="lazy"></div>`
    : `<div class="card__art card__art--pending">${emblem(cardClan(c))}<span>Clan study · art to come</span></div>`;
}
function collectionHTML() {
  const groups = [
    ...engine.clans.map((clan) => ({ name: clan.name, ids: clan.cards })),
    { name: "Shared", ids: basics },
  ];
  return `<details class="collection"><summary>Browse all ${engine.cards.length} cards<span>${engine.clans.map((clan) => clan.name).join(", ")} & shared techniques</span></summary>
    <div class="collection__groups">${groups.map(({ name, ids }) => `<section class="stack" id="library-${name.toLowerCase()}"><div class="frame__head"><h2 class="heading">${name === "Shared" ? "Shared techniques" : name}</h2><span class="label">${ids.length} cards</span></div><div class="card-grid">${ids.map((id) => cardHTML(engine.cards[id])).join("")}</div></section>`).join("")}</div>
  </details>`;
}

function masthead(note = "A duel beneath the mountain") {
  return `<header class="masthead"><a class="wordmark" href="./">Gnomehall<span>UNDER THE MOUNTAIN</span></a><span class="masthead__note">${note}</span></header>`;
}

const tutorialFlag = tutorialMemory(localStorage);
const built = networkFor(GNOMEHALL_NETWORK);
const arena = built === null ? null : await loadArena(engine, built);
const lobby =
  arena === null
    ? null
    : createLobby({
        app,
        arena,
        storage: localStorage,
        onRender: render,
        portrait: portraitHTML,
        emblem,
        onResume: () => {
          const draft = lobby.model.draft;
          if (!draft) return;
          ({ flow, deck, plan, legalPlans, onlineContext } = draft);
          choosingClan = draft.choosingClan ?? false;
          lobby.model.inGame = true;
          app.classList.remove("lobby");
          render();
        },
        onExit: (offline) => {
          stopPlaying();
          playback = null;
          onlineContext = null;
          flow = initial;
          render();
          if (offline) app.querySelector(".offline-row")?.scrollIntoView({ block: "center" });
        },
        onCompose: (context) => {
          onlineContext = context;
          onlineError = "";
          lobby.model.draft = null;
          app.classList.remove("lobby");
          const opponent = context.view?.clans[0] || "";
          if (opponent && !clanNamed(opponent))
            throw new Error("The arena returned an unknown clan. Reload before playing.");
          flow = {
            ...initial,
            screen: "deck",
            mode: "online",
            hp: engine.hp,
            acting: context.intent === "accept" ? 1 : 0,
            clans: context.intent === "accept" ? [opponent, null] : [null, ""],
            decks: [[], []],
            state: { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) },
          };
          choosingClan = true;
          deck = newDeck(engine.clans[0], engine.cards);
          render();
        },
        onPlay: (raw, address, review) => {
          const restored = replayView(raw, engine, address);
          const { view, decks, state, rounds, result } = restored;
          if (!review && view.side === 0 && view.phase === "reveal" && !raw.pending)
            throw new Error(
              "This device cannot open your sealed plan yet. Approve the session on this device, then open the match again.",
            );
          if (!review && (view.side < 0 || !decks[view.side]?.length))
            throw new Error(
              "Your private deck is needed to resume this turn. The arena adapter must recover it before play.",
            );
          if (!review && rounds.length === 0 && view.round > 1)
            throw new Error("The arena has not supplied the resolved round yet. Refresh this match.");
          onlineContext = { intent: "move", view, account: address, review };
          onlineError = "";
          flow = {
            ...initial,
            mode: "online",
            hp: engine.hp,
            acting: view.side >= 0 ? view.side : 0,
            clans: view.clans,
            decks,
            state,
            rounds,
            result,
            screen: rounds.length ? "playback" : "plan",
          };
          if (rounds.length) {
            const round = rounds.at(-1);
            playback = {
              start: round.start.gnomes.map((g) => ({ ...g, block: 0, counter: 0 })),
              steps: groupSteps(round.events),
              lines: sentences(round.events, { cards: engine.cards, names: battleNames(), plans: round.plans }),
              shown: 0,
              timer: null,
              revealTimer: null,
              speed: 1,
              viewer: flow.acting,
              lessons: [],
              lesson: null,
            };
          } else {
            legalPlans = engine.legalPlans({ state, side: flow.acting, deck: decks[flow.acting] });
            plan = [];
          }
          lobby.model.inGame = true;
          app.classList.remove("lobby");
          render();
        },
      });
function battleNames() {
  return flow.mode === "online"
    ? flow.clans.map((clan, side) => (side === flow.acting ? "You" : clan || "Rival to come"))
    : sideNames(flow.clans, flow.mode);
}
function onlineBar() {
  return flow.mode !== "online"
    ? ""
    : `<section class="online-match-bar"><button class="button button--secondary" data-action="onlineBack" ${onlineSending ? "disabled" : ""}>Back to board</button><span>${onlineContext?.view?.deadline ? `Your move deadline: ${escapeHTML(new Date(onlineContext.view.deadline * 1000).toLocaleString())}` : onlineContext?.intent === "accept" ? "Accepting a challenge · Round 1" : "Posting a challenge · Round 1"}</span><p role="status">${escapeHTML(onlineError || (onlineSending ? "Sending your move… Waiting for confirmation." : ""))}</p></section>`;
}
async function sendOnlinePlan() {
  if (onlineSending || !isSealable(plan, legalPlans)) return;
  onlineSending = true;
  onlineError = "";
  render();
  const saved = [...plan];
  try {
    const me = flow.acting;
    await lobby.sendDraft(onlineContext, flow.clans[me], flow.decks[me], saved);
    stopPlaying();
    playback = null;
    flow = { ...initial, screen: "lobby" };
  } catch (error) {
    onlineError = error.message;
  } finally {
    onlineSending = false;
    render();
  }
}

// ---- Actions

function dispatch(action) {
  const before = flow;
  flow = reduce(flow, action);
  enter(before);
  render();
}

// enter runs what a screen needs on arrival: a fresh deck or plan to build, the legal
// plans from the engine, the bot's move, or the round's resolution.
function enter(before) {
  const arrived = flow.screen !== before.screen || flow.acting !== before.acting;
  if (!arrived) return;
  if (before.screen === "playback") {
    stopPlaying();
    playback = null;
  }
  if (flow.screen === "deck") {
    if (botTurn(flow)) {
      const clan = engine.clans[Math.floor(Math.random() * engine.clans.length)];
      dispatch({ type: "deckReady", clan: clan.name, deck: randomDeck(clan, engine.cards, Math.random) });
      return;
    }
    choosingClan = true;
    deck = newDeck(engine.clans[0], engine.cards);
  }
  if (flow.screen === "plan") {
    const plans = engine.legalPlans({ state: flow.state, side: flow.acting, deck: flow.decks[flow.acting] });
    if (botTurn(flow)) {
      dispatch({
        type: "planSealed",
        plan: flow.mode === "tutorial" ? guided.opponent[flow.state.round - 1] : randomPlan(plans, Math.random),
      });
      return;
    }
    legalPlans = plans;
    plan = [];
  }
  if (flow.screen === "playback") {
    const start = flow.state.gnomes.map((g) => ({
      hp: g.hp,
      block: 0,
      counter: 0,
      vulnerable: g.vulnerable,
      strength: g.strength,
    }));
    const { state, result, events } = engine.resolve({
      state: flow.state,
      decks: flow.decks,
      a: flow.plans[0],
      b: flow.plans[1],
    });
    const names = battleNames();
    playback = {
      start,
      steps: groupSteps(events),
      lines: sentences(events, { cards: engine.cards, names, plans: flow.plans }),
      shown: 0,
      timer: null,
      speed: 1,
      revealTimer: null,
      viewer: ["bot", "tutorial"].includes(flow.mode) ? 0 : flow.acting,
      // The guided match's lessons for this round, each {at, text, shown}, and the one on show
      // as {text, ready}, ready once the step's motion has ended.
      lessons:
        flow.mode === "tutorial"
          ? lessonsFor(flow.state.round, events, engine.cards).map((l) => ({ ...l, shown: false }))
          : [],
      lesson: null,
    };
    dispatch({ type: "resolved", state, result, events });
  }
  if (flow.screen === "result" && flow.mode === "tutorial") tutorialFlag.remember("done");
}

// groupSteps turns the event list into [from, to) ranges of events that resolve together.
function groupSteps(events) {
  const steps = [];
  events.forEach((ev, i) => {
    const last = steps.at(-1);
    const same = last && ["beat", "phase", "tier", "step"].every((k) => ev[k] === last[k]);
    if (same) last.to = i + 1;
    else steps.push({ beat: ev.beat, phase: ev.phase, tier: ev.tier, step: ev.step, from: i, to: i + 1 });
  });
  return steps;
}

function enterMode(mode) {
  if (mode === "online") handlers.online();
  else handlers.start({ mode });
}

const handlers = {
  start: ({ mode }) => dispatch({ type: "start", mode, hp: engine.hp }),
  online: () => {
    flow = { ...initial, screen: "lobby" };
    lobby.enter();
  },
  onlineBack: () => {
    if (onlineSending) return;
    stopPlaying();
    playback = null;
    if (["plan", "deck"].includes(flow.screen))
      lobby.model.draft = { flow, deck, plan, legalPlans, onlineContext, choosingClan };
    lobby.returnToBoard();
  },
  library: ({ clan }) => {
    flow = { ...initial, screen: "library" };
    render();
    if (clan) byId(`library-${clan.toLowerCase()}`)?.scrollIntoView({ block: "start" });
  },
  // playMode enters a mode from home, offering the guided match first to a browser that has
  // neither played nor skipped it.
  playMode: ({ mode }) => {
    if (tutorialFlag.seen()) return enterMode(mode);
    const offer = byId("tutorial-offer");
    for (const button of offer.querySelectorAll("[data-action]")) button.dataset.mode = mode;
    openDialog(offer);
  },
  tutorialSkip: ({ mode }) => {
    closeBattleDialogs();
    tutorialFlag.remember("skipped");
    enterMode(mode);
  },
  tutorial: ({ mode }) => {
    closeBattleDialogs();
    onward = mode ?? null;
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
  clan: ({ name }) => {
    const clan = clanNamed(name);
    if (!clan) return;
    if (deck?.clan !== name) deck = newDeck(clan, engine.cards);
    choosingClan = false;
    render();
  },
  toggle: ({ id }) => {
    deck = toggle(deck, Number(id), clanNamed(deck.clan), engine.cards);
    render();
  },
  deckReady: () => {
    if (flow.mode !== "online")
      return dispatch({ type: "deckReady", clan: deck.clan, deck: [...deck.picks].sort((a, b) => a - b) });
    const me = flow.acting;
    flow.clans[me] = deck.clan;
    flow.decks[me] = [...deck.picks].sort((a, b) => a - b);
    flow = { ...flow, screen: "plan" };
    legalPlans = engine.legalPlans({ state: flow.state, side: me, deck: flow.decks[me] });
    plan = [];
    render();
  },
  handoffDone: () => dispatch({ type: "handoffDone" }),
  addCard: ({ id }) => {
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
    byId("plan-status").textContent =
      `${engine.cards[cardId].name} added. ${beatsUsed(plan, engine.cards)} of 3 beats filled.`;
  },
  clearFrom: ({ beat }) => {
    plan = clearFrom(plan, Number(beat), engine.cards);
    render();
  },
  clearPlan: () => {
    plan = [];
    render();
  },
  inspectCard: ({ id }) => {
    if (flow.screen === "playback") stopPlaying();
    const c = engine.cards[Number(id)];
    const legal = flow.screen === "plan" && canAdd(plan, c.id, engine.cards, available());
    const reader = byId("card-reader");
    byId("reader-content").innerHTML =
      `${cardHTML(c)}<p class="muted">${c.cost} ${c.cost === 1 ? "beat" : "beats"}${c.special ? " · Once per match" : " · Reusable basic"}</p>
      ${legal ? `<button class="button" type="button" data-action="addCard" data-id="${c.id}">Play ${c.name}</button>` : `<p class="muted">${flow.screen === "playback" ? "Committed this round." : flow.state.gnomes[flow.acting].spent.includes(c.id) ? "Already spent this match." : coachedCard() !== undefined ? `The guided match asks for ${engine.cards[coachedCard()].name} now.` : "This card does not fit your current plan."}</p>`}`;
    openDialog(reader);
  },
  playedCards: () => {
    if (flow.screen === "playback") stopPlaying();
    openDialog(byId("played-cards"));
  },
  intel: () => {
    if (flow.screen === "playback") stopPlaying();
    openDialog(byId("battle-info"));
  },
  roundLog: () => {
    stopPlaying();
    openDialog(byId("round-log"));
  },
  closeDialog: () => closeBattleDialogs(),
  seal: () => {
    closeBattleDialogs();
    if (flow.mode === "online") return sendOnlinePlan();
    dispatch({ type: "planSealed", plan });
  },
  next: () => {
    stopPlaying();
    showStep(playback.shown + 1);
  },
  play: () => (playback.timer || playback.revealTimer ? stopPlaying() : startPlaying()),
  skip: () => {
    stopPlaying();
    for (const card of app.querySelectorAll(".card-reveal")) card.classList.remove("card-reveal");
    const lesson = playback.lessons.find((l) => !l.shown);
    if (lesson === undefined) return showStep(playback.steps.length, false);
    // In the guided match, skipping runs only as far as the next lesson.
    const target = playback.steps.findIndex((s) => lesson.at >= s.from && lesson.at < s.to) + 1;
    showStep(Math.max(target, playback.shown), false);
    lesson.shown = true;
    playback.lesson = { text: lesson.text, ready: true };
    patchPlayback();
    byId("lesson-continue")?.focus({ preventScroll: true });
  },
  lessonDone: () => {
    if (playback?.lesson == null) return;
    playback.lesson = null;
    patchPlayback();
    startPlaying();
  },
  playbackDone: () => {
    if (flow.mode !== "online") return dispatch({ type: "playbackDone" });
    stopPlaying();
    playback = null;
    if (onlineContext.review || onlineContext.view.action !== "move") return lobby.returnToBoard();
    flow = { ...flow, screen: "plan" };
    legalPlans = engine.legalPlans({ state: flow.state, side: flow.acting, deck: flow.decks[flow.acting] });
    plan = [];
    render();
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
  const entry = event.target.closest?.(".hand-entry--resting");
  if (entry && !entry.contains(event.relatedTarget)) entry.classList.remove("hand-entry--resting");
});
document.addEventListener("keydown", () =>
  app.querySelectorAll(".hand-entry--resting").forEach((el) => el.classList.remove("hand-entry--resting")),
);
app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  if (target.dataset.action.startsWith("online") && target.dataset.action !== "onlineBack") {
    if (target.tagName === "A") event.preventDefault();
    if (target.dataset.action === "online") handlers.online();
    else lobby.action(target.dataset.action.slice(6), target.dataset);
    return;
  }
  if (onlineSending) return;
  if (event.detail > 0) target.blur();
  handlers[target.dataset.action]?.(target.dataset);
});

// ---- Tips: the full card behind a small one, and the rule behind a keyword or badge

const tipAnchors = "[data-peek], [data-kw]";
const tipTitles = { cancel: "Cancelled" };
let tipAnchor = null;

app.addEventListener("mouseover", (event) => showTip(event.target.closest(tipAnchors)));
app.addEventListener("mouseout", (event) => {
  if (tipAnchor && !tipAnchor.contains(event.relatedTarget)) showTip(null);
});
app.addEventListener("focusin", (event) => showTip(event.target.closest(tipAnchors)));
app.addEventListener("focusout", () => showTip(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") showTip(null);
});

function showTip(anchor) {
  if (anchor === tipAnchor) return;
  tipAnchor = anchor;
  tip.hidden = anchor === null;
  if (anchor === null) return;
  const peek = anchor.dataset.peek;
  tip.classList.toggle("tip--card", peek !== undefined);
  if (peek !== undefined) tip.innerHTML = cardHTML(engine.cards[Number(peek)]);
  else {
    const key = anchor.dataset.kw;
    tip.innerHTML = `<span class="tip__title">${tipTitles[key] ?? key}</span>${glossary[key]}`;
  }
  placeTip(anchor);
}

// placeTip puts the tip under the anchor, or above it when the viewport ends first, and keeps
// it inside the viewport sideways.
function placeTip(anchor) {
  const gap = 8;
  const at = anchor.getBoundingClientRect();
  let top = anchor.closest(".battle-hand") ? at.top - gap - tip.offsetHeight : at.bottom + gap;
  if (top + tip.offsetHeight > window.innerHeight && at.top - gap - tip.offsetHeight >= 0)
    top = at.top - gap - tip.offsetHeight;
  top = Math.max(gap, Math.min(top, window.innerHeight - tip.offsetHeight - gap));
  const left = Math.max(gap, Math.min(at.left, window.innerWidth - tip.offsetWidth - gap));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

// available lists the ids the acting player may play: the basics and the deck's unspent specials,
// or only the card a guided round's rails ask for next.
function available() {
  if (flow.mode === "tutorial" && guided.rails[flow.state.round - 1] !== null) {
    const next = coachedCard();
    return next === undefined ? [] : [next];
  }
  const spent = flow.state.gnomes[flow.acting].spent;
  return [...basics, ...flow.decks[flow.acting].filter((id) => !spent.includes(id))];
}

// coachedCard is the card the guided match's rails ask for next, if any.
function coachedCard() {
  if (flow.mode !== "tutorial") return undefined;
  const rails = guided.rails[flow.state.round - 1];
  return rails === null ? undefined : railsNext(rails, plan);
}

// ---- Playback

// Timers belong to their playback session; exiting, skipping or pausing cancels them.
function showStep(n, animate = true) {
  if (!playback || flow.screen !== "playback") return;
  if (playback.revealTimer) clearTimeout(playback.revealTimer);
  playback.revealTimer = null;
  const round = flow.rounds.at(-1);
  const target = Math.min(n, playback.steps.length);
  const sequential = target === playback.shown + 1;
  playback.shown = target;
  if (target === playback.steps.length && playback.timer) {
    clearInterval(playback.timer);
    playback.timer = null;
  }
  patchPlayback();
  if (animate && sequential && target > 0) {
    const step = playback.steps[target - 1];
    animateStep(round.events.slice(step.from, step.to));
    pauseForLesson(step);
  } else for (const side of [0, 1]) byId(`float-${side}`).replaceChildren();
}

// pauseForLesson stops the clash on a step that holds a guided lesson, and shows the lesson
// once the step's own motion has ended.
function pauseForLesson(step) {
  const lesson = playback.lessons.find((l) => !l.shown && l.at >= step.from && l.at < step.to);
  if (lesson === undefined) return;
  lesson.shown = true;
  stopPlaying();
  const session = playback;
  session.lesson = { text: lesson.text, ready: false };
  patchPlayback();
  void afterFiniteAnimations(document.getAnimations()).then(() => {
    if (playback !== session || flow.screen !== "playback" || session.lesson === null) return;
    session.lesson.ready = true;
    patchPlayback();
    byId("lesson-continue")?.focus({ preventScroll: true });
  });
}

function queueReveal(session, delay) {
  session.revealAt = performance.now() + delay;
  session.revealTimer = setTimeout(() => {
    if (playback === session && flow.screen === "playback") {
      session.revealTimer = null;
      startPlaying();
    }
  }, delay);
  patchPlayback();
}

function startPlaying(immediate = true) {
  if (!playback || flow.screen !== "playback" || playback.shown >= playback.steps.length || playback.timer) return;
  if (playback.revealTimer) clearTimeout(playback.revealTimer);
  playback.revealTimer = null;
  const session = playback;
  session.timer = setInterval(() => {
    if (playback === session && flow.screen === "playback") showStep(session.shown + 1);
  }, stepMs / session.speed);
  if (immediate) showStep(session.shown + 1);
  else patchPlayback();
}

function stopPlaying() {
  if (!playback) return;
  if (playback.timer) clearInterval(playback.timer);
  if (playback.revealTimer) clearTimeout(playback.revealTimer);
  playback.timer = null;
  playback.revealTimer = null;
  if (flow.screen === "playback" && app.dataset.screen === "playback") patchPlayback();
}

function animateElement(element, frames, options = {}) {
  if (!element || reducedMotion.matches) return null;
  return element.animate(frames, { duration: 440, easing: "cubic-bezier(.2,.8,.2,1)", ...options });
}

function flyCard(source, from, destination) {
  if (!source || !from || !destination || reducedMotion.matches) return;
  const to = destination.getBoundingClientRect();
  const ghost = source.cloneNode(true);
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

function animateStep(events) {
  const feedback = stepFeedback(events);
  const round = flow.rounds.at(-1);
  const laid = round.plans.map((p) => slots(p, engine.cards));
  for (const side of [0, 1]) {
    const f = feedback.sides[side];
    const labels = [
      f.damage > 0 ? `<span class="combat-float combat-float--damage">−${f.damage} HP</span>` : "",
      f.blocked > 0 ? `<span class="combat-float combat-float--block">Blocked ${f.blocked}</span>` : "",
      f.block > 0 ? `<span class="combat-float combat-float--block">+${f.block} Block</span>` : "",
      f.block < 0 ? `<span class="combat-float combat-float--debuff">−${-f.block} Block</span>` : "",
      f.counter > 0 ? `<span class="combat-float combat-float--buff">Counter +${f.counter}</span>` : "",
      f.strength > 0 ? `<span class="combat-float combat-float--buff">Strength +${f.strength}</span>` : "",
      f.vulnerable > 0 ? `<span class="combat-float combat-float--debuff">Vulnerable +${f.vulnerable}</span>` : "",
      f.vulnerable < 0 ? `<span class="combat-float combat-float--buff">Vulnerable −${-f.vulnerable}</span>` : "",
    ].join("");
    byId(`float-${side}`).innerHTML = labels;
    const portrait = byId(`sprite-${side}`);
    if (f.damage > 0)
      animateElement(
        portrait,
        [
          { transform: "translateX(0)", filter: "brightness(1)" },
          { transform: "translateX(-7px)", filter: "brightness(1.5)" },
          { transform: "translateX(5px)" },
          { transform: "translateX(0)", filter: "brightness(1)" },
        ],
        { duration: 320 },
      );
    if (f.blocked > 0 || f.block > 0)
      animateElement(
        byId(`portrait-frame-${side}`),
        [
          { boxShadow: "0 0 0 0 transparent" },
          { boxShadow: "0 0 0 9px color-mix(in srgb, var(--gh-color-block) 53%, transparent)" },
          { boxShadow: "0 0 0 15px transparent" },
        ],
        { duration: 600 },
      );
    if (f.strength || f.counter || f.vulnerable)
      animateElement(byId(`chips-${side}`), [
        { opacity: 0.3, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ]);
  }
  const active = new Set();
  for (const event of events) {
    const { side, index } = cardBehind(event, round.plans, engine.cards);
    const key = `${side}:${index}`;
    if (!active.has(key))
      animateElement(
        app.querySelector(`.card--track[data-side="${side}"][data-index="${index}"]`),
        [{ transform: "translateY(0)" }, { transform: "translateY(-7px) scale(1.03)" }, { transform: "translateY(0)" }],
        { duration: 500 },
      );
    active.add(key);
  }
  for (const cancelled of feedback.cancelled) {
    const index = laid[cancelled.side][cancelled.beat - 1]?.index;
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

function openDialog(dialog) {
  showTip(null);
  if (dialog && !dialog.open) {
    dialog.showModal();
    dialog.append(tip);
  }
}
function closeBattleDialogs() {
  for (const dialog of app.querySelectorAll("dialog[open]")) dialog.close();
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
  if (event.target.id !== "playback-speed" || !playback) return;
  const running = Boolean(playback.timer);
  const revealing = Boolean(playback.revealTimer);
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
function copyMatchLog() {
  const area = byId("match-log");
  area.select();
  const done = () => {
    byId("copied").textContent = "Copied.";
  };
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(area.value).then(done, () => done(document.execCommand("copy")));
  else done(document.execCommand("copy"));
}

// ---- Rendering

function render() {
  if (lobby?.model.active && !lobby.model.inGame) {
    if (app.contains(tip)) document.body.append(tip);
    tip.hidden = true;
    return lobby.render();
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
  const previousScreen = app.dataset.screen;
  const previousStage = app.dataset.stage;
  const focus = document.activeElement;
  const key =
    focus?.matches(":focus-visible") && focus?.dataset.action
      ? { action: focus.dataset.action, id: focus.dataset.id, beat: focus.dataset.beat }
      : null;
  handScroll = app.querySelector(".battle-hand")?.scrollLeft ?? 0;
  for (const ghost of flights) ghost.remove();
  flights.clear();
  if (app.contains(tip)) document.body.append(tip);
  app.innerHTML = onlineBar() + screens[flow.screen]();
  app.dataset.screen = flow.screen;
  app.dataset.stage = flow.screen === "deck" ? (choosingClan ? "clan" : "cards") : "";
  if (
    (flow.screen === "deck" && (previousStage !== app.dataset.stage || previousScreen !== flow.screen)) ||
    flow.screen === "library"
  ) {
    const heading = app.querySelector("h1,h2");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    app.scrollIntoView({ block: "start" });
  }
  app.classList.toggle("board--battle", ["plan", "playback"].includes(flow.screen));
  if (flow.screen === "plan") {
    const hand = app.querySelector(".battle-hand");
    hand.scrollLeft = previousScreen === "plan" ? handScroll : 0;
    // A phone's hand scrolls sideways; bring the card the guided match asks for into view.
    const coached = hand.querySelector(".card--coached")?.closest(".hand-entry");
    if (coached)
      hand.scrollLeft +=
        coached.getBoundingClientRect().left -
        hand.getBoundingClientRect().left -
        (hand.clientWidth - coached.offsetWidth) / 2;
    if (previousScreen === "plan" && key) {
      let target = [...app.querySelectorAll("[data-action]")].find(
        (el) =>
          el.dataset.action === key.action && el.dataset.id === key.id && el.dataset.beat === key.beat && !el.disabled,
      );
      target ??= byId("seal")?.disabled
        ? app.querySelector('.battle-hand [data-action="addCard"]:not(:disabled)')
        : byId("seal");
      target?.focus({ preventScroll: true });
    }
  }
  if (flow.screen === "playback") {
    patchPlayback();
    const session = playback;
    queueReveal(session, reducedMotion.matches ? 450 : 1050);
  }
  if (previousScreen !== flow.screen)
    animateElement(
      app.querySelector(".duel-table"),
      [
        { opacity: 0.2, transform: "translateY(7px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 360 },
    );
  dropStaleTip();
}

// dropStaleTip hides the tip once its anchor has been rendered away.
function dropStaleTip() {
  if (tipAnchor && !tipAnchor.isConnected) showTip(null);
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
function clanChoicesHTML(home = false) {
  return `<div class="clan-choices">${clanPresentation
    .map((c) => {
      const available = Boolean(clanNamed(c.name));
      const body = `<div class="clan-choice__art"><img src="art/${c.file}" alt="" loading="${home ? "lazy" : "eager"}"></div><div class="clan-choice__body"><span class="clan-choice__eyebrow">${c.tag}</span><h3>${emblem(c.name)}${c.name}</h3><p>${c.description}</p><span class="clan-choice__style">${c.style}</span><span class="clan-choice__cta">${available ? (home ? `See the ${c.name} cards →` : `Choose ${c.name} →`) : home ? "Explore Delvers · Coming soon →" : "Coming soon"}</span></div>`;
      const cls = `clan-choice clan-choice--${c.name.toLowerCase()}`;
      if (home && !available) return `<a class="${cls}" href="delvers-preview.html">${body}</a>`;
      if (home)
        return `<button class="${cls}" type="button" data-action="library" data-clan="${c.name}">${body}</button>`;
      return `<button class="${cls}" type="button" data-action="clan" data-name="${c.name}" ${available ? "" : "disabled"}>${body}</button>`;
    })
    .join("")}</div>`;
}
function title() {
  return `<header class="masthead"><a class="wordmark" href="./">Gnomehall<span>UNDER THE MOUNTAIN</span></a><nav class="home-nav" aria-label="Explore the game"><button type="button" data-action="tutorial">How to play</button><button type="button" data-action="library">Card library</button></nav></header>
    <section class="intro intro--home">
      <div class="intro__copy"><span class="eyebrow">A TACTICAL CARD DUEL</span>
        <h1>Small gnomes.<br>Big grudges.</h1>
        <p>Choose a clan. Plot three beats. Settle your grudge beneath the mountain.</p>
        <div class="home-play">${lobby ? `<button class="button" type="button" data-action="playMode" data-mode="online">Play online <span aria-hidden="true">→</span></button>` : ""}<button class="button button--secondary" type="button" data-action="tutorial">How to play</button></div>
        ${lobby ? `<p class="home-play__note">24 hours per move · needs the Adena wallet</p>` : ""}
      </div>
      <div class="intro__art"><img src="art/hall-hero-v2.jpg" alt="Gnomes gather around a card table in the underground hall"><span class="intro__art-label">WELCOME TO GNOMEHALL<span>Different clans. Shared grudges.</span></span></div>
    </section>
    <section class="home-clans" aria-labelledby="home-clans-title"><div class="section-intro"><div><span class="eyebrow">FIND YOUR WAY TO FIGHT</span><h2 id="home-clans-title">Which clan calls to you?</h2></div><p>Three personalities. One table.</p></div>${clanChoicesHTML(true)}</section>
    <footer class="hall-footer"><span>Forged below. Settled at the table.</span><nav class="offline-row" aria-label="Play offline"><span>Play offline:</span><button type="button" class="text-button" data-action="playMode" data-mode="bot">Bot</button><button type="button" class="text-button" data-action="playMode" data-mode="hotseat">Two players</button><button type="button" class="text-button" data-action="library">Card library</button></nav></footer>
    <dialog class="offer" id="tutorial-offer" aria-labelledby="offer-title"><h2 id="offer-title">${coach.offer.title}</h2><p>${coach.offer.body}</p>
      <div class="button-row"><button class="button" type="button" data-action="tutorial">${coach.offer.start}</button><button class="button button--secondary" type="button" data-action="tutorialSkip">${coach.offer.skip}</button></div></dialog>`;
}
function libraryScreen() {
  return `${masthead("Know your tools. Read your rival.")}<div class="section-intro"><div><span class="eyebrow">THE CLAN ARCHIVES</span><h1 class="heading">Card library</h1><p>Every card available in this build. Read the rules and find your favorites.</p></div><button class="button button--secondary" data-action="home">Back to the hall</button></div>${collectionHTML().replace('<details class="collection">', '<details class="collection" open>')}`;
}
function clanSelectionScreen() {
  const heading = flow.mode === "hotseat" ? `Player ${flow.acting + 1}, choose your clan` : "Choose your clan";
  return `${masthead("Different clans. Shared grudges.")}<section class="clan-selection" aria-labelledby="clan-select-title"><nav class="setup-steps" aria-label="Match setup"><span aria-current="step">1 · Choose clan</span><span>2 · Build deck</span><span>3 · Plan your round</span></nav><div class="section-intro"><div><span class="eyebrow">CHOOSE YOUR ALLEGIANCE</span><h1 id="clan-select-title">${heading}</h1><p>Find your fighting style. You’ll choose your cards next.</p></div>${flow.mode === "online" ? "" : '<button class="button button--secondary" data-action="home">Back to the hall</button>'}</div>${clanChoicesHTML()}<p class="clan-selection__note">${engine.clans.some((c) => c.name === "Delvers") ? "Every clan brings its own tools. Your timing makes the difference." : "The Delvers are preparing their tools. Choose Pickers or Ironhide to play now."}</p></section>`;
}

function deckScreen() {
  if (choosingClan) return clanSelectionScreen();
  const clan = clanNamed(deck.clan);
  const rare = rareOf(clan, engine.cards);
  const picked = deck.picks.length - 1;
  const legal = engine.legalDeck({ clan: deck.clan, deck: deck.picks });
  const heading = ["bot", "online"].includes(flow.mode) ? "Pick your deck" : `Player ${flow.acting + 1} picks a deck`;
  const full = deck.picks.length >= deckSize;
  const pool = clan.cards
    .map((id) => {
      const picked = deck.picks.includes(id);
      return cardHTML(engine.cards[id], {
        selected: picked,
        pressed: picked,
        locked: id === rare,
        dimmed: full && !picked,
        action: "toggle",
      });
    })
    .join("");
  return `
    ${masthead()}
    <nav class="setup-steps" aria-label="Match setup"><button class="text-button" data-action="changeClan">1 · Choose clan</button><span aria-current="step">2 · Build deck</span><span>3 · Plan your round</span></nav>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${heading}</h2><span class="hint">The Rare stays in. Pick 7 more.</span></div>
      <div class="clan-banner clan-banner--${deck.clan.toLowerCase()}">${portraitHTML(deck.clan, `class="clan-banner__portrait"`)}<div><span class="eyebrow">CHOOSE YOUR ALLEGIANCE</span><h3 class="heading clan-banner__name">${emblem(deck.clan)}${deck.clan}</h3><p>${clanLook[deck.clan]?.blurb ?? ""}</p></div><button class="button button--secondary" type="button" data-action="changeClan">Change clan</button></div>
      <div class="card-grid">${pool}</div>
      <div class="button-row"><button class="button" type="button" data-action="deckReady" ${legal ? "" : "disabled"}>Ready ${picked} / 7</button></div>
    </section>`;
}

function handoff() {
  const next = flow.after.acting + 1;
  return `
    <div class="curtain">
      <div class="frame">
        <p class="heading">Pass to Player ${next}</p>
        <p class="muted">Player ${3 - next}, look away.</p>
        <button class="button" type="button" data-action="handoffDone">I am Player ${next}</button>
      </div>
    </div>`;
}

function battleHeaderHTML(round, phase) {
  return `<header class="battle-header"><span class="battle-header__brand"><a class="wordmark" href="./">Gnomehall</a><span class="battle-header__note">A quarrel in three rounds</span></span>${roundHTML(round, phase)}
    <button class="button button--secondary battle-intel-button" type="button" data-action="intel">Opponent & history</button></header>`;
}

function roundHTML(round, phase) {
  return `<div class="round-medallion"><span class="eyebrow">${phase}</span><span class="round-medallion__number">${round}<small> / 3</small></span>
    <div class="round-pips" aria-label="Round ${round} of 3">${[1, 2, 3].map((n) => `<span class="${n === round ? "round-pip--current" : n < round ? "round-pip--done" : ""}"></span>`).join("")}</div></div>`;
}

function beatMarkersHTML() {
  return `<div class="beat-markers">${[1, 2, 3].map((n) => `<span class="timeline__beat" id="beat-${n}"><span class="beat-marker__gem" aria-hidden="true"></span>Beat ${n}</span>`).join("")}</div>`;
}

function battleDialogsHTML(viewer) {
  const opponent = 1 - viewer;
  const names = battleNames();
  const past = flow.screen === "playback" ? flow.rounds.slice(0, -1) : flow.rounds;
  const known = knownCards(
    past,
    opponent,
    clanNamed(flow.clans[opponent])?.cards ?? [],
    flow.decks[opponent],
    engine.cards,
  );
  const knownHead = known.open
    ? `<h3 class="heading">${possessive(names[opponent])} deck</h3><p class="muted">Decks are open from round 2. Spent cards show the round they were played in; the current plan stays hidden until the reveal.</p>`
    : `<h3 class="heading">${possessive(names[opponent])} clan pool</h3><p class="muted">${deckSize} of these ${known.cards.length} cards are in their deck. The Rare always is. Decks open from round 2; the current plan stays hidden until the reveal.</p>`;
  const knownGrid = (list) =>
    `<div class="card-grid">${list.map(({ id, spentRound }) => cardHTML(engine.cards[id], { spentRound })).join("")}</div>`;
  const left = known.cards.filter((c) => c.spentRound === 0);
  const spent = known.cards.filter((c) => c.spentRound > 0);
  const knownCardsHTML = known.open
    ? `<span class="label">Still to play · ${left.length}</span>${knownGrid(left)}${spent.length ? `<span class="label">Already played · ${spent.length}</span>${knownGrid(spent)}` : ""}`
    : knownGrid(known.cards);
  const history = past
    .map(
      (round, i) =>
        `<section class="stack"><h3 class="heading">Round ${i + 1}</h3>${[0, 1].map((side) => `<div><span class="label">${names[side]}</span><div class="row">${smallCards(round.plans[side])}</div></div>`).join("")}</section>`,
    )
    .join("");
  const played = past
    .map(
      (round, i) =>
        `<section class="stack"><h3 class="heading">Round ${i + 1}</h3><div class="card-grid">${round.plans[viewer].map((id) => cardHTML(engine.cards[id])).join("")}</div></section>`,
    )
    .join("");
  return `<dialog class="battle-drawer" id="played-cards" aria-labelledby="played-title"><div class="dialog-heading"><h2 class="heading" id="played-title">Your played cards</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close played cards">×</button></div>${played || `<p class="muted">No cards played yet.</p>`}</dialog><dialog class="battle-drawer" id="battle-info" aria-labelledby="intel-title"><div class="dialog-heading"><h2 class="heading" id="intel-title">Across the table</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close opponent information">×</button></div>
    <section class="stack">${knownHead}
      ${knownCardsHTML}</section>
    <section class="stack intel-history"><h3 class="heading">Earlier rounds</h3>${history || `<p class="muted">No rounds played yet.</p>`}</section></dialog>
    <dialog class="card-reader" id="card-reader" aria-label="Card details"><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close card details">×</button><div id="reader-content" class="stack"></div></dialog>`;
}

function planScreen() {
  const me = flow.acting,
    opponent = 1 - me;
  const names = battleNames();
  const used = beatsUsed(plan, engine.cards);
  const sealable = isSealable(plan, legalPlans);
  const handIds = [
    ...basics,
    ...flow.decks[me].filter((id) => !flow.state.gnomes[me].spent.includes(id) && !plan.includes(id)),
  ];
  const playedCount = flow.rounds.reduce((n, round) => n + round.plans[me].length, 0);
  const coached = coachedCard();
  const hand = handIds
    .map((id, index) => {
      const c = engine.cards[id];
      return `<div class="hand-entry" style="--hand-order:${index};--hand-tilt:${(index - (handIds.length - 1) / 2) * 4}deg;--hand-rise:${Math.pow(index - (handIds.length - 1) / 2, 2) * 2}px">
      ${cardHTML(c, { action: matchMedia("(hover: none)").matches ? "inspectCard" : "addCard", hand: true, dimmed: !canAdd(plan, id, engine.cards, available()), coached: id === coached })}
      <button class="card-inspect" type="button" data-action="inspectCard" data-id="${id}" aria-label="Details: ${c.name}">Details</button></div>`;
    })
    .join("");
  const backs = [1, 2, 3]
    .map(
      () =>
        `<div class="card-back card-back--${(flow.clans[opponent] || "shared").toLowerCase()}" aria-hidden="true"><span>${emblem(flow.clans[opponent])}</span></div>`,
    )
    .join("");
  const practice =
    flow.mode === "tutorial" && guided.rails[flow.state.round - 1] !== null
      ? guided.opponent[flow.state.round - 1]
      : null;
  const opponentTrack =
    practice === null
      ? `<div class="plan-track plan-track--hidden" aria-label="Opponent plan hidden">${backs}</div>`
      : `<div class="plan-track">${practiceTrackHTML(practice)}</div>`;
  const title =
    flow.mode === "tutorial"
      ? coachHTML(sealable)
      : `<div class="hand-zone__title"><h2 class="heading">Plot your next move</h2><span class="muted" id="plan-status" role="status">${sealable ? "Your plan is ready. Confirm it when you're sure." : "Play cards to fill all three beats."}</span></div>`;
  return `${battleHeaderHTML(flow.state.round, "Planning")}
    <section class="duel-table" aria-label="Round ${flow.state.round} battle table">
      <div class="duel-fighters">${gnomeHTML(me, flow.state.gnomes[me], names[me])}${gnomeHTML(opponent, flow.state.gnomes[opponent], names[opponent])}</div>
      <div class="duel-center">
        <div class="track-row track-row--opponent"><div class="track-row__label"><span class="label">${possessive(names[opponent])} plan</span><span class="track-hint">${practice === null ? "Sealed in secret" : "Shown for practice"}</span></div>${opponentTrack}</div>
        ${beatMarkersHTML()}
        <div class="track-row track-row--yours"><div class="track-row__label"><span class="label">Your plan</span><span class="track-hint">${used} of 3 beats filled</span></div>${slotsHTML()}</div>
        <p class="table-caption">Choose the order. Anticipate their move.</p>
      </div>
    </section>
    <section class="hand-zone" aria-label="Your hand"><div class="hand-zone__heading">
      ${title}
      <div class="hand-zone__hint"><span class="label">Your hand <span>${handIds.length} cards</span></span><span class="muted">Lift a card to read · click to play · tap to inspect</span></div>
      <div class="button-row"><button class="button button--secondary" type="button" data-action="clearPlan" ${plan.length ? "" : "disabled"}>Clear</button><button class="button" type="button" data-action="seal" id="seal" ${sealable && !onlineSending ? "" : "disabled"}>${flow.mode === "online" ? (onlineContext.intent === "challenge" ? "Post challenge" : onlineContext.intent === "accept" ? "Accept challenge" : "Send plan") : "Seal plan"}</button></div></div>
      <div class="hand-layout"><div class="battle-hand card-grid" style="--hand-count:${handIds.length}">${hand}</div><button class="played-pile" type="button" data-action="playedCards" ${playedCount ? "" : "disabled"} aria-label="Open played cards, ${playedCount} cards"><span class="pile-back card-back card-back--${(flow.clans[me] || "shared").toLowerCase()}"><span>${emblem(flow.clans[me])}</span></span><span class="label">Played cards</span><span class="muted">${playedCount} cards · inspect</span></button></div></section>
    ${battleDialogsHTML(me)}`;
}

// Cards retain playing-card proportions; their brackets span the occupied beats.
function slotsHTML() {
  let beat = 0;
  const filled = plan.map((id, index) => {
    const c = engine.cards[id];
    const from = beat;
    beat += c.cost;
    return `<div class="slot" data-plan-index="${index}" style="grid-column:span ${c.cost}">${cardHTML(c, { track: true, action: "clearFrom", data: `data-beat="${from}"` })}<span class="track-note">${c.parry > 0 ? `Guards ${c.cost === 1 ? `beat ${beat}` : `beats ${from + 1}–${beat}`}` : c.cost > 1 ? `Lands on beat ${beat}` : "Click to remove"}</span></div>`;
  });
  const coached = coachedCard();
  const empty = Array.from(
    { length: 3 - beat },
    (_, index) =>
      `<div class="slot"><div class="slot__well"><span class="slot__number">${beat + index + 1}</span>${index === 0 && coached !== undefined ? `<span class="slot__coach">${engine.cards[coached].name} goes here</span>` : "<span>Choose a card</span>"}</div><span class="track-note">Empty beat</span></div>`,
  );
  return `<div class="plan-track plan-track--yours">${filled.join("")}${empty.join("")}</div>`;
}

// trackNote names the beats a revealed card guards or lands on; from and to are 1-based.
function trackNote(c, from, to) {
  if (c.parry > 0) return `Guards ${from === to ? `beat ${to}` : `beats ${from}–${to}`}`;
  return c.cost > 1 ? `Lands on beat ${to}` : `Beat ${to}`;
}

// practiceTrackHTML lays out the guided match opponent's plan face up.
function practiceTrackHTML(ids) {
  let beat = 0;
  return ids
    .map((id) => {
      const c = engine.cards[id];
      const from = beat + 1;
      beat += c.cost;
      return `<div class="slot" style="grid-column:span ${c.cost}">${cardHTML(c, { track: true })}<span class="track-note">${trackNote(c, from, beat)}</span></div>`;
    })
    .join("");
}

// coachHTML is the guided match's coach strip: the round's lesson title, what to do now, and
// the step count while the rails lead.
function coachHTML(sealable) {
  const round = flow.state.round;
  const words = coach.rounds[round - 1];
  const rails = guided.rails[round - 1];
  const line = rails === null ? words.hint : coachedCard() !== undefined ? words.steps[plan.length] : words.seal;
  const step =
    rails === null
      ? `<button class="button button--secondary" type="button" data-action="intel">${words.look}</button>`
      : `<span class="coach__step">Round ${round} · step ${plan.length + 1} of ${words.steps.length + 1}</span>`;
  return `<div class="coach">${portraitHTML("Pickers", 'class="coach__portrait"')}<p class="coach__words"><strong>${words.title}</strong> ${line}</p>${step}
    <span class="coach__status" id="plan-status" role="status">${sealable ? "Your plan is ready. Confirm it when you're sure." : "Play cards to fill all three beats."}</span></div>`;
}

function playbackScreen() {
  const round = flow.rounds.at(-1);
  const names = battleNames();
  const me = playback.viewer,
    opponent = 1 - me;
  const row = (side) => {
    let beat = 0;
    return `<div class="track-row ${side === me ? "track-row--yours" : "track-row--opponent"}"><div class="track-row__label"><span class="label">${possessive(names[side])} plan</span><span class="track-hint">Revealed</span></div><div class="plan-track">${round.plans[
      side
    ]
      .map((id, index) => {
        const c = engine.cards[id];
        const from = beat + 1;
        beat += c.cost;
        return `<div class="slot card-reveal" style="grid-column:span ${c.cost};--reveal-delay:${index * 120}ms">${cardHTML(c, { track: true, action: "inspectCard", data: `data-side="${side}" data-index="${index}"` })}<span class="track-note">${trackNote(c, from, beat)}</span></div>`;
      })
      .join("")}</div></div>`;
  };
  return `${battleHeaderHTML(round.state.round - 1, "The clash")}
    <section class="duel-table duel-table--playback" aria-label="Round ${round.state.round - 1} battle table">
      <div class="duel-fighters">${gnomeHTML(me, playback.start[me], names[me])}${gnomeHTML(opponent, playback.start[opponent], names[opponent])}</div>
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

function patchPlayback() {
  if (!playback || flow.screen !== "playback" || app.dataset.screen !== "playback") return;
  const round = flow.rounds.at(-1);
  const { steps, shown, lines } = playback;
  const vitalsAt = (n) => (n === 0 ? playback.start : round.events[steps[n - 1].to - 1].after);
  const vitals = vitalsAt(shown);
  const current = shown > 0 ? steps[shown - 1] : null;
  for (const side of [0, 1]) {
    byId(`hp-fill-${side}`).style.width = hpWidth(vitals[side].hp);
    byId(`hp-ghost-${side}`).style.width = hpWidth(vitals[side].hp);
    byId(`hp-num-${side}`).textContent = `${vitals[side].hp} / ${flow.hp}`;
    byId(`chips-${side}`).innerHTML = chipsHTML(vitals[side]);
    byId(`fighter-${side}`).classList.toggle("fighter--defeated", vitals[side].hp <= 0);
  }
  const laid = round.plans.map((p) => slots(p, engine.cards));
  const acting = new Set(
    current
      ? round.events.slice(current.from, current.to).map((ev) => {
          const { side, index } = cardBehind(ev, round.plans, engine.cards);
          return `${side}:${index}`;
        })
      : [],
  );
  const until = shown > 0 ? steps[shown - 1].to : 0;
  const cancelled = new Set(
    round.events
      .slice(0, until)
      .filter((ev) => ev.kind === "Cancelled")
      .map((ev) => `${ev.side}:${laid[ev.side][ev.beat - 1]?.index}`),
  );
  for (const b of [1, 2, 3]) {
    byId(`beat-${b}`).classList.toggle("timeline__beat--current", current?.beat === b);
    byId(`beat-${b}`).classList.toggle("timeline__beat--past", current?.beat > b);
  }
  for (const el of app.querySelectorAll(".card--track[data-side][data-index]")) {
    const key = `${el.dataset.side}:${el.dataset.index}`;
    el.classList.toggle("card--acting", acting.has(key));
    el.classList.toggle("card--cancelled", cancelled.has(key));
    el.setAttribute(
      "aria-label",
      `${engine.cards[Number(el.dataset.id)].name}${cancelled.has(key) ? ", cancelled" : ""}. Inspect card.`,
    );
  }
  byId("log").innerHTML = logHTML(round, steps, shown, lines);
  const done = shown >= steps.length;
  const names = battleNames();
  const caption = done
    ? `Round complete. ${names[playback.viewer]}: ${vitals[playback.viewer].hp} HP · ${names[1 - playback.viewer]}: ${vitals[1 - playback.viewer].hp} HP.`
    : current
      ? lines.slice(current.from, current.to).join(" · ")
      : "Both plans revealed. The clash begins.";
  if (byId("battle-event").textContent !== caption) byId("battle-event").textContent = caption;
  const held = playback.lesson !== null;
  byId("next").disabled = done || held;
  byId("skip").disabled = done || held;
  byId("play").disabled = done || held;
  const lesson = byId("lesson");
  if (lesson) {
    lesson.hidden = !playback.lesson?.ready;
    byId("lesson-text").textContent = playback.lesson?.ready ? playback.lesson.text : "";
  }
  byId("play").textContent = playback.timer || playback.revealTimer ? "Pause" : "Play";
  byId("progress").textContent = done
    ? "Round resolved"
    : current
      ? `Beat ${current.beat} · ${current.phase}`
      : "Plans revealed";
  byId("finish").innerHTML = done && !held ? finishHTML() : "";
  dropStaleTip();
}

function logHTML(round, steps, shown, lines) {
  const until = shown > 0 ? steps[shown - 1].to : 0;
  const fresh = shown > 0 ? steps[shown - 1].from : 0;
  const groups = [];
  for (let i = 0; i < until; i++) {
    const beat = round.events[i].beat;
    const last = groups.at(-1);
    const line = `<span class="log__line ${i >= fresh ? "log__line--new" : ""}">${lines[i]}</span>`;
    if (last && last.beat === beat) last.lines.push(line);
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

function finishHTML() {
  if (flow.mode === "online")
    return `<div class="button-row"><button class="button" data-action="playbackDone">${onlineContext.review ? "Back to match" : "Plan your next round"}</button></div>`;
  const names = battleNames();
  if (flow.result === "ongoing") {
    return `<div class="button-row"><button class="button" type="button" data-action="playbackDone">Round ${flow.state.round}</button></div>`;
  }
  const knockout = flow.state.gnomes.some((g) => g.hp <= 0);
  return `
    <p class="banner">${knockout ? "Knockout!" : "Three rounds played."} ${resultLine(flow.result, names)}</p>
    <div class="button-row"><button class="button" type="button" data-action="playbackDone">Continue</button></div>`;
}

function resultScreen() {
  if (flow.mode === "tutorial") return guidedResultHTML();
  const names = battleNames();
  const sides = [0, 1]
    .map((side) => {
      const g = flow.state.gnomes[side];
      const unplayed = flow.decks[side]
        .filter((id) => !g.spent.includes(id))
        .map((id) => cardHTML(engine.cards[id], { small: true }))
        .join("");
      return `
        <div class="stack">
          <div class="frame__head"><span class="heading">${names[side]}</span><span class="number">HP ${g.hp}</span></div>
          <span class="label">Never played</span>
          <div class="row">${unplayed || `<span class="muted">Every card.</span>`}</div>
        </div>`;
    })
    .join("");
  return `
    ${masthead()}
    <section class="frame stack">
      <p class="banner">${resultLine(flow.result, names)}</p>
      <div class="split">${sides}</div>
      <div class="button-row">
        <button class="button" type="button" data-action="rematch">Rematch</button>
        <button class="button button--secondary" type="button" data-action="newMatch">New match</button>
      </div>
      <div class="stack">
        <div class="frame__head"><span class="label">Match log</span><span class="button-row"><button class="button button--secondary" type="button" data-action="copyLog">Copy match log</button><span class="muted" id="copied"></span></span></div>
        <textarea class="log-text" id="match-log" readonly rows="10">${escapeHTML(matchLog(flow.rounds, flow.result, { cards: engine.cards, names }))}</textarea>
      </div>
    </section>`;
}

// guidedResultHTML closes the guided match on its health score and leads where the player was
// heading before it.
function guidedResultHTML() {
  const [mine, theirs] = flow.state.gnomes.map((g) => g.hp);
  const outcome =
    flow.result === "a"
      ? `You won on health, ${mine} to ${theirs}.`
      : flow.result === "b"
        ? `Ironhide won on health, ${theirs} to ${mine}.`
        : `An even score: ${mine} to ${theirs}.`;
  return `
    ${masthead()}
    <section class="frame stack guided-result">
      <p class="banner">${outcome}</p>
      <p>${coach.result.real}</p>
      <div class="button-row">
        <button class="button" type="button" data-action="tutorialOnward">${coach.result.onward[onward ?? "home"]}</button>
        <button class="button button--secondary" type="button" data-action="tutorial"${onward === null ? "" : ` data-mode="${onward}"`}>${coach.result.again}</button>
      </div>
    </section>`;
}

// gnomeHTML draws a side's portrait, HP bar and status chips from a gnome or vitals object.
function gnomeHTML(side, vitals, name) {
  const clan = flow.clans[side] || "Shared";
  return `<div class="fighter fighter--${clan.toLowerCase()}" id="fighter-${side}">
    <div class="fighter__portrait" id="portrait-frame-${side}">${portraitHTML(clan, `class="sprite" id="sprite-${side}"`)}<span class="fighter__crest">${emblem(clan)}</span><div class="combat-floats" id="float-${side}" aria-hidden="true"></div></div>
    <div class="fighter__vitals"><div class="fighter__name"><h2>${name}</h2><span class="label">${clan}</span></div><div class="hp__row"><span class="fighter__health-label">Health</span><span class="number" id="hp-num-${side}">${vitals.hp} / ${flow.hp}</span></div>
    <div class="hp__bar"><div class="hp__ghost" id="hp-ghost-${side}" style="width:${hpWidth(vitals.hp)}"></div><div class="hp__fill" id="hp-fill-${side}" style="width:${hpWidth(vitals.hp)}"></div></div><div class="chips" id="chips-${side}">${chipsHTML(vitals)}</div></div></div>`;
}

function chipsHTML(vitals) {
  return [
    ["block", "Block"],
    ["counter", "Counter"],
    ["vulnerable", "Vulnerable"],
    ["strength", "Strength"],
  ]
    .filter(([key]) => vitals[key] > 0)
    .map(
      ([key, label]) => `<span class="chip chip--${key}" data-kw="${key}" tabindex="0">${label} ${vitals[key]}</span>`,
    )
    .join("");
}

function hpWidth(hp) {
  return `${Math.max(0, Math.min(100, (hp / flow.hp) * 100))}%`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card.
// pressed marks a toggle's state, locked a toggle that does nothing, coached the card the
// guided match asks for next. A small card shows cost, name and badges and peeks the full
// card on hover or focus. spentRound, when above 0, marks the round the card was played in.
function cardHTML(
  c,
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
  } = {},
) {
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
    spentRound > 0 ? "card--spent" : "",
  ].join(" ");
  const state = [
    pressed === null ? "" : `aria-pressed="${pressed}"`,
    locked ? `aria-disabled="true" title="The Rare stays in"` : "",
    small ? `data-peek="${c.id}"` : "",
  ].join(" ");
  const badges = [
    c.tier !== "Normal"
      ? `<span class="badge badge--${c.tier.toLowerCase()}" data-kw="${c.tier.toLowerCase()}">${c.tier}</span>`
      : "",
    c.rare ? `<span class="badge badge--rare" data-kw="rare"><span aria-hidden="true">✦</span> Rare</span>` : "",
    spentRound > 0 ? `<span class="badge badge--spent">Spent R${spentRound}</span>` : "",
  ].join("");
  const body = small
    ? `<span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span><span class="card__foot">${badges}</span>`
    : `
    <span class="card__ornament" aria-hidden="true"></span>
    <div class="card__head"><span class="card__cost" aria-label="${c.cost} beats">${c.cost}</span><span class="card__name">${c.name}</span></div>
    ${artHTML(c)}
    <div class="card__text">${markKeywords(c.text)}</div>
    <div class="card__foot"><span class="card__clan">${emblem(clan)}${clan}</span>${badges}</div>`;
  if (action === null) return `<div class="${classes}" ${state} ${small ? `tabindex="0"` : ""} ${data}>${body}</div>`;
  return `<button class="${classes}" type="button" data-action="${action}" data-id="${c.id}" ${hand ? `aria-label="${escapeHTML(`${c.name}, ${c.cost} beats. ${c.text}`).replaceAll('"', "&quot;")}"` : ""} ${state} ${data} ${dimmed ? "disabled" : ""}>${body}</button>`;
}

function smallCards(ids) {
  return ids.map((id) => cardHTML(engine.cards[id], { small: true })).join("");
}

function clanNamed(name) {
  return engine.clans.find((c) => c.name === name);
}

function byId(id) {
  return document.getElementById(id);
}

const matchLink = lobby && location.hash.match(/^#match=(.+)$/);
if (matchLink) {
  flow = { ...initial, screen: "lobby" };
  await lobby.enter(decodeURIComponent(matchLink[1]));
} else render();
