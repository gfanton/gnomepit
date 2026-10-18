import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { nodeEngine } from "./engine-node.ts";

const engine = await nodeEngine();
const preview = JSON.parse(readFileSync(new URL("./art/delvers-cards-v2.json", import.meta.url))).cards;

test("the Delvers preview shows each Delvers card as the engine deals it", () => {
  const delvers = engine.clans.find((c) => c.name === "Delvers").cards.map((id) => engine.cards[id]);
  assert.deepEqual(
    preview.map((c) => ({ name: c.name, cost: c.cost, tier: c.tier, rare: c.rarity === "Rare", text: c.text })),
    delvers.map((c) => ({ name: c.name, cost: c.cost, tier: c.tier, rare: c.rare, text: c.text })),
  );
});
