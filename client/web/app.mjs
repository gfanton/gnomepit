// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import { loadEngine } from "./engine.mjs";
import { initial, reduce, botTurn } from "./flow.mjs";
import { newDeck, toggle, rareOf } from "./deck.mjs";
import { randomDeck, randomPlan } from "./bot.mjs";
import { sideNames } from "./log.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
const app = document.getElementById("app");

let flow = initial;
let deck = null; // the deck being picked on the deck screen

// ---- Actions

function dispatch(action) {
  const before = flow;
  flow = reduce(flow, action);
  enter(before);
  render();
}

// enter runs what a screen needs on arrival: a fresh deck to pick, or the bot's move.
function enter(before) {
  const arrived = flow.screen !== before.screen || flow.acting !== before.acting;
  if (flow.screen === "deck" && arrived) {
    if (botTurn(flow)) {
      const clan = engine.clans[Math.floor(Math.random() * engine.clans.length)];
      dispatch({ type: "deckReady", clan: clan.name, deck: randomDeck(clan, engine.cards, Math.random) });
      return;
    }
    deck = newDeck(engine.clans[0], engine.cards);
  }
  if (flow.screen === "plan" && botTurn(flow)) {
    const plans = engine.legalPlans({ state: flow.state, side: 1, deck: flow.decks[1] });
    dispatch({ type: "planSealed", plan: randomPlan(plans, Math.random) });
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
};

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handlers[target.dataset.action]?.(target.dataset);
});

// ---- Rendering

function render() {
  const screens = { title, deck: deckScreen, handoff, plan: placeholder("Plan"), playback: placeholder("Playback"), result: placeholder("Result") };
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

function placeholder(name) {
  return () => `<h1 class="title">Gnomehall</h1><section class="frame"><p class="heading">${name}</p><p class="muted">${sideNames(flow.clans, flow.mode).join(" against ")}</p></section>`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card.
function cardHTML(c, { selected = false, dimmed = false, action = null, data = "" } = {}) {
  const classes = ["card", c.rare ? "card--rare" : "", c.special ? "" : "card--basic", selected ? "card--selected" : "", dimmed ? "card--dimmed" : ""].join(" ");
  const badges = [
    c.tier !== "Normal" ? `<span class="badge badge--${c.tier.toLowerCase()}">${c.tier}</span>` : "",
    c.rare ? `<span class="badge badge--rare">Rare</span>` : "",
  ].join("");
  const body = `
    <div class="card__head"><span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span></div>
    <div class="card__foot">${badges}</div>
    <div class="card__text">${c.text}</div>`;
  if (action === null) return `<div class="${classes}">${body}</div>`;
  return `<button class="${classes}" type="button" data-action="${action}" data-id="${c.id}" ${data} ${dimmed ? "disabled" : ""}>${body}</button>`;
}

function clanNamed(name) {
  return engine.clans.find((c) => c.name === name);
}

render();
