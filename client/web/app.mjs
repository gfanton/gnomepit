// The page: renders the flow's screens into #app and turns clicks into flow actions. Every
// rule comes from the engine; this module only draws and routes.

import { loadEngine } from "./engine.mjs";
import { initial, reduce, botTurn } from "./flow.mjs";
import { deckSize, newDeck, toggle, rareOf } from "./deck.mjs";
import { randomDeck, randomPlan } from "./bot.mjs";
import { addCard, beatsUsed, canAdd, clearFrom, isSealable, slots } from "./plan.mjs";
import { sentences, matchLog, resultLine, sideNames } from "./log.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
const app = document.getElementById("app");
const basics = engine.cards.filter((c) => !c.special).map((c) => c.id);
const stepMs = 700;
const hitFlashMs = 150;

let flow = initial;
let deck = null; // the deck being picked on the deck screen
let plan = []; // the plan being built on the plan screen
let legalPlans = []; // the acting player's legal plans this round
let playback = null; // {start, steps, lines, shown, timer, hit} for the round being played back

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
  if (before.screen === "playback") stopPlaying();
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
      hit: [false, false],
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
    plan = addCard(plan, Number(id), engine.cards, available());
    render();
  },
  clearFrom: ({ beat }) => {
    plan = clearFrom(plan, Number(beat), engine.cards);
    render();
  },
  seal: () => dispatch({ type: "planSealed", plan }),
  next: () => showStep(playback.shown + 1),
  play: () => (playback.timer ? stopPlaying() : startPlaying()),
  skip: () => showStep(playback.steps.length),
  playbackDone: () => dispatch({ type: "playbackDone" }),
  rematch: () => dispatch({ type: "rematch" }),
  newMatch: () => dispatch({ type: "newMatch" }),
  copyLog: () => copyMatchLog(),
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

// ---- Playback

function showStep(n) {
  const round = flow.rounds.at(-1);
  const target = Math.min(n, playback.steps.length);
  const hit = [false, false];
  if (target === playback.shown + 1) {
    const step = playback.steps[target - 1];
    for (const ev of round.events.slice(step.from, step.to)) {
      if (ev.kind === "HitLanded") hit[1 - ev.side] = true;
      if (ev.kind === "CounterHit") hit[ev.side] = true;
    }
  }
  playback.shown = target;
  playback.hit = hit;
  if (target === playback.steps.length) stopPlaying();
  patchPlayback();
  if (hit.some(Boolean)) {
    setTimeout(() => {
      playback.hit = [false, false];
      if (flow.screen === "playback") patchPlayback();
    }, hitFlashMs);
  }
}

function startPlaying() {
  if (playback.shown >= playback.steps.length) return;
  playback.timer = setInterval(() => showStep(playback.shown + 1), stepMs);
  showStep(playback.shown + 1);
}

