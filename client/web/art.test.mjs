import test from "node:test";
import assert from "node:assert/strict";

import { existsSync, readFileSync } from "node:fs";

import { artIndex } from "./art.mjs";

const readJSON = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));

const manifest = {
  generation_tool: "built-in image_gen",
  assets: [
    { name: "Bulwark", clan: "Ironhide", kind: "card", master: "bulwark-v2.png", display: "bulwark-v2.jpg", prompts: "variance-prompts.json" },
    { name: "Ironhide portrait", clan: "Ironhide", kind: "portrait", master: "ironhide-portrait-v2.png", display: "ironhide-portrait-v2.jpg", prompts: "p.json" },
    { name: "Gnomehall hero", clan: "Both", kind: "hero", master: "hall-hero-v2.png", display: "hall-hero-v2.jpg", prompts: "p.json" },
  ],
};

test("a card's illustration is its display export, found by card name", () => {
  const art = artIndex(manifest);
  assert.equal(art.card("Bulwark"), "bulwark-v2.jpg");
  assert.equal(art.card("Ironhide portrait"), undefined);
  assert.equal(art.card("Renamed Card"), undefined);
});

test("a clan's portrait is found by clan, and other art is not a portrait", () => {
  const art = artIndex(manifest);
  assert.equal(art.portrait("Ironhide"), "ironhide-portrait-v2.jpg");
  assert.equal(art.portrait("Both"), undefined);
  assert.equal(art.portrait("Shared"), undefined);
});

test("every clan the page deals has a portrait on disk", () => {
  const art = artIndex(readJSON("./art/assets.json"));
  for (const clan of Object.keys(readJSON("./cards.json").Clans)) {
    const file = art.portrait(clan);
    assert.ok(file, `${clan} has no portrait in art/assets.json`);
    assert.ok(existsSync(new URL(`./art/${file}`, import.meta.url)), `${clan}'s portrait art/${file} is missing`);
  }
});
