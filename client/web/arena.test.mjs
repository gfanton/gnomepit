import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  ArenaError, actionFor, cardIDs, cardNames, checkOpening, checkPlan, createArena, errorFrom, moveCall, pendingClash, planFrom, replay,
  walletFailure,
} from "./arena.mjs";
import { ChainError } from "./chain.mjs";
import { devAccounts, devWallet } from "./devwallet.mjs";
import { nodeEngine } from "./engine-node.mjs";
import { WalletError, deriveKeys } from "./wallet.mjs";

const engine = await nodeEngine();
const alice = "g1alice";
const bob = "g1bob";
const carol = "g1carol";
const deckA = "Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine";
const deckB = "Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche";
const picks = "Pick,Pick,Pick";
const braces = "Brace,Brace,Brace";

// view builds a decoded MatchView, as gnovalue gives it.
const view = (fields) => ({
  ID: "1", Phase: "open", Round: 1, Challenger: alice, Acceptor: "", ChallengerClan: "Pickers", AcceptorClan: "",
  ToMove: "", Deadline: 2_000_000_000, Result: "", Reason: "", Opponent: "", ChallengerDeck: "", AcceptorDeck: "",
  Plans: [], Box: "", HP: [], DeadlinePassed: false, ...fields,
});
const accepted = { Acceptor: bob, AcceptorClan: "Ironhide", AcceptorDeck: deckB };
const now = 1_900_000_000;

test("card names and ids convert both ways through the engine's cards", () => {
  const ids = cardIDs(deckA, engine.cards);
  assert.equal(ids.length, 8);
  assert.equal(cardNames(ids, engine.cards), deckA);
  assert.throws(() => cardIDs("Pick,Bulwerk", engine.cards), (err) => err.type === "outOfStep");
});

test("an open challenge: the challenger waits, others accept unless it names someone", () => {
  assert.equal(actionFor(view({}), alice, now), "wait");
  assert.equal(actionFor(view({}), bob, now), "accept");
  assert.equal(actionFor(view({ Opponent: bob }), bob, now), "accept");
  assert.equal(actionFor(view({ Opponent: bob }), carol, now), "done");
  assert.equal(actionFor(view({ Phase: "expired" }), bob, now), "done");
});

test("a running match: the player to move moves, the other waits", () => {
  const reveal = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  assert.equal(actionFor(reveal, alice, now), "move");
  assert.equal(actionFor(reveal, bob, now), "wait");
  assert.equal(actionFor(reveal, carol, now), "done");
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  assert.equal(actionFor(play, bob, now), "move");
  assert.equal(actionFor(play, alice, now), "wait");
});

test("the challenger finishes when no decision is left", () => {
  const last = view({ ...accepted, Phase: "reveal", Round: 3, ToMove: alice });
  assert.equal(actionFor(last, alice, now), "finish");
  const early = view({ ...accepted, Phase: "reveal", Round: 2, ToMove: alice });
  assert.equal(actionFor(early, alice, now, { result: "b" }), "finish");
  assert.equal(actionFor(early, alice, now, { result: "ongoing" }), "move");
});

test("after a missed deadline the waiting player claims the forfeit", () => {
  const late = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob, DeadlinePassed: true });
  assert.equal(actionFor(late, alice, now), "claimForfeit");
  assert.equal(actionFor(late, bob, now), "done");
  const summary = { ...late, DeadlinePassed: undefined, Deadline: now - 1 };
  assert.equal(actionFor(summary, alice, now), "claimForfeit");
  assert.equal(actionFor(view({ Phase: "ended", Result: "a", Reason: "forfeit" }), alice, now), "done");
});

test("replay plays every resolved round with the page's engine", () => {
  const round1 = engine.resolve({
    state: { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) },
    decks: [cardIDs(deckA, engine.cards), cardIDs(deckB, engine.cards)],
    a: cardIDs("Chalk Dust,Double Tap", engine.cards),
    b: cardIDs("Hammer Blow,Spiked Shield", engine.cards),
  });
  const hp = round1.state.gnomes.map((g) => g.hp);
  const played = view({ ...accepted, Phase: "play", Round: 2, ChallengerDeck: deckA, Plans: [["Chalk Dust,Double Tap", "Hammer Blow,Spiked Shield"], ["", ""]], HP: [hp] });

  const { rounds, state } = replay(played, engine);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].events, round1.events);
  assert.equal(state.round, 2);

  const wrong = { ...played, HP: [[hp[0] + 1, hp[1]]] };
  assert.throws(() => replay(wrong, engine), (err) => err instanceof ArenaError && err.type === "outOfStep");
});