function stopPlaying() {
  if (playback?.timer) clearInterval(playback.timer);
  if (playback) playback.timer = null;
  if (flow.screen === "playback") patchPlayback();
}

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
  // The playback screen renders once and is then patched, so its bars and marker animate.
  if (flow.screen === "playback" && app.dataset.screen === "playback") return;
  app.innerHTML = screens[flow.screen]();
  app.dataset.screen = flow.screen;
  if (flow.screen === "playback") patchPlayback();
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
  const full = deck.picks.length >= deckSize;
  const pool = clan.cards
    .map((id) => {
      const picked = deck.picks.includes(id);
      return cardHTML(engine.cards[id], { selected: picked, pressed: picked, locked: id === rare, dimmed: full && !picked, action: "toggle" });
    })
    .join("");
  return `
    <h1 class="title">Gnomehall</h1>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${heading}</h2><span class="hint">The Rare stays in. Pick 7 more.</span></div>
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
      ${history ? `<div class="stack"><span class="label">Earlier rounds</span><ul class="plain-list muted">${history}</ul></div>` : ""}
    </section>
    <section class="frame frame--acting stack">
      <div class="frame__head"><h2 class="heading">${names[me]}: seal a plan</h2><span class="hint">Click a card to add it to the next free beat, a beat to clear from there.</span></div>
      ${gnomeHTML(me, gnomes[me], names[me])}
      <div class="plan-band">
        ${slotsHTML()}
        <div class="button-row">
          <button class="button" type="button" data-action="seal" ${isSealable(plan, legalPlans) ? "" : "disabled"}>Seal plan</button>
          <span class="label">${used} / 3 beats</span>
        </div>
      </div>
      <span class="label">Your hand</span>
      <div class="card-grid">${hand}</div>
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
    return `<div class="slot" style="grid-column: span ${c.cost}">${cardHTML(c, { small: true, action: "clearFrom", data: `data-beat="${start}"` })}</div>`;
  });
  const empty = Array.from({ length: 3 - beat }, () => `<div class="slot"><div class="slot__well"><span class="label">empty</span></div></div>`);
  return `<div class="slots">${labels}${filled.join("")}${empty.join("")}</div>`;
}

function playbackScreen() {
  const round = flow.rounds.at(-1);
  const names = sideNames(flow.clans, flow.mode);
  const heads = [1, 2, 3].map((b) => `<span class="label timeline__beat" id="beat-${b}">Beat ${b}</span>`).join("");
  // Each side's row lays its plan over the three beats, a card spanning the beats it occupies.
  const rows = round.plans
    .map((p, side) => {
      let beat = 0;
      return p
        .map((id, index) => {
          const c = engine.cards[id];
          const from = beat + 1;
          beat += c.cost;
          const note = c.parry > 0 ? `guards ${from === beat ? `beat ${beat}` : `beats ${from} to ${beat}`}` : c.cost > 1 ? `lands on beat ${beat}` : "";
          return `
            <div class="timeline__play" style="grid-column: span ${c.cost}">
              ${cardHTML(c, { small: true, data: `data-side="${side}" data-index="${index}"` })}
              <span class="label">${names[side]}${note ? ` · ${note}` : ""}</span>
            </div>`;
        })
        .join("");
    })
    .join("");
  return `
    <div class="frame__head"><h1 class="title">Gnomehall</h1><span class="heading">Round ${round.state.round - 1}</span></div>
    <section class="frame stack">
      <div class="split">${gnomeHTML(0, playback.start[0], names[0])}${gnomeHTML(1, playback.start[1], names[1])}</div>
      <div class="timeline">${heads}${rows}</div>
      <div class="button-row">
        <button class="button" type="button" data-action="next" id="next">Next step</button>
        <button class="button button--secondary" type="button" data-action="play" id="play">Play</button>
        <button class="button button--secondary" type="button" data-action="skip" id="skip">Skip</button>
        <span class="label" id="progress"></span>
      </div>
      <div class="log log--grid" id="log"></div>
      <div id="finish" class="stack"></div>
    </section>`;
}

// patchPlayback updates the parts of the playback screen that change with each step.
function patchPlayback() {
  const round = flow.rounds.at(-1);
  const { steps, shown, lines } = playback;
  const vitalsAt = (n) => (n === 0 ? playback.start : round.events[steps[n - 1].to - 1].after);
  const vitals = vitalsAt(shown);
  const previous = vitalsAt(Math.max(0, shown - 1));
  const current = shown > 0 ? steps[shown - 1] : null;
  for (const side of [0, 1]) {
    byId(`hp-fill-${side}`).style.width = hpWidth(vitals[side].hp);
    byId(`hp-ghost-${side}`).style.width = hpWidth(previous[side].hp);
    byId(`hp-num-${side}`).textContent = `${vitals[side].hp} / ${flow.hp}`;
    byId(`chips-${side}`).innerHTML = chipsHTML(vitals[side]);
    byId(`sprite-${side}`).classList.toggle("sprite--hit", playback.hit[side]);
  }
  // The acting cards are the ones occupying the current beat for the sides that acted this step.
  const laid = round.plans.map((p) => slots(p, engine.cards));
  const acting = new Set(current ? round.events.slice(current.from, current.to).map((ev) => `${ev.side}:${laid[ev.side][current.beat - 1].index}`) : []);
  for (const b of [1, 2, 3]) byId(`beat-${b}`).classList.toggle("timeline__beat--current", current?.beat === b);
  for (const el of app.querySelectorAll("[data-side][data-index]")) {
    el.classList.toggle("card--acting", acting.has(`${el.dataset.side}:${el.dataset.index}`));
  }
  byId("log").innerHTML = logHTML(round, steps, shown, lines);
  const done = shown >= steps.length;
  byId("next").disabled = done;
  byId("skip").disabled = done;
  byId("play").disabled = done;
  byId("play").textContent = playback.timer ? "Pause" : "Play";
  byId("progress").textContent = `${shown} / ${steps.length} steps`;
  byId("finish").innerHTML = done ? finishHTML() : "";
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
    <h1 class="title">Gnomehall</h1>
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
function gnomeHTML(side, vitals, name) {
  return `
    <div class="gnome ${side === 1 ? "gnome--mirror" : ""}">
      <img class="sprite" id="sprite-${side}" src="sprites/gnome-${side === 0 ? "a" : "b"}.svg" alt="${name}">
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
    .map(([key, label]) => `<span class="chip chip--${key}">${label} ${vitals[key]}</span>`)
    .join("");
}

function hpWidth(hp) {
  return `${Math.max(0, Math.min(100, (hp / flow.hp) * 100))}%`;
}

// cardHTML draws a playing card; with an action it is a button, otherwise a plain card. A
// pressed value marks a toggle's state; locked marks a toggle that does nothing.
function cardHTML(c, { selected = false, dimmed = false, small = false, locked = false, pressed = null, action = null, data = "" } = {}) {
  const classes = ["card", c.rare ? "card--rare" : "", c.special ? "" : "card--basic", selected ? "card--selected" : "", dimmed ? "card--dimmed" : "", small ? "card--small" : "", locked ? "card--locked" : ""].join(" ");
  const state = [pressed === null ? "" : `aria-pressed="${pressed}"`, locked ? `aria-disabled="true" title="The Rare stays in"` : ""].join(" ");
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
  if (action === null) return `<div class="${classes}" ${data}>${body}</div>`;
  return `<button class="${classes}" type="button" data-action="${action}" data-id="${c.id}" ${state} ${data} ${dimmed ? "disabled" : ""}>${body}</button>`;
}

function planNames(ids) {
  return ids ? ids.map((id) => engine.cards[id].name).join(", ") : "";
}

function clanNamed(name) {
  return engine.clans.find((c) => c.name === name);
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHTML(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

render();
