import test from "node:test";
import assert from "node:assert/strict";

import { startState } from "./engine.ts";

test("a match starts in round 1 with both gnomes at full health, nothing spent and no status", () => {
  const gnome = { hp: 15, vulnerable: 0, strength: 0, spent: [] };
  assert.deepEqual(startState(15), { round: 1, gnomes: [gnome, gnome] });
});
