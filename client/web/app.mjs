// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import { loadEngine } from "./engine.mjs";
import { initial, reduce, botTurn } from "./flow.mjs";
import { deckSize, newDeck, toggle, rareOf } from "./deck.mjs";
import { randomDeck, randomPlan } from "./bot.mjs";
import { addCard, beatsUsed, canAdd, clearFrom, isSealable, slots } from "./plan.mjs";
import { sentences, matchLog, resultLine, sideNames } from "./log.mjs";
import { glossary, markKeywords, escapeHTML } from "./keywords.mjs";
import { unseen, spentIn } from "./table.mjs";
import { stepFeedback } from "./battle-feedback.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
const app = document.getElementById("app");
const tip = document.getElementById("tip");
const basics = engine.cards.filter((c) => !c.special).map((c) => c.id);
const stepMs = 1050;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let handScroll = 0;
const flights = new Set();

let flow = initial;
let deck = null; // the deck being picked on the deck screen
let plan = []; // the plan being built on the plan screen
let legalPlans = []; // the acting player's legal plans this round
let playback = null; // {start, steps, lines, shown, timer, hit} for the round being played back

// Every card has an individual illustration; display JPEGs retain separate PNG masters.
const cardArt = {
  "Pick": "pick-v2",
  "Brace": "brace-v2",
  "Pickaxe Flurry": "pickaxe-flurry-v2",
  "Kneecap": "kneecap-v2",
  "Sling Stone": "sling-stone-v2",
  "Dodge Roll": "dodge-roll-v2",
  "Chalk Dust": "chalk-dust-v2",
  "Double Tap": "double-tap-v2",
  "Momentum": "momentum-v2",
  "Undermine": "undermine-v2",
  "Hunker Down": "hunker-down-v2",
  "Boot and Heel": "boot-and-heel-v2",
  "Stone Guard": "stone-guard-v2",
  "Bulwark": "bulwark-v2",
  "Hammer Blow": "hammer-blow-v2",
  "Cobble Throw": "cobble-throw-v2",
  "Spiked Shield": "spiked-shield-v2",
  "Anvil Stomp": "anvil-stomp-v2",
  "Feint": "feint-v2",
  "Avalanche": "avalanche-v2",
  "Shield Catch": "shield-catch-v2",
  "Loose Timbers": "loose-timbers-v2"
};
function cardClan(c) {
  return engine.clans.find((clan) => clan.cards.includes(c.id))?.name ?? "Shared";
}
function emblem(clan) {
  return clan === "Pickers"
    ? '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 26 23 6M5 7c9-5 16-3 23 5M12 26 24 12"/></svg>'
    : '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 6 16 3 26 6v12c0 5-6 9-10 12C12 27 6 23 6 18Z"/><path d="M16 8v15M10 15h12"/></svg>';
}
function artHTML(c) {
  const art = cardArt[c.name];
  return art
    ? `<div class="card__art"><img src="art/${art}.jpg" alt="" loading="lazy"></div>`
    : `<div class="card__art card__art--pending">${emblem(cardClan(c))}<span>Clan study · art to come</span></div>`;
}
function collectionHTML() {
  const groups = [...engine.clans.map((clan) => ({ name: clan.name, ids: clan.cards })), { name: "Shared", ids: basics }];
  return `<details class="collection"><summary>Browse all ${engine.cards.length} cards<span>Pickers, Ironhide & shared techniques</span></summary>
    <div class="collection__groups">${groups.map(({ name, ids }) => `<section class="stack"><div class="frame__head"><h2 class="heading">${name === "Shared" ? "Shared techniques" : name}</h2><span class="label">${ids.length} cards</span></div><div class="card-grid">${ids.map((id) => cardHTML(engine.cards[id])).join("")}</div></section>`).join("")}</div>
  </details>`;
}