test("the pending clash resolves the challenger's sealed plan against the acceptor's", () => {
  const reveal = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  const opened = { deck: deckA, deckSalt: "d", plan: picks, planSalt: "p" };
  const pending = pendingClash(reveal, opened, replay(reveal, engine).state, engine);
  assert.equal(pending.round, 1);
  assert.deepEqual(pending.plans, [cardIDs(picks, engine.cards), cardIDs(braces, engine.cards)]);
  assert.equal(pending.result, "ongoing");
  assert.equal(pending.state.round, 2);
});

test("the player to move plans from their side, deck and the state their round starts in", () => {
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  const state = { round: 2, gnomes: [] };
  assert.deepEqual(planFrom(play, state, undefined, "", engine.cards), { state, side: 1, deck: cardIDs(deckB, engine.cards) });

  const reveal = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  const pending = { state: { round: 2, gnomes: [] } };
  assert.deepEqual(planFrom(reveal, state, pending, deckA, engine.cards), { state: pending.state, side: 0, deck: cardIDs(deckA, engine.cards) });
  // A device that has not authorized cannot open the box, so it has nothing to plan from.
  assert.equal(planFrom(reveal, state, undefined, "", engine.cards), undefined);
});

const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) };
const illegal = (err) => err instanceof ArenaError && err.type === "illegalPlan";

test("a plan the engine refuses is never sealed or sent", () => {
  const planning = { state: start, side: 0, deck: cardIDs(deckA, engine.cards) };
  assert.doesNotThrow(() => checkPlan(engine, planning, cardIDs(picks, engine.cards)));
  assert.throws(() => checkPlan(engine, planning, cardIDs("Stone Guard", engine.cards)), illegal);
  assert.throws(() => checkPlan(engine, planning, cardIDs("Pick,Pick", engine.cards)), illegal);
});

test("a challenge or acceptance with a deck or plan the engine refuses is never sent", () => {
  const deck = cardIDs(deckA, engine.cards);
  assert.doesNotThrow(() => checkOpening(engine, "Pickers", deck, cardIDs(picks, engine.cards), 0));
  const foreign = [...deck.slice(1), cardIDs("Stone Guard", engine.cards)[0]];
  assert.throws(() => checkOpening(engine, "Pickers", foreign, cardIDs(picks, engine.cards), 0), illegal);
  assert.throws(() => checkOpening(engine, "Pickers", deck, cardIDs("Bulwark,Pick", engine.cards), 0), illegal);
  assert.throws(() => checkOpening(engine, "Ironhide", cardIDs(deckB, engine.cards), cardIDs("Kneecap,Pick,Pick", engine.cards), 1), illegal);
});

test("a move the wallet sent but the chain refused keeps the chain's reason", () => {
  const failed = (message) => walletFailure({ status: "failure", type: "TRANSACTION_FAILED", message });
  assert.equal(failed("wrong phase").type, "wrongPhase");
  assert.equal(failed("deadline not passed").type, "failed");
  assert.equal(failed("deadline not passed").reason, "deadline not passed");
  assert.equal(walletFailure({ status: "failure", type: "TRANSACTION_REJECTED", message: "User rejected" }).type, "refused");
  assert.equal(walletFailure(undefined).type, "refused");
});

test("the challenger's move reveals, with the deck on round 1 only, and seals the next plan", () => {
  const opened = { deck: deckA, deckSalt: "ds", plan: picks, planSalt: "ps" };
  const next = { plan: braces, seal: "nextseal", box: "nextbox" };
  const round1 = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  assert.deepEqual(moveCall(round1, opened, next), { func: "Reveal", args: ["1", deckA, "ds", picks, "ps", "nextseal", "nextbox"] });

  const round2 = view({ ...accepted, Phase: "reveal", Round: 2, ToMove: alice, ChallengerDeck: deckA });
  assert.deepEqual(moveCall(round2, { plan: picks, planSalt: "ps" }, next), { func: "Reveal", args: ["1", "", "", picks, "ps", "nextseal", "nextbox"] });
  assert.deepEqual(moveCall(round2, { plan: picks, planSalt: "ps" }, null), { func: "Reveal", args: ["1", "", "", picks, "ps", "", ""] });
});

