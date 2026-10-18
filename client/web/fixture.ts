// Test fixture mirroring client/web/cards.json: the card view and the three clans, with a
// battle event builder and a guard for the values a test counts on.

import assert from "node:assert/strict";

import type { BattleEvent, Card, Clan, Vitals } from "./engine.ts";

const def = (id: number, name: string, cost: number, tier: Card["tier"], extra: Partial<Card> = {}): Card => ({
  id,
  name,
  cost,
  tier,
  special: id > 1,
  rare: false,
  interrupt: false,
  parry: 0,
  text: "",
  ...extra,
});

export const cards = [
  def(0, "Pick", 1, "Normal"),
  def(1, "Brace", 1, "Normal"),
  def(2, "Pickaxe Flurry", 1, "Quick"),
  def(3, "Kneecap", 1, "Quick", { interrupt: true }),
  def(4, "Sling Stone", 1, "Normal"),
  def(5, "Dodge Roll", 2, "Normal", { parry: 1 }),
  def(6, "Chalk Dust", 1, "Quick"),
  def(7, "Double Tap", 2, "Normal"),
  def(8, "Momentum", 1, "Normal"),
  def(9, "Undermine", 1, "Quick", { rare: true, interrupt: true }),
  def(10, "Hunker Down", 3, "Normal", { parry: 2 }),
  def(11, "Boot and Heel", 2, "Slow"),
  def(12, "Stone Guard", 3, "Normal", { parry: 2 }),
  def(13, "Bulwark", 2, "Normal"),
  def(14, "Hammer Blow", 2, "Slow"),
  def(15, "Cobble Throw", 1, "Slow"),
  def(16, "Spiked Shield", 1, "Normal"),
  def(17, "Anvil Stomp", 2, "Slow"),
  def(18, "Feint", 2, "Normal"),
  def(19, "Avalanche", 1, "Slow", { rare: true }),
  def(20, "Shield Catch", 2, "Normal"),
  def(21, "Loose Timbers", 2, "Normal"),
  def(22, "Kickback", 1, "Slow", { rare: true }),
  def(23, "Overdig", 2, "Normal"),
  def(24, "Ambush", 1, "Normal"),
  def(25, "Open Guard", 1, "Normal"),
  def(26, "Chisel Jab", 1, "Normal"),
  def(27, "Rockfall", 2, "Slow"),
  def(28, "Cribbing", 1, "Normal"),
  def(29, "Deadfall", 2, "Normal", { parry: 1 }),
  def(30, "Blowback", 2, "Normal"),
  def(31, "Cave-In", 3, "Slow"),
];

export const pickers: Clan = { name: "Pickers", cards: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const ironhide: Clan = { name: "Ironhide", cards: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21] };
export const delvers: Clan = { name: "Delvers", cards: [22, 23, 24, 25, 26, 27, 28, 29, 30, 31] };

export const id = (name: string): number => {
  const card = cards.find((c) => c.name === name);
  assert.ok(card !== undefined, `no card named ${name}`);
  return card.id;
};

// known is the value a test counts on; a missing one fails the test.
export function known<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "a value the test counts on is missing");
  return value;
}

const untouched: Vitals = { hp: 15, block: 0, counter: 0, vulnerable: 0, strength: 0 };

// event is a battle event with the fields a test names. The others are side 0's Pick on
// beat 1, dealing nothing to gnomes at full health.
export function event(fields: Pick<BattleEvent, "kind"> & Partial<BattleEvent>): BattleEvent {
  return {
    beat: 1,
    phase: "Damage",
    tier: "Normal",
    step: 1,
    side: 0,
    card: 0,
    n: 0,
    blocked: 0,
    doubled: false,
    after: [untouched, untouched],
    ...fields,
  };
}