function masthead(note = "A duel beneath the mountain") {
  return `<header class="masthead"><a class="wordmark" href="./">Gnomehall<span>UNDER THE MOUNTAIN</span></a><span class="masthead__note">${note}</span></header>`;
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
  if (before.screen === "playback") { stopPlaying(); playback = null; }
  if (flow.screen === "deck") {
    if (botTurn(flow)) {
      const clan = engine.clans[Math.floor(Math.random() * engine.clans.length)];
      dispatch({ type: "deckReady", clan: clan.name, deck: randomDeck(clan, engine.cards, Math.random) });
      return;
    }
    deck = newDeck(engine.clans[0], engine.cards);
  }
  if (flow.screen === "plan") {
    const plans = engine.legalPlans({ state: flow.state, side: flow.acting, deck: flow.decks[flow.acting] });
    if (botTurn(flow)) {
      dispatch({ type: "planSealed", plan: randomPlan(plans, Math.random) });
      return;
    }
    legalPlans = plans;
    plan = [];
  }
  if (flow.screen === "playback") {
    const start = flow.state.gnomes.map((g) => ({ hp: g.hp, block: 0, counter: 0, vulnerable: g.vulnerable, strength: g.strength }));
    const { state, result, events } = engine.resolve({ state: flow.state, decks: flow.decks, a: flow.plans[0], b: flow.plans[1] });
    const names = sideNames(flow.clans, flow.mode);
    playback = {
      start,
      steps: groupSteps(events),
      lines: sentences(events, { cards: engine.cards, names, plans: flow.plans }),
      shown: 0,
      timer: null,
      speed: 1,
      revealTimer: null,
      viewer: flow.mode === "bot" ? 0 : flow.acting,
    };
    dispatch({ type: "resolved", state, result, events });
  }
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

const handlers = {
  start: ({ mode }) => dispatch({ type: "start", mode, hp: engine.hp }),
  clan: ({ name }) => {
    deck = newDeck(clanNamed(name), engine.cards);
    render();
  },
  toggle: ({ id }) => {
    deck = toggle(deck, Number(id), clanNamed(deck.clan), engine.cards);
    render();
  },
  deckReady: () => dispatch({ type: "deckReady", clan: deck.clan, deck: [...deck.picks].sort((a, b) => a - b) }),
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
    app.querySelectorAll(".hand-entry").forEach(el => el.classList.add("hand-entry--resting"));
    flyCard(source, from, app.querySelector(`[data-plan-index="${index}"]`));
    byId("plan-status").textContent = `${engine.cards[cardId].name} added. ${beatsUsed(plan, engine.cards)} of 3 beats filled.`;
  },
  clearFrom: ({ beat }) => {
    plan = clearFrom(plan, Number(beat), engine.cards);
    render();
  },
  clearPlan: () => { plan = []; render(); },
  inspectCard: ({ id }) => {
    if (flow.screen === "playback") stopPlaying();
    const c = engine.cards[Number(id)];
    const legal = flow.screen === "plan" && canAdd(plan, c.id, engine.cards, available());
    const reader = byId("card-reader");
    byId("reader-content").innerHTML = `${cardHTML(c)}<p class="muted">${c.cost} ${c.cost === 1 ? "beat" : "beats"}${c.special ? " · Once per match" : " · Reusable basic"}</p>
      ${legal ? `<button class="button" type="button" data-action="addCard" data-id="${c.id}">Play ${c.name}</button>` : `<p class="muted">${flow.screen === "playback" ? "Committed this round." : flow.state.gnomes[flow.acting].spent.includes(c.id) ? "Already spent this match." : "This card does not fit your current plan."}</p>`}`;
    openDialog(reader);
  },
  playedCards: () => { if (flow.screen === "playback") stopPlaying(); openDialog(byId("played-cards")); },
  intel: () => { if (flow.screen === "playback") stopPlaying(); openDialog(byId("battle-info")); },
  closeDialog: () => closeBattleDialogs(),
  seal: () => { closeBattleDialogs(); dispatch({ type: "planSealed", plan }); },
  next: () => { stopPlaying(); showStep(playback.shown + 1); },
  play: () => (playback.timer || playback.revealTimer ? stopPlaying() : startPlaying()),
  skip: () => { stopPlaying(); for (const card of app.querySelectorAll(".card-reveal")) card.classList.remove("card-reveal"); showStep(playback.steps.length, false); },
  playbackDone: () => dispatch({ type: "playbackDone" }),
  rematch: () => dispatch({ type: "rematch" }),
  newMatch: () => dispatch({ type: "newMatch" }),
  copyLog: () => copyMatchLog(),
};

document.addEventListener("pointermove", event => {
  for (const entry of app.querySelectorAll(".hand-entry--resting")) {
    const rect = entry.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) entry.classList.remove("hand-entry--resting");
  }
});
app.addEventListener("pointerout", event => {
  const entry = event.target.closest?.(".hand-entry--resting");
  if (entry && !entry.contains(event.relatedTarget)) entry.classList.remove("hand-entry--resting");
});
document.addEventListener("keydown", () => app.querySelectorAll(".hand-entry--resting").forEach(el => el.classList.remove("hand-entry--resting")));
app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
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
  if (top + tip.offsetHeight > window.innerHeight && at.top - gap - tip.offsetHeight >= 0) top = at.top - gap - tip.offsetHeight;
  top = Math.max(gap, Math.min(top, window.innerHeight - tip.offsetHeight - gap));
  const left = Math.max(gap, Math.min(at.left, window.innerWidth - tip.offsetWidth - gap));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
}

// available lists the ids the acting player may play: the basics and the deck's unspent specials.
function available() {
  const spent = flow.state.gnomes[flow.acting].spent;
  return [...basics, ...flow.decks[flow.acting].filter((id) => !spent.includes(id))];
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
  if (target === playback.steps.length && playback.timer) { clearInterval(playback.timer); playback.timer = null; }
  patchPlayback();
  if (animate && sequential && target > 0) {
    const step = playback.steps[target - 1];
    animateStep(round.events.slice(step.from, step.to));
  }
}

