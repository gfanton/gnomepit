import { loadEngine } from "./engine.mjs";

const engine = await loadEngine("engine.wasm", "cards.json");
document.getElementById("smoke").textContent =
  `HP ${engine.hp}\n` + engine.cards.map((c) => `${c.id} ${c.name} (${c.cost}) ${c.text}`).join("\n");
