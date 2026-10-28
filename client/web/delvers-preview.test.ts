import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import * as v from "valibot";

import { cardOf } from "./engine.ts";
import { nodeEngine } from "./engine-node.ts";
import { known } from "./fixture.ts";
import { wordmarkHTML } from "./wordmark.ts";

const PreviewSchema = v.object({
  cards: v.array(
    v.object({ name: v.string(), cost: v.number(), tier: v.string(), rarity: v.string(), text: v.string() }),
  ),
});

const engine = await nodeEngine();
const preview = v.parse(
  PreviewSchema,
  JSON.parse(readFileSync(new URL("./art/delvers-cards-v2.json", import.meta.url), "utf8")),
).cards;

test("the Delvers preview shows each Delvers card as the engine deals it", () => {
  const delvers = known(engine.clans.find((c) => c.name === "Delvers")).cards.map((id) => cardOf(engine.cards, id));
  assert.deepEqual(
    preview.map((c) => ({ name: c.name, cost: c.cost, tier: c.tier, rare: c.rarity === "Rare", text: c.text })),
    delvers.map((c) => ({ name: c.name, cost: c.cost, tier: c.tier, rare: c.rare, text: c.text })),
  );
});

test("the Delvers preview's masthead is the shared wordmark", () => {
  const page = readFileSync(new URL("./delvers-preview.html", import.meta.url), "utf8");
  assert.ok(page.includes(wordmarkHTML("index.html")), "delvers-preview.html does not carry wordmarkHTML's markup");
});
