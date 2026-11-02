import test from "node:test";
import assert from "node:assert/strict";
import type { BattleEvent, Side } from "./engine.ts";
import type { Round } from "./flow.ts";
import { event, id } from "./fixture.ts";
import { verdict } from "./result.ts";

const gnome = (hp: number) => ({ hp, vulnerable: 0, strength: 0, spent: [] });
const round = (n: number, hp: [number, number], events: BattleEvent[] = []): Round => ({
  plans: [[], []],
  events,
  state: { round: n + 1, gnomes: [gnome(hp[0]), gnome(hp[1])] },
});
const vitals = (hp: number) => ({ hp, block: 0, counter: 0, vulnerable: 0, strength: 0 });
const hit = (side: Side, card: string, n: number, after: [number, number]) =>
  event({ kind: "HitLanded", side, card: id(card), n, after: [vitals(after[0]), vitals(after[1])] });

test("a win on health is the player's, with the winner's score first", () => {
  const v = verdict([round(1, [15, 15]), round(2, [12, 10]), round(3, [9, 4])], "a", ["You", "Ironhide"]);
  assert.equal(v.winner, 0);
  assert.equal(v.title, "You won");
  assert.equal(v.detail, "On health after three rounds, 9 to 4.");
});

test("a loss reads from the player's side", () => {
  const v = verdict([round(1, [12, 15]), round(2, [8, 13]), round(3, [4, 9])], "b", ["You", "Bot"]);
  assert.equal(v.winner, 1);
  assert.equal(v.title, "You lost");
  assert.equal(v.detail, "On health after three rounds, 9 to 4.");
});

test("two players at one screen see the winner's name", () => {
  const v = verdict([round(1, [12, 15]), round(2, [8, 13]), round(3, [4, 9])], "b", ["Pickers", "Ironhide"]);
  assert.equal(v.title, "Ironhide won");
});

test("a knockout names the round it ended in", () => {
  const v = verdict([round(1, [9, 12]), round(2, [0, 6])], "b", ["You", "Ironhide"]);
  assert.equal(v.title, "You lost");
  assert.equal(v.detail, "Knockout in round 2.");
});

test("a draw has no winner and no deciding blow", () => {
  const level = verdict([round(1, [12, 12]), round(2, [8, 8]), round(3, [5, 5])], "draw", ["You", "Bot"]);
  assert.deepEqual(level, {
    winner: null,
    title: "A draw",
    detail: "Level on health after three rounds, 5 each.",
    blow: null,
  });
  const fallen = verdict([round(1, [6, 7]), round(2, [0, 0])], "draw", ["You", "Bot"]);
  assert.equal(fallen.detail, "Both gnomes fell in round 2.");
});

test("a knockout is decided by the hit that brought the loser down", () => {
  const v = verdict(
    [
      round(1, [15, 9], [hit(0, "Hammer Blow", 6, [15, 9])]),
      round(2, [15, 0], [hit(0, "Pick", 1, [15, 8]), hit(0, "Cobble Throw", 2, [15, 6]), hit(0, "Feint", 6, [15, 0])]),
    ],
    "a",
    ["You", "Pickers"],
  );
  assert.deepEqual(v.blow, { card: id("Feint"), damage: 6, round: 2, finishing: true });
});

test("a win on health is decided by the winner's hardest hit, the later of a tie", () => {
  const v = verdict(
    [
      round(1, [15, 11], [hit(0, "Cobble Throw", 2, [15, 13]), hit(1, "Hammer Blow", 5, [10, 13])]),
      round(2, [10, 9], [hit(0, "Feint", 2, [10, 11])]),
      round(3, [10, 7], [hit(0, "Pick", 1, [10, 8])]),
    ],
    "a",
    ["You", "Ironhide"],
  );
  assert.deepEqual(v.blow, { card: id("Feint"), damage: 2, round: 2, finishing: false });
});

test("a winner who dealt no damage has no deciding blow", () => {
  const v = verdict([round(1, [15, 15], [hit(0, "Pick", 0, [15, 15])]), round(2, [15, 14]), round(3, [15, 14])], "a", [
    "You",
    "Bot",
  ]);
  assert.equal(v.blow, null);
});

test("an unfinished match has no verdict", () => {
  assert.throws(() => verdict([round(1, [15, 15])], "ongoing", ["You", "Bot"]), /not ended/);
  assert.throws(() => verdict([], "a", ["You", "Bot"]), /not ended/);
});
