import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Gnome, ResolveRequest, Resolution } from "./engine.ts";
import { event } from "./fixture.ts";
import { address, matchId } from "./ids.ts";
import { type ArenaView, viewOf, timeLeft, cardIds, replayView, matchBarText, sendingText } from "./online-model.ts";
const account = address("g1player");
const other = address("g1other");
const gnome = (hp: number): Gnome => ({ hp, vulnerable: 0, strength: 0, spent: [] });
test("reserved and expired challenges cannot be accepted by another account", () => {
  const friend = address("g1friend");
  assert.equal(
    viewOf({ ID: matchId("1"), Phase: "open", Opponent: friend, Expires: 200 }, account, 100).action,
    "wait",
  );
  assert.equal(
    viewOf({ ID: matchId("1"), Phase: "open", Opponent: account, Expires: 200 }, account, 100).action,
    "accept",
  );
  assert.equal(viewOf({ ID: matchId("1"), Phase: "open", Expires: 99 }, account, 100).phase, "expired");
});
test("uses arena move/finish distinction and exposes forfeits only to the other player", () => {
  const v: ArenaView = { Phase: "reveal", Challenger: account, Acceptor: other, ToMove: account, Deadline: 200 };
  assert.equal(viewOf({ ...v, action: "finish" }, account, 100).action, "finish");
  assert.equal(viewOf(v, account, 100).action, "wait");
  assert.equal(viewOf(v, account, 201).action, "wait");
  assert.equal(viewOf({ ...v, action: "move" }, account, 201).action, "wait");
  assert.equal(viewOf(v, other, 201).action, "claimForfeit");
});
test("deck and plan names reject unknown cards instead of mapping to a wrong id", () => {
  assert.deepEqual(
    cardIds("Pick,Brace", [
      { id: 0, name: "Pick" },
      { id: 1, name: "Brace" },
    ]),
    [0, 1],
  );
  assert.throws(() => cardIds("Pick,Unknown", [{ id: 0, name: "Pick" }]), /card file/);
});
test("replay verifies every round against chain HP and never resolves a sealed plan", () => {
  let calls = 0;
  const engine = {
    hp: 20,
    cards: [{ id: 0, name: "Pick" }],
    resolve: ({ state }: ResolveRequest): Resolution => {
      calls++;
      return { state: { round: state.round + 1, gnomes: [gnome(18), gnome(17)] }, result: "ongoing", events: [] };
    },
  };
  const view: ArenaView = {
    Challenger: account,
    Acceptor: other,
    ChallengerDeck: "Pick",
    AcceptorDeck: "Pick",
    Plans: [
      ["Pick", "Pick"],
      ["", "Pick"],
    ],
    HP: [[18, 17]],
  };
  assert.equal(replayView(view, engine, account).rounds.length, 1);
  assert.equal(calls, 1);
  assert.throws(() => replayView({ ...view, HP: [[19, 17]] }, engine, account), /card file/);
  assert.throws(() => replayView({ ...view, HP: [] }, engine, account), /card file/);
});
test("the challenger replays their pending clash last, with the deck the arena opened", () => {
  const engine = {
    hp: 20,
    cards: [
      { id: 0, name: "Pick" },
      { id: 1, name: "Brace" },
    ],
    resolve: () => {
      throw new Error("the arena resolved the pending clash already");
    },
  };
  const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: 20, vulnerable: 0, strength: 0, spent: [] })) };
  const after: GameState = { round: 2, gnomes: [gnome(18), gnome(17)] };
  const clash = [event({ kind: "clash" })];
  const view: ArenaView = {
    Phase: "reveal",
    Round: 1,
    Challenger: account,
    Acceptor: other,
    ToMove: account,
    ChallengerDeck: "",
    AcceptorDeck: "Brace",
    Plans: [["", "Brace"]],
    HP: [],
    pending: { round: 1, plans: [[0], [1]], events: clash, state: after, result: "ongoing" },
    planning: { state: after, side: 0, deck: [0] },
  };
  const r = replayView(view, engine, account);
  assert.deepEqual(r.decks, [[0], [1]]);
  assert.deepEqual(r.rounds, [{ plans: [[0], [1]], events: clash, state: after, start }]);
  assert.deepEqual(r.state, after);
  assert.equal(r.result, "ongoing");
});
test("the match bar gives the deadline only for a move", () => {
  assert.equal(matchBarText("accept", 200), "Accepting a challenge · Round 1");
  assert.equal(matchBarText("challenge", 200), "Posting a challenge · Round 1");
  assert.equal(matchBarText("move", 200), `Your move deadline: ${new Date(200_000).toLocaleString()}`);
  assert.equal(matchBarText("move", 0), "Your move");
});
// Posting or accepting always asks Adena: for the match's session, or to sign the plan.
test("while a plan is sent, the match bar names the wallet's part in posting or accepting", () => {
  assert.equal(sendingText("challenge"), "Approve the request in Adena, then wait for the chain to confirm.");
  assert.equal(sendingText("accept"), "Approve the request in Adena, then wait for the chain to confirm.");
  assert.equal(sendingText("move"), "Sending your move… Waiting for confirmation.");
});
test("deadline labels never round a still-active deadline to expired", () => {
  assert.equal(timeLeft(100, 99), "0h 1m left");
  assert.equal(timeLeft(100, 100), "Deadline passed");
});