test("the acceptor's move plays face up", () => {
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  assert.deepEqual(moveCall(play, null, { plan: picks }), { func: "Play", args: ["1", picks] });
});

function memory() {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
}

test("notify opts the wallet's address in to the arena's two triggers", async () => {
  const sent = [];
  const notifier = {
    enable: async () => ({}),
    triggers: async (target) => {
      assert.equal(target, "gno.land/r/gfanton/gnomehall/arena");
      return [{ id: "0000001", event: "Turn" }, { id: "0000002", event: "Ended" }, { id: "0000003", event: "Other" }];
    },
    setOptins: async (optins) => sent.push(optins),
  };
  const wallet = devWallet({ name: "alice", signer: engine, chain: null, chainId: "dev" });
  const arena = createArena({ chain: null, wallet, engine, realm: "gno.land/r/gfanton/gnomehall/arena", chainId: "dev", origin: "http://x", storage: memory(), notifier });
  await arena.connect();
  assert.equal(await arena.notify(), 2);
  assert.deepEqual(sent, [[{ trigger: "0000001", value: devAccounts.alice.address }, { trigger: "0000002", value: devAccounts.alice.address }]]);
});

test("watch reports a match when it changes, and stops", async () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url)));
  const answers = ["match-play", "match-play", "match-ended"];
  const chain = { evalJSON: async () => load(answers.shift() ?? "match-ended").results, typeJSON: async () => load("qtype-MatchView") };
  const arena = createArena({ chain, wallet: null, engine, realm: "gno.land/r/gfanton/gnomehall/arena", chainId: "dev", origin: "http://x", storage: memory() });
  const seen = [];
  const stop = arena.watch("1", (view, err) => seen.push(err ?? view.Phase), { interval: 5 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  const count = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, ["play", "ended"]);
  assert.equal(seen.length, count);
});

const realm = "gno.land/r/gfanton/gnomehall/arena";
const load = (name) => JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url)));

// walletFor answers Adena's connection calls for address, with the given overrides.
const walletFor = (address, overrides = {}) => ({
  AddEstablish: async () => ({ status: "success" }),
  GetNetwork: async () => ({ status: "success", data: { chainId: "dev" } }),
  GetAccount: async () => ({ status: "success", data: { address } }),
  ...overrides,
});

test("a challenger on a device that has not authorized sees the match, and a box it cannot open is unauthorized", async () => {
  // In the recorded match, gnodev's test1 account challenged and must reveal.
  const player = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
  const chain = { evalJSON: async () => load("match-reveal").results, typeJSON: async () => load("qtype-MatchView") };
  const storage = memory();
  const arena = createArena({ chain, wallet: walletFor(player), engine, realm, chainId: "dev", origin: "http://x", storage });
  assert.equal((await arena.connect()).state, "missing");

  const unopened = await arena.match("1");
  assert.equal(unopened.action, "move");
  assert.equal(unopened.planning, undefined);

  storage.setItem(`gnomehall:dev:${player}:root`, btoa("a signature from another site"));
  await assert.rejects(arena.match("1"), (err) => err instanceof ArenaError && err.type === "unauthorized");
});

// sessionChain answers sessions() with the session of generation 0 once created, and
// reports the sequence each send reads; broadcasts land after a short wait.
async function sessionChain(signature, master) {
  const { sessionAddress } = await deriveKeys(signature, 0, engine);
  const chain = {
    created: false, sequence: 0, reads: [],
    sessions: async () => {
      if (!chain.created) return [];
      chain.reads.push(chain.sequence);
      return [{ address: sessionAddress, accountNumber: 7, sequence: chain.sequence, expiresAt: 2_000_000_000, spendLimit: 10_000_000, spendUsed: 0, allowPaths: [`vm/exec:${realm}`] }];
    },
    gasPrice: async () => ({ gas: 1000, amount: 1, denom: "ugnot" }),
    simulate: async () => 1_000_000,
    broadcast: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      chain.sequence++;
      return { hash: "h", height: 1, gasUsed: 1 };
    },
  };
  return chain;
}