function queueReveal(session, delay) {
  session.revealAt = performance.now() + delay;
  session.revealTimer = setTimeout(() => {
    if (playback === session && flow.screen === "playback") { session.revealTimer = null; startPlaying(); }
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
  ghost.removeAttribute("data-action"); ghost.removeAttribute("data-peek");
  ghost.setAttribute("aria-hidden", "true"); ghost.tabIndex = -1;
  ghost.classList.add("flying-card");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.append(ghost); flights.add(ghost);
  const x = to.left + to.width / 2 - from.left - from.width / 2;
  const y = to.top + to.height / 2 - from.top - from.height / 2;
  const animation = animateElement(ghost, [
    { transform: "translate(0,0) scale(1)", opacity: 1 },
    { transform: `translate(${x}px,${y}px) scale(.65)`, opacity: 0 },
  ], { duration: 440 });
  animateElement(destination, [{ opacity: .15, transform: "scale(.92)" }, { opacity: 1, transform: "scale(1)" }], { delay: 180, duration: 280 });
  animation?.finished.then(() => { ghost.remove(); flights.delete(ghost); }, () => { ghost.remove(); flights.delete(ghost); });
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
      f.counter > 0 ? `<span class="combat-float combat-float--buff">Counter +${f.counter}</span>` : "",
      f.strength > 0 ? `<span class="combat-float combat-float--buff">Strength +${f.strength}</span>` : "",
      f.vulnerable > 0 ? `<span class="combat-float combat-float--debuff">Vulnerable +${f.vulnerable}</span>` : "",
    ].join("");
    byId(`float-${side}`).innerHTML = labels;
    const portrait = byId(`sprite-${side}`);
    if (f.damage > 0) animateElement(portrait, [{ transform: "translateX(0)", filter: "brightness(1)" }, { transform: "translateX(-7px)", filter: "brightness(1.5)" }, { transform: "translateX(5px)" }, { transform: "translateX(0)", filter: "brightness(1)" }], { duration: 320 });
    if (f.blocked > 0 || f.block > 0) animateElement(byId(`portrait-frame-${side}`), [{ boxShadow: "0 0 0 0 #9ad8ef00" }, { boxShadow: "0 0 0 9px #9ad8ef88" }, { boxShadow: "0 0 0 15px #9ad8ef00" }], { duration: 600 });
    if (f.strength || f.counter || f.vulnerable) animateElement(byId(`chips-${side}`), [{ opacity: .3, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }]);
  }
  const active = new Set();
  for (const event of events) {
    const actor = event.kind === "Cancelled" ? 1 - event.side : event.side;
    const index = laid[actor][event.beat - 1]?.index;
    const key = `${actor}:${index}`;
    if (!active.has(key)) animateElement(app.querySelector(`.card--track[data-side="${actor}"][data-index="${index}"]`), [{ transform: "translateY(0)" }, { transform: "translateY(-7px) scale(1.03)" }, { transform: "translateY(0)" }], { duration: 500 });
    active.add(key);
  }
  for (const cancelled of feedback.cancelled) {
    const index = laid[cancelled.side][cancelled.beat - 1]?.index;
    const card = app.querySelector(`.card--track[data-side="${cancelled.side}"][data-index="${index}"]`);
    animateElement(card, [{ transform: "rotate(0)" }, { transform: "rotate(-3deg)" }, { transform: "rotate(3deg)" }, { transform: "rotate(0)" }], { duration: 350 });
  }
}

