// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import { loadEngine } from "./engine.mjs";
import { initial, reduce, botTurn } from "./flow.mjs";
import { newDeck, toggle, rareOf } from "./deck.mjs";
import { randomDeck, randomPlan } from "./bot.mjs";
import { addCard, beatsUsed, canAdd, clearFrom, isSealable } from "./plan.mjs";
import { sideNames } from "./log.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
const app = document.getElementById("app");
const basics = engine.cards.filter((c) => !c.special).map((c) => c.id);

let flow = initial;
let deck = null; // the deck being picked on the deck screen
let plan = []; // the plan being built on the plan screen
let legalPlans = []; // the acting player's legal plans this round

// ---- Actions

function dispatch(action) {
  const before = flow;
  flow = reduce(flow, action);
  enter(before);
  render();
}

// enter runs what a screen needs on arrival: a fresh deck or plan to build, the legal
// plans from the engine, or the bot's move.
function enter(before) {
  const arrived = flow.screen !== before.screen || flow.acting !== before.acting;
  if (!arrived) return;
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
    plan = addCard(plan, Number(id), engine.cards, available());
    render();
  },
  clearFrom: ({ beat }) => {
    plan = clearFrom(plan, Number(beat), engine.cards);
    render();
  },
  seal: () => dispatch({ type: "planSealed", plan }),
};

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handlers[target.dataset.action]?.(target.dataset);
});

// available lists the ids the acting player may play: the basics and the deck's unspent specials.
function available() {
  const spent = flow.state.gnomes[flow.acting].spent;
  return [...basics, ...flow.decks[flow.acting].filter((id) => !spent.includes(id))];
}

// ---- Rendering

function render() {
  const screens = { title, deck: deckScreen, handoff, plan: planScreen, playback: placeholder("Playback"), result: placeholder("Result") };
  app.innerHTML = screens[flow.screen]();
}

