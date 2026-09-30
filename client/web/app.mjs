import { loadEngine } from "./engine.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
const kneecap = engine.cards.find((c) => c.name === "Kneecap");
const undermine = engine.cards.find((c) => c.name === "Undermine");

const card = (c, extra = "") => `
  <button class="card ${c.rare ? "card--rare" : ""} ${extra}" type="button">
    <div class="card__head"><span class="card__cost">${c.cost}</span><span class="card__name">${c.name}</span></div>
    <div class="card__foot">${c.tier !== "Normal" ? `<span class="badge badge--${c.tier.toLowerCase()}">${c.tier}</span>` : ""}${c.rare ? `<span class="badge badge--rare">Rare</span>` : ""}</div>
    <div class="card__text">${c.text}</div>
  </button>`;

document.getElementById("app").innerHTML = `
  <h1 class="title">Gnomehall</h1>
  <section class="frame">
    <div class="frame__head"><h2 class="heading">Smoke</h2><span class="label">HP ${engine.hp}</span></div>
    <div class="card-grid">${card(kneecap)}${card(undermine)}${card(engine.cards[0], "card--basic")}</div>
  </section>
  <section class="frame split">
    <div class="gnome"><img class="sprite" src="sprites/gnome-a.svg" alt="Pickers gnome"><div class="hp"><div class="hp__row"><span class="label">Pickers</span><span class="number">11 / 15</span></div><div class="hp__bar"><div class="hp__fill" style="width: 73%"></div></div><div class="chips"><span class="chip chip--block">Block 5</span><span class="chip chip--vulnerable">Vulnerable 1</span></div></div></div>
    <div class="gnome gnome--mirror"><img class="sprite" src="sprites/gnome-b.svg" alt="Ironhide gnome"><div class="hp"><div class="hp__row"><span class="label">Ironhide</span><span class="number">15 / 15</span></div><div class="hp__bar"><div class="hp__fill" style="width: 100%"></div></div><div class="chips"><span class="chip chip--counter">Counter 1</span><span class="chip chip--strength">Strength 1</span></div></div></div>
  </section>
  <div class="button-row"><button class="button" type="button">Two players</button><button class="button button--secondary" type="button">Versus bot</button><button class="button" type="button" disabled>Ready 3 / 7</button></div>
  <pre id="smoke" class="muted">${engine.cards.length} cards loaded</pre>`;