function openDialog(dialog) {
  showTip(null);
  if (dialog && !dialog.open) { dialog.showModal(); dialog.append(tip); }
}
function closeBattleDialogs() {
  for (const dialog of app.querySelectorAll("dialog[open]")) dialog.close();
  document.body.append(tip);
  showTip(null);
}
app.addEventListener("close", () => { document.body.append(tip); showTip(null); }, true);
app.addEventListener("change", (event) => {
  if (event.target.id !== "playback-speed" || !playback) return;
  const running = Boolean(playback.timer);
  const revealing = Boolean(playback.revealTimer);
  const remaining = revealing ? Math.max(0, playback.revealAt - performance.now()) : 0;
  stopPlaying(); playback.speed = Number(event.target.value);
  if (revealing) queueReveal(playback, remaining);
  else if (running) startPlaying(false);
});
app.addEventListener("scroll", () => showTip(null), true);
app.addEventListener("click", (event) => {
  if (event.target instanceof HTMLDialogElement) {
    const box = event.target.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlaying(); });

// copyMatchLog copies the log shown on the result screen; the text stays visible either way.
function copyMatchLog() {
  const area = byId("match-log");
  area.select();
  const done = () => {
    byId("copied").textContent = "Copied.";
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(area.value).then(done, () => done(document.execCommand("copy")));
  else done(document.execCommand("copy"));
}

// ---- Rendering

function render() {
  const screens = { title, deck: deckScreen, handoff, plan: planScreen, playback: playbackScreen, result: resultScreen };
  if (flow.screen === "playback" && app.dataset.screen === "playback") return;
  const previousScreen = app.dataset.screen;
  const focus = document.activeElement;
  const key = focus?.matches(":focus-visible") && focus?.dataset.action ? { action: focus.dataset.action, id: focus.dataset.id, beat: focus.dataset.beat } : null;
  handScroll = app.querySelector(".battle-hand")?.scrollLeft ?? 0;
  for (const ghost of flights) ghost.remove(); flights.clear();
  if (app.contains(tip)) document.body.append(tip);
  app.innerHTML = screens[flow.screen]();
  app.dataset.screen = flow.screen;
  app.classList.toggle("board--battle", ["plan", "playback"].includes(flow.screen));
  if (flow.screen === "plan") {
    app.querySelector(".battle-hand").scrollLeft = previousScreen === "plan" ? handScroll : 0;
    if (previousScreen === "plan" && key) {
      let target = [...app.querySelectorAll("[data-action]")].find(el => el.dataset.action === key.action && el.dataset.id === key.id && el.dataset.beat === key.beat && !el.disabled);
      target ??= byId("seal")?.disabled ? app.querySelector('.battle-hand [data-action="addCard"]:not(:disabled)') : byId("seal");
      target?.focus({ preventScroll: true });
    }
  }
  if (flow.screen === "playback") {
    patchPlayback();
    const session = playback;
    queueReveal(session, reducedMotion.matches ? 450 : 1050);
  }
  if (previousScreen !== flow.screen) animateElement(app.querySelector(".duel-table"), [{ opacity: .2, transform: "translateY(7px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 360 });
  dropStaleTip();
}

// dropStaleTip hides the tip once its anchor has been rendered away.
function dropStaleTip() {
  if (tipAnchor && !tipAnchor.isConnected) showTip(null);
}

function title() {
  const studies = ["Sling Stone", "Momentum", "Hunker Down", "Bulwark", "Cobble Throw", "Loose Timbers"]
    .map((name) => cardHTML(engine.cards.find((c) => c.name === name))).join("");
  return `${masthead("Two clans. One unsettled score.")}
    <section class="intro">
      <div class="intro__copy"><span class="eyebrow">A TACTICAL CARD DUEL</span>
        <h1>Small gnomes.<br>Big grudges.</h1>
        <p>Deep beneath the mountain, a quarrel is settled in three rounds. Choose your clan. Plot three beats. Let the sparks fly.</p>
        <div class="button-row">
          <button class="button" type="button" data-action="start" data-mode="bot">Enter the hall <span aria-hidden="true">→</span></button>
          <button class="button button--secondary" type="button" data-action="start" data-mode="hotseat">Two players</button>
        </div><span class="intro__caption">Versus the bot, or a friend at the same table.</span>
      </div>
      <div class="intro__art"><img src="art/hall-hero-v2.jpg" alt="Gnomes from both clans gather around a card table in the underground hall"><span class="intro__art-label">GNOMEHALL <span>Different clans. Shared grudges.</span></span></div>
    </section>
    <section class="showcase showcase--roster"><div class="frame__head"><div><span class="eyebrow">FROM THE CLAN ARCHIVES</span><h2 class="heading">Many faces. Shared grudges.</h2></div><span class="muted">Three Pickers · three Ironhide</span></div><div class="showcase__cards">${studies}</div></section>
    ${collectionHTML()}
    <footer class="hall-footer"><span>Forged below. Settled at the table.</span><span>3 rounds <b>·</b> 3 beats <b>·</b> 1 rival</span></footer>`;
}

function deckScreen() {
  const clan = clanNamed(deck.clan);
  const rare = rareOf(clan, engine.cards);
  const picked = deck.picks.length - 1;
  const legal = engine.legalDeck({ clan: deck.clan, deck: deck.picks });
  const heading = flow.mode === "bot" ? "Pick your deck" : `Player ${flow.acting + 1} picks a deck`;
  const tabs = engine.clans
    .map((c) => `<button class="button ${c.name === deck.clan ? "" : "button--secondary"}" type="button" data-action="clan" data-name="${c.name}">${c.name}</button>`)
    .join("");
  const full = deck.picks.length >= deckSize;
  const pool = clan.cards
    .map((id) => {
      const picked = deck.picks.includes(id);
      return cardHTML(engine.cards[id], { selected: picked, pressed: picked, locked: id === rare, dimmed: full && !picked, action: "toggle" });
    })
    .join("");
  return `
    ${masthead()}
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${heading}</h2><span class="hint">The Rare stays in. Pick 7 more.</span></div>
      <div class="clan-banner clan-banner--${deck.clan.toLowerCase()}"><img class="clan-banner__portrait" src="art/${deck.clan.toLowerCase()}-portrait-v2.jpg" alt="${deck.clan} clan champion"><div><span class="eyebrow">CHOOSE YOUR ALLEGIANCE</span><h3 class="heading clan-banner__name">${emblem(deck.clan)}${deck.clan}</h3><p>${deck.clan === "Pickers" ? "Quick hands. Dirty tricks. A miner’s tools, a duelist’s timing." : "Stand firm. Strike hard. Iron shields and the weight of the mountain."}</p></div><div class="button-row">${tabs}</div></div>
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

function battleHeaderHTML() {
  return `<header class="battle-header"><a class="wordmark" href="./">Gnomehall</a><span class="battle-header__note">A quarrel in three rounds</span>
    <button class="button button--secondary battle-intel-button" type="button" data-action="intel">Opponent & history</button></header>`;
}

function roundHTML(round, phase) {
  return `<div class="round-medallion"><span class="eyebrow">${phase}</span><span class="round-medallion__number">${round}<small> / 3</small></span>
    <div class="round-pips" aria-label="Round ${round} of 3">${[1, 2, 3].map(n => `<span class="${n === round ? "round-pip--current" : n < round ? "round-pip--done" : ""}"></span>`).join("")}</div></div>`;
}

function beatMarkersHTML() {
  return `<div class="beat-markers">${[1, 2, 3].map(n => `<span class="timeline__beat" id="beat-${n}"><span class="beat-marker__gem" aria-hidden="true"></span>Beat ${n}</span>`).join("")}</div>`;
}

function battleDialogsHTML(viewer) {
  const opponent = 1 - viewer;
  const names = sideNames(flow.clans, flow.mode);
  const held = unseen(clanNamed(flow.clans[opponent]).cards, flow.state.gnomes[opponent].spent, engine.cards);
  const past = flow.screen === "playback" ? flow.rounds.slice(0, -1) : flow.rounds;
  const history = past.map((round, i) => `<section class="stack"><h3 class="heading">Round ${i + 1}</h3>${[0, 1].map(side => `<div><span class="label">${names[side]}</span><div class="row">${smallCards(round.plans[side])}</div></div>`).join("")}</section>`).join("");
  const played = past.map((round, i) => `<section class="stack"><h3 class="heading">Round ${i + 1}</h3><div class="card-grid">${round.plans[viewer].map(id => cardHTML(engine.cards[id])).join("")}</div></section>`).join("");
  return `<dialog class="battle-drawer" id="played-cards" aria-labelledby="played-title"><div class="dialog-heading"><h2 class="heading" id="played-title">Your played cards</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close played cards">×</button></div>${played || `<p class="muted">No cards played yet.</p>`}</dialog><dialog class="battle-drawer" id="battle-info" aria-labelledby="intel-title"><div class="dialog-heading"><h2 class="heading" id="intel-title">Across the table</h2><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close opponent information">×</button></div>
    <section class="stack"><h3 class="heading">${names[opponent]}'s unspent pool</h3><p class="muted">${deckSize - flow.state.gnomes[opponent].spent.length} of these ${held.length} cards are in their deck. Unspent pool cards are public; their current plan stays hidden until the reveal.</p>
      <div class="card-grid">${held.map(id => cardHTML(engine.cards[id])).join("") || `<p class="muted">Every card is spent.</p>`}</div></section>
    <section class="stack intel-history"><h3 class="heading">Earlier rounds</h3>${history || `<p class="muted">No rounds played yet.</p>`}</section></dialog>
    <dialog class="card-reader" id="card-reader" aria-label="Card details"><button class="dialog-close" type="button" data-action="closeDialog" aria-label="Close card details">×</button><div id="reader-content" class="stack"></div></dialog>`;
}

function planScreen() {
  const me = flow.acting, opponent = 1 - me;
  const names = sideNames(flow.clans, flow.mode);
  const used = beatsUsed(plan, engine.cards);
  const sealable = isSealable(plan, legalPlans);
  const handIds = [...basics, ...flow.decks[me].filter(id => !flow.state.gnomes[me].spent.includes(id) && !plan.includes(id))];
  const playedCount = flow.rounds.reduce((n, round) => n + round.plans[me].length, 0);
  const hand = handIds.map((id, index) => {
    const c = engine.cards[id];
    const spentRound = c.special ? spentIn(flow.rounds, me, id) : 0;
    const inPlan = c.special && plan.includes(id);
    return `<div class="hand-entry" style="--hand-order:${index};--hand-tilt:${(index - (handIds.length - 1) / 2) * 4}deg;--hand-rise:${Math.pow(index - (handIds.length - 1) / 2, 2) * 2}px">
      ${cardHTML(c, { action: matchMedia("(hover: none)").matches ? "inspectCard" : "addCard", hand: true, dimmed: !canAdd(plan, id, engine.cards, available()), spentRound, inPlan })}
      <button class="card-inspect" type="button" data-action="inspectCard" data-id="${id}" aria-label="Inspect ${c.name}">Details</button></div>`;
  }).join("");
  const backs = [1, 2, 3].map(() => `<div class="card-back card-back--${flow.clans[opponent].toLowerCase()}" aria-hidden="true"><span>${emblem(flow.clans[opponent])}</span></div>`).join("");
  return `${battleHeaderHTML()}
    <section class="duel-table" aria-label="Round ${flow.state.round} battle table">
      <div class="duel-fighters">${gnomeHTML(me, flow.state.gnomes[me], names[me], true)}${roundHTML(flow.state.round, "Planning")}${gnomeHTML(opponent, flow.state.gnomes[opponent], names[opponent], true)}</div>
      <div class="track-row track-row--opponent"><div class="track-row__label"><span class="label">${names[opponent]}'s plan</span><span class="track-hint">Sealed in secret</span></div><div class="plan-track plan-track--hidden" aria-label="Opponent plan hidden">${backs}</div></div>
      ${beatMarkersHTML()}
      <div class="track-row track-row--yours"><div class="track-row__label"><span class="label">Your plan</span><span class="track-hint">${used} of 3 beats filled</span></div>${slotsHTML()}</div>
      <p class="table-caption">Choose the order. Anticipate their move.</p>
    </section>
    <div class="battle-controls"><div><h2 class="heading">Plot your next move</h2><span class="muted" id="plan-status" role="status">${sealable ? "Your plan is ready. Seal it when you're sure." : "Play cards to fill all three beats."}</span></div>
      <div class="button-row"><button class="button button--secondary" type="button" data-action="clearPlan" ${plan.length ? "" : "disabled"}>Clear</button><button class="button" type="button" data-action="seal" id="seal" ${sealable ? "" : "disabled"}>Seal plan</button></div></div>
    <section class="hand-zone" aria-label="Your hand"><div class="hand-zone__heading"><span class="label">Your hand <span>${handIds.length} cards</span></span><span class="muted">Lift a card to read · click to play · tap to inspect</span></div><div class="hand-layout"><div class="battle-hand card-grid" style="--hand-count:${handIds.length}">${hand}</div><button class="played-pile" type="button" data-action="playedCards" ${playedCount ? "" : "disabled"} aria-label="Open played cards, ${playedCount} cards"><span class="pile-back card-back card-back--${flow.clans[me].toLowerCase()}"><span>${emblem(flow.clans[me])}</span></span><span class="label">Played cards</span><span class="muted">${playedCount} cards · inspect</span></button></div></section>
    ${battleDialogsHTML(me)}`;
}

// Cards retain playing-card proportions; their brackets span the occupied beats.
function slotsHTML() {
  let beat = 0;
  const filled = plan.map((id, index) => {
    const c = engine.cards[id]; const from = beat; beat += c.cost;
    return `<div class="slot" data-plan-index="${index}" style="grid-column:span ${c.cost}">${cardHTML(c, { track: true, action: "clearFrom", data: `data-beat="${from}"` })}<span class="track-note">${c.parry > 0 ? `Guards ${c.cost === 1 ? `beat ${beat}` : `beats ${from + 1}–${beat}`}` : c.cost > 1 ? `Lands on beat ${beat}` : "Click to remove"}</span></div>`;
  });
  const empty = Array.from({ length: 3 - beat }, (_, index) => `<div class="slot"><div class="slot__well"><span class="slot__number">${beat + index + 1}</span><span>Choose a card</span></div><span class="track-note">Empty beat</span></div>`);
  return `<div class="plan-track plan-track--yours">${filled.join("")}${empty.join("")}</div>`;
}

function playbackScreen() {
  const round = flow.rounds.at(-1);
  const names = sideNames(flow.clans, flow.mode);
  const me = playback.viewer, opponent = 1 - me;
  const row = side => {
    let beat = 0;
    return `<div class="track-row ${side === me ? "track-row--yours" : "track-row--opponent"}"><div class="track-row__label"><span class="label">${names[side]}'s plan</span><span class="track-hint">Revealed</span></div><div class="plan-track">${round.plans[side].map((id, index) => {
      const c = engine.cards[id];const from = beat + 1;beat += c.cost;
      const note = c.parry > 0 ? `Guards ${from === beat ? `beat ${beat}` : `beats ${from}–${beat}`}` : c.cost > 1 ? `Lands on beat ${beat}` : `Beat ${beat}`;
      return `<div class="slot card-reveal" style="grid-column:span ${c.cost};--reveal-delay:${index * 120}ms">${cardHTML(c, { track: true, action: "inspectCard", data: `data-side="${side}" data-index="${index}"` })}<span class="track-note">${note}</span></div>`;
    }).join("")}</div></div>`;
  };
  return `${battleHeaderHTML()}
    <section class="duel-table duel-table--playback" aria-label="Round ${round.state.round - 1} battle table">
      <div class="duel-fighters">${gnomeHTML(me, playback.start[me], names[me], true)}${roundHTML(round.state.round - 1, "The clash")}${gnomeHTML(opponent, playback.start[opponent], names[opponent], true)}</div>
      ${row(opponent)}${beatMarkersHTML()}${row(me)}
      <p class="battle-event" id="battle-event" role="status" aria-live="polite">Both plans revealed. The clash begins.</p>
    </section>
    <div class="battle-controls playback-controls"><div class="button-row"><button class="button" type="button" data-action="play" id="play">Pause</button><button class="button button--secondary" type="button" data-action="next" id="next">Next step</button><button class="button button--secondary" type="button" data-action="skip" id="skip">Skip</button></div>
      <div class="playback-meta"><span class="label" id="progress"></span><label class="speed-control">Speed <select id="playback-speed"><option value=".7">Slow</option><option value="1" selected>Normal</option><option value="1.7">Fast</option></select></label></div><div class="battle-finish" id="finish"></div></div>
    <details class="battle-log"><summary>Round details <span class="muted">Every hit, block and interruption</span></summary><div class="log log--grid" id="log"></div></details>
    ${battleDialogsHTML(me)}`;
}

function patchPlayback() {
  if (!playback || flow.screen !== "playback" || app.dataset.screen !== "playback") return;
  const round = flow.rounds.at(-1);
  const { steps, shown, lines } = playback;
  const vitalsAt = n => n === 0 ? playback.start : round.events[steps[n - 1].to - 1].after;
  const vitals = vitalsAt(shown), previous = vitalsAt(Math.max(0, shown - 1));
  const current = shown > 0 ? steps[shown - 1] : null;
  for (const side of [0, 1]) {
    byId(`hp-fill-${side}`).style.width = hpWidth(vitals[side].hp);
    byId(`hp-ghost-${side}`).style.width = hpWidth(previous[side].hp);
    byId(`hp-num-${side}`).textContent = `${vitals[side].hp} / ${flow.hp}`;
    byId(`chips-${side}`).innerHTML = chipsHTML(vitals[side]);
    byId(`fighter-${side}`).classList.toggle("fighter--defeated", vitals[side].hp <= 0);
  }
  const laid = round.plans.map(p => slots(p, engine.cards));
  const acting = new Set(current ? round.events.slice(current.from, current.to).map(ev => { const side = ev.kind === "Cancelled" ? 1 - ev.side : ev.side; return `${side}:${laid[side][current.beat - 1]?.index}`; }) : []);
  const until = shown > 0 ? steps[shown - 1].to : 0;
  const cancelled = new Set(round.events.slice(0, until).filter(ev => ev.kind === "Cancelled").map(ev => `${ev.side}:${laid[ev.side][ev.beat - 1]?.index}`));
  for (const b of [1, 2, 3]) {
    byId(`beat-${b}`).classList.toggle("timeline__beat--current", current?.beat === b);
    byId(`beat-${b}`).classList.toggle("timeline__beat--past", current?.beat > b);
  }
  for (const el of app.querySelectorAll(".card--track[data-side][data-index]")) {
    const key = `${el.dataset.side}:${el.dataset.index}`;
    el.classList.toggle("card--acting", acting.has(key));
    el.classList.toggle("card--cancelled", cancelled.has(key));
    el.setAttribute("aria-label", `${engine.cards[Number(el.dataset.id)].name}${cancelled.has(key) ? ", cancelled" : ""}. Inspect card.`);
  }
  byId("log").innerHTML = logHTML(round, steps, shown, lines);
  const done = shown >= steps.length;
  const names = sideNames(flow.clans, flow.mode);
  const caption = done ? `Round complete. ${names[playback.viewer]}: ${vitals[playback.viewer].hp} HP · ${names[1 - playback.viewer]}: ${vitals[1 - playback.viewer].hp} HP.` : current ? lines.slice(current.from, current.to).join(" · ") : "Both plans revealed. The clash begins.";
  if (byId("battle-event").textContent !== caption) byId("battle-event").textContent = caption;
  byId("next").disabled = done;byId("skip").disabled = done;byId("play").disabled = done;
  byId("play").textContent = playback.timer || playback.revealTimer ? "Pause" : "Play";
  byId("progress").textContent = done ? "Round resolved" : current ? `Beat ${current.beat} · ${current.phase}` : "Plans revealed";
  byId("finish").innerHTML = done ? finishHTML() : "";
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
  return groups.map((g) => `<span class="log__beat" style="grid-row: span ${g.lines.length}">Beat ${g.beat}</span>${g.lines.join("")}`).join("");
}

function finishHTML() {
  const names = sideNames(flow.clans, flow.mode);
  if (flow.result === "ongoing") {
    return `<div class="button-row"><button class="button" type="button" data-action="playbackDone">Round ${flow.state.round}</button></div>`;
  }
  const knockout = flow.state.gnomes.some((g) => g.hp <= 0);
  return `
    <p class="banner">${knockout ? "Knockout!" : "Three rounds played."} ${resultLine(flow.result, names)}</p>
    <div class="button-row"><button class="button" type="button" data-action="playbackDone">Continue</button></div>`;
}

function resultScreen() {
  const names = sideNames(flow.clans, flow.mode);
  const sides = [0, 1]
    .map((side) => {
      const g = flow.state.gnomes[side];
      const unplayed = flow.decks[side].filter((id) => !g.spent.includes(id)).map((id) => cardHTML(engine.cards[id], { small: true })).join("");
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

// gnomeHTML draws a side's sprite, HP bar and status chips from a gnome or vitals object.
function gnomeHTML(side, vitals, name, fighter = false) {
  const clan = flow.clans[side];
  if (fighter) return `<div class="fighter fighter--${clan.toLowerCase()}" id="fighter-${side}">
    <div class="fighter__portrait" id="portrait-frame-${side}"><img class="sprite" id="sprite-${side}" src="art/${clan.toLowerCase()}-portrait-v2.jpg" alt="${clan} champion"><span class="fighter__crest">${emblem(clan)}</span><div class="combat-floats" id="float-${side}" aria-hidden="true"></div></div>
    <div class="fighter__vitals"><div class="fighter__name"><h2>${name}</h2><span class="label">${clan}</span></div><div class="hp__row"><span class="fighter__health-label">Health</span><span class="number" id="hp-num-${side}">${vitals.hp} / ${flow.hp}</span></div>
    <div class="hp__bar"><div class="hp__ghost" id="hp-ghost-${side}" style="width:${hpWidth(vitals.hp)}"></div><div class="hp__fill" id="hp-fill-${side}" style="width:${hpWidth(vitals.hp)}"></div></div><div class="chips" id="chips-${side}">${chipsHTML(vitals)}</div></div></div>`;
  return `
    <div class="gnome ${side === 1 ? "gnome--mirror" : ""}">
      <img class="sprite" id="sprite-${side}" src="art/${flow.clans[side] === "Pickers" ? "pickers-portrait-v2" : "ironhide-portrait-v2"}.jpg" alt="${name}">
      <div class="hp">
        <div class="hp__row"><span class="label">${name}</span><span class="number" id="hp-num-${side}">${vitals.hp} / ${flow.hp}</span></div>
        <div class="hp__bar"><div class="hp__ghost" id="hp-ghost-${side}" style="width: ${hpWidth(vitals.hp)}"></div><div class="hp__fill" id="hp-fill-${side}" style="width: ${hpWidth(vitals.hp)}"></div></div>
        <div class="chips" id="chips-${side}">${chipsHTML(vitals)}</div>
      </div>
    </div>`;
}

function chipsHTML(vitals) {
  return [
    ["block", "Block"],
    ["counter", "Counter"],
    ["vulnerable", "Vulnerable"],
    ["strength", "Strength"],
  ]
    .filter(([key]) => vitals[key] > 0)
    .map(([key, label]) => `<span class="chip chip--${key}" data-kw="${key}" tabindex="0">${label} ${vitals[key]}</span>`)
    .join("");
}

function hpWidth(hp) {
  return `${Math.max(0, Math.min(100, (hp / flow.hp) * 100))}%`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card. A
// pressed value marks a toggle's state; locked marks a toggle that does nothing. A small card
// shows cost, name and badges and peeks the full card on hover or focus. spentRound, when
// above 0, marks the round the card was played in.
function cardHTML(c, { selected = false, dimmed = false, small = false, locked = false, pressed = null, action = null, data = "", spentRound = 0, hand = false, track = false, inPlan = false } = {}) {
  const clan = cardClan(c);
  const classes = ["card", `card--${clan.toLowerCase()}`, hand ? "card--hand" : "", track ? "card--track" : "", inPlan ? "card--in-plan" : "", c.rare ? "card--rare" : "", c.special ? "" : "card--basic", selected ? "card--selected" : "", dimmed ? "card--dimmed" : "", small ? "card--small" : "", locked ? "card--locked" : ""].join(" ");
  const state = [pressed === null ? "" : `aria-pressed="${pressed}"`, locked ? `aria-disabled="true" title="The Rare stays in"` : "", small ? `data-peek="${c.id}"` : ""].join(" ");
  const badges = [
    c.tier !== "Normal" ? `<span class="badge badge--${c.tier.toLowerCase()}" data-kw="${c.tier.toLowerCase()}">${c.tier}</span>` : "",
    c.rare ? `<span class="badge badge--rare" data-kw="rare"><span aria-hidden="true">✦</span> Rare</span>` : "",
    spentRound > 0 ? `<span class="badge badge--spent">Spent R${spentRound}</span>` : inPlan ? `<span class="badge badge--spent">In plan</span>` : "",
  ].join("");
  const body = small
    ? `${track ? `<span class="card__thumb"><img src="art/${cardArt[c.name]}.jpg" alt=""></span>` : ""}<span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span><span class="card__foot">${badges}</span>`
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

render();