function title() {
  return `
    <h1 class="title">Gnomehall</h1>
    <section class="frame stack">
      <p class="muted">Two gnomes, three rounds of three beats. Seal a plan, watch the plans collide.</p>
      <div class="button-row">
        <button class="button" type="button" data-action="start" data-mode="hotseat">Two players</button>
        <button class="button button--secondary" type="button" data-action="start" data-mode="bot">Versus bot</button>
      </div>
    </section>`;
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
  const pool = clan.cards
    .map((id) => cardHTML(engine.cards[id], { selected: deck.picks.includes(id), action: id === rare ? null : "toggle" }))
    .join("");
  return `
    <h1 class="title">Gnomehall</h1>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${heading}</h2><span class="label">The Rare stays in. Pick 7 more.</span></div>
      <div class="button-row">${tabs}</div>
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

function planScreen() {
  const me = flow.acting;
  const opp = 1 - me;
  const names = sideNames(flow.clans, flow.mode);
  const gnomes = flow.state.gnomes;
  const spentCards = gnomes[opp].spent.map((id) => cardHTML(engine.cards[id], { small: true })).join("");
  const history = flow.rounds
    .map((round, i) => `<li>Round ${i + 1}: ${names[0]} played ${planNames(round.plans[0])}; ${names[1]} played ${planNames(round.plans[1])}.</li>`)
    .join("");
  const hand = available()
    .map((id) => cardHTML(engine.cards[id], { action: "addCard", dimmed: !canAdd(plan, id, engine.cards, available()) }))
    .join("");
  const used = beatsUsed(plan, engine.cards);
  return `
    <div class="frame__head"><h1 class="title">Gnomehall</h1><span class="heading">Round ${flow.state.round}</span></div>
    <section class="frame stack">
      <div class="frame__head"><h2 class="heading">${names[opp]}</h2><span class="label">Opponent</span></div>
      ${gnomeHTML(opp, gnomes[opp], names[opp])}
      <div class="stack">
        <span class="label">Spent cards</span>
        <div class="row">${spentCards || `<span class="muted">None yet.</span>`}</div>
      </div>
      ${history ? `<div class="stack"><span class="label">Earlier rounds</span><ul class="muted">${history}</ul></div>` : ""}
    </section>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${names[me]}: seal a plan</h2><span class="label">Three beats. Click a card to add it, a slot to clear from there.</span></div>
      ${gnomeHTML(me, gnomes[me], names[me])}
      ${slotsHTML()}
      <span class="label">Your hand</span>
      <div class="card-grid">${hand}</div>
      <div class="button-row">
        <button class="button" type="button" data-action="seal" ${isSealable(plan, legalPlans) ? "" : "disabled"}>Seal plan</button>
        <span class="number">${used} / 3 beats</span>
      </div>
    </section>`;
}

// slotsHTML lays the plan over three beat wells; a card spans as many wells as its cost.
function slotsHTML() {
  const labels = [1, 2, 3].map((b) => `<span class="label">Beat ${b}</span>`).join("");
  let beat = 0;
  const filled = plan.map((id) => {
    const c = engine.cards[id];
    const start = beat;
    beat += c.cost;
    return `<div class="slot" style="grid-column: span ${c.cost}">${cardHTML(c, { action: "clearFrom", data: `data-beat="${start}"` })}</div>`;
  });
  const empty = Array.from({ length: 3 - beat }, () => `<div class="slot"><div class="slot__well"><span class="label">empty</span></div></div>`);
  return `<div class="slots">${labels}${filled.join("")}${empty.join("")}</div>`;
}

function placeholder(name) {
  return () => `<h1 class="title">Gnomehall</h1><section class="frame"><p class="heading">${name}</p><p class="muted">${sideNames(flow.clans, flow.mode).join(" against ")}: ${planNames(flow.plans[0])} against ${planNames(flow.plans[1])}</p></section>`;
}

// gnomeHTML draws a side's sprite, HP bar and status chips from a gnome or vitals object.
function gnomeHTML(side, vitals, name) {
  const width = Math.max(0, Math.min(100, (vitals.hp / flow.hp) * 100));
  const chips = [
    ["block", "Block"],
    ["counter", "Counter"],
    ["vulnerable", "Vulnerable"],
    ["strength", "Strength"],
  ]
    .filter(([key]) => vitals[key] > 0)
    .map(([key, label]) => `<span class="chip chip--${key}">${label} ${vitals[key]}</span>`)
    .join("");
  return `
    <div class="gnome ${side === 1 ? "gnome--mirror" : ""}">
      <img class="sprite" id="sprite-${side}" src="sprites/gnome-${side === 0 ? "a" : "b"}.svg" alt="${name}">
      <div class="hp">
        <div class="hp__row"><span class="label">${name}</span><span class="number">${vitals.hp} / ${flow.hp}</span></div>
        <div class="hp__bar"><div class="hp__fill" style="width: ${width}%"></div></div>
        <div class="chips">${chips}</div>
      </div>
    </div>`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card.
function cardHTML(c, { selected = false, dimmed = false, small = false, action = null, data = "" } = {}) {
  const classes = ["card", c.rare ? "card--rare" : "", c.special ? "" : "card--basic", selected ? "card--selected" : "", dimmed ? "card--dimmed" : "", small ? "card--small" : ""].join(" ");
  const badges = [
    c.tier !== "Normal" ? `<span class="badge badge--${c.tier.toLowerCase()}">${c.tier}</span>` : "",
    c.rare ? `<span class="badge badge--rare">Rare</span>` : "",
  ].join("");
  const body = small
    ? `<span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span>`
    : `
    <div class="card__head"><span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span></div>
    <div class="card__foot">${badges}</div>
    <div class="card__text">${c.text}</div>`;
  if (action === null) return `<div class="${classes}">${body}</div>`;
  return `<button class="${classes}" type="button" data-action="${action}" data-id="${c.id}" ${data} ${dimmed ? "disabled" : ""}>${body}</button>`;
}

function planNames(ids) {
  return ids ? ids.map((id) => engine.cards[id].name).join(", ") : "";
}

function clanNamed(name) {
  return engine.clans.find((c) => c.name === name);
}

render();