test("a refused session approval is asked for again on the next authorization", async () => {
  const signature = btoa("a root signature");
  const master = devAccounts.alice.address;
  const chain = await sessionChain(signature, master);
  let attempts = 0;
  const wallet = walletFor(master, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature } } }),
    DoContract: async () => {
      attempts++;
      if (attempts === 1) return { status: "failure", type: "TRANSACTION_REJECTED", message: "User rejected" };
      chain.created = true;
      return { status: "success" };
    },
  });
  const arena = createArena({ chain, wallet, engine, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();

  const refused = await arena.authorize();
  assert.equal(refused.mode, "contract");
  assert.equal(refused.fallback, "User rejected");

  const accepted = await arena.authorize();
  assert.equal(attempts, 2);
  assert.equal(accepted.mode, "session");
  assert.equal(accepted.state, "active");
  assert.equal(accepted.fallback, null);
});

// Adena signs a session message with the fee the page gives, or else with 2,000,000,000
// gas for 0.1 GNOT, which a chain at 1ugnot per 1000 gas refuses.
test("the session request names its gas and a fee at the chain's gas price", async () => {
  const signature = btoa("a root signature");
  const master = devAccounts.alice.address;
  const chain = await sessionChain(signature, master);
  chain.gasPrice = async () => ({ gas: 1000, amount: 25, denom: "ugnot" });
  let request;
  const wallet = walletFor(master, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature } } }),
    DoContract: async (params) => {
      request = params;
      chain.created = true;
      return { status: "success" };
    },
  });
  const arena = createArena({ chain, wallet, engine, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();

  assert.equal((await arena.authorize()).mode, "session");
  assert.equal(request.gasWanted, 3_000_000);
  assert.equal(request.gasFee, 75_000);
});

test("session moves go out one at a time, each with the sequence the last one left", async () => {
  const signature = btoa("a root signature");
  const master = devAccounts.alice.address;
  const chain = await sessionChain(signature, master);
  chain.created = true;
  const wallet = walletFor(master, { SignArbitrary: async () => ({ status: "success", data: { signature: { signature } } }) });
  const arena = createArena({ chain, wallet, engine, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();
  await arena.authorize();
  chain.reads.length = 0;

  await Promise.all([arena.resign("1"), arena.resign("2")]);
  assert.deepEqual(chain.reads, [0, 1]);
});

test("chain and wallet errors become the arena's typed errors", () => {
  const failed = (reason) => errorFrom(new ChainError("failed", reason)).type;
  assert.equal(failed("wrong phase"), "wrongPhase");
  assert.equal(failed("not your move"), "wrongPhase");
  assert.equal(failed("seal mismatch"), "sealMismatch");
  assert.equal(failed("illegal plan"), "illegalPlan");
  assert.equal(failed("illegal deck"), "illegalPlan");
  assert.equal(failed("unknown card"), "illegalPlan");
  assert.equal(failed("deadline passed"), "deadlinePassed");
  assert.equal(failed("challenge expired"), "deadlinePassed");
  assert.equal(errorFrom(new ChainError("rejected", "session expired: expires_at=1, block_time=2")).type, "sessionExpired");
  assert.equal(errorFrom(new ChainError("rejected", "session spend limit would be exceeded: attempted=1ugnot")).type, "sessionExpired");
  assert.equal(errorFrom(new ChainError("rejected", "unknown session")).type, "sessionExpired");
  assert.equal(errorFrom(new ChainError("rejected", "insufficient funds to pay for fees; 0ugnot < 1ugnot")).type, "insufficientFunds");
  assert.equal(errorFrom(new ChainError("network", "fetch failed")).type, "network");
  assert.equal(errorFrom(new WalletError("refused", "User rejected")).type, "refused");
  const other = errorFrom(new ChainError("failed", "something new"));
  assert.equal(other.type, "failed");
  assert.equal(other.reason, "something new");
  assert.equal(errorFrom(new ArenaError("outOfStep", "x")).type, "outOfStep");
});
