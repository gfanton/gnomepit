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
import * as signer from "./signer.mjs";
import { WalletError, deriveKeys, newSalt, openBox, sealBox, sealOf } from "./wallet.mjs";

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
  const opened = { deck: cardIDs(deckA, engine.cards), deckSalt: "d", plan: cardIDs(picks, engine.cards), planSalt: "p" };
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

test("the challenger's move reveals, naming the box's cards, with the deck on round 1 only, and seals the next plan", () => {
  const opened = { deck: cardIDs(deckA, engine.cards), deckSalt: "ds", plan: cardIDs(picks, engine.cards), planSalt: "ps" };
  const next = { plan: braces, seal: "nextseal", box: "nextbox" };
  const round1 = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  assert.deepEqual(moveCall(round1, opened, next, engine.cards), { func: "Reveal", args: ["1", deckA, "ds", picks, "ps", "nextseal", "nextbox"] });

  const round2 = view({ ...accepted, Phase: "reveal", Round: 2, ToMove: alice, ChallengerDeck: deckA });
  const later = { plan: cardIDs(picks, engine.cards), planSalt: "ps" };
  assert.deepEqual(moveCall(round2, later, next, engine.cards), { func: "Reveal", args: ["1", "", "", picks, "ps", "nextseal", "nextbox"] });
  assert.deepEqual(moveCall(round2, later, null, engine.cards), { func: "Reveal", args: ["1", "", "", picks, "ps", "", ""] });
});

test("the acceptor's move plays face up", () => {
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  assert.deepEqual(moveCall(play, null, { plan: picks }, engine.cards), { func: "Play", args: ["1", picks] });
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
  const wallet = devWallet({ name: "alice", signer, chain: null, chainId: "dev" });
  const arena = createArena({ chain: null, wallet, engine, signer, realm: "gno.land/r/gfanton/gnomehall/arena", chainId: "dev", origin: "http://x", storage: memory(), notifier });
  await arena.connect();
  assert.equal(await arena.notify(), 2);
  assert.deepEqual(sent, [[{ trigger: "0000001", value: devAccounts.alice.address }, { trigger: "0000002", value: devAccounts.alice.address }]]);
});

test("watch reports a match when it changes, and stops", async () => {
  const load = (name) => JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url)));
  const answers = ["match-play", "match-play", "match-ended"];
  const chain = { evalJSON: async () => load(answers.shift() ?? "match-ended").results, typeJSON: async () => load("qtype-MatchView") };
  const arena = createArena({ chain, wallet: null, engine, signer, realm: "gno.land/r/gfanton/gnomehall/arena", chainId: "dev", origin: "http://x", storage: memory() });
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
  const arena = createArena({ chain, wallet: walletFor(player), engine, signer, realm, chainId: "dev", origin: "http://x", storage });
  assert.equal((await arena.connect()).state, "missing");

  const unopened = await arena.match("1");
  assert.equal(unopened.action, "move");
  assert.equal(unopened.planning, undefined);

  storage.setItem(`gnomehall:dev:${player}:root`, btoa("a signature from another site"));
  await assert.rejects(arena.match("1"), (err) => err instanceof ArenaError && err.type === "unauthorized");
});

test("a challenger's opened box gives the pending clash and the deck to plan from, as card ids", async () => {
  const player = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
  const signature = btoa("a root signature");
  const deck = cardIDs(deckA, engine.cards);
  const box = await sealBox((await deriveKeys(signature, 0, signer)).boxKey, { deck, deckSalt: newSalt(), plan: cardIDs(picks, engine.cards), planSalt: newSalt() });
  const recordedText = readFileSync(new URL("./testdata/qeval/match-reveal.json", import.meta.url), "utf8");
  const answer = JSON.parse(recordedText.replace('"box1"', JSON.stringify(box)));
  const chain = { evalJSON: async () => answer.results, typeJSON: async () => load("qtype-MatchView") };
  const storage = memory();
  const arena = createArena({ chain, wallet: walletFor(player), engine, signer, realm, chainId: "dev", origin: "http://x", storage });
  await arena.connect();
  storage.setItem(`gnomehall:dev:${player}:root`, signature);

  const opened = await arena.match("1");
  assert.equal(opened.action, "move");
  assert.deepEqual(opened.pending.plans, [cardIDs(picks, engine.cards), cardIDs(braces, engine.cards)]);
  assert.deepEqual(opened.planning.deck, [...deck].sort((a, b) => a - b));
});

// The box keeps the deck as a card set, so a deck sealed in the player's order could never
// be revealed: the reveal names the box's deck in card id order.
test("a challenge seals its deck and plan as their reveal will name them", async () => {
  const signature = btoa("a root signature");
  let args;
  const wallet = walletFor(alice, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature } } }),
    DoContract: async ({ messages: [msg] }) => {
      args = msg.value.args;
      return { status: "success" };
    },
  });
  const chain = { evalJSON: async () => load("matches").results, typeJSON: async () => load("qtype-MatchSummary") };
  const arena = createArena({ chain, wallet, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory(), signEachMove: true });
  await arena.connect();
  await arena.authorize();

  const deck = cardIDs(deckA, engine.cards).reverse();
  await arena.challenge({ clan: "Pickers", deck, plan: cardIDs("Chalk Dust,Double Tap", engine.cards) });
  const [clan, deckSeal, planSeal, box] = args;
  assert.equal(clan, "Pickers");
  const opened = await openBox((await deriveKeys(signature, 0, signer)).boxKey, box);
  const round1 = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", "Hammer Blow,Spiked Shield"]] });
  const [, deckText, deckSalt, planText, planSalt] = moveCall(round1, opened, null, engine.cards).args;
  assert.equal(await sealOf(deckSalt, deckText), deckSeal);
  assert.equal(await sealOf(planSalt, planText), planSeal);
  assert.equal(planText, "Chalk Dust,Double Tap");
});

// sessionChain answers sessions() with the session of generation 0 once created, and
// reports the sequence each send reads; broadcasts land after a short wait.
async function sessionChain(signature, master) {
  const { sessionAddress } = await deriveKeys(signature, 0, signer);
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
  const arena = createArena({ chain, wallet, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory() });
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
  const arena = createArena({ chain, wallet, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory() });
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
  const signed = [];
  const recording = { ...signer, signTx: (request) => (signed.push(request.sequence), signer.signTx(request)) };
  const arena = createArena({ chain, wallet, engine, signer: recording, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();
  await arena.authorize();
  chain.reads.length = 0;

  await Promise.all([arena.resign("1"), arena.resign("2")]);
  assert.deepEqual(chain.reads, [0, 1]);
  // Each move is signed twice, for its simulation and for its fee.
  assert.deepEqual(signed, [0, 0, 1, 1]);
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

test("notifications without a gnotif client fail with a readable reason", async () => {
  const arena = createArena({ chain: null, wallet: walletFor(alice), engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();
  await assert.rejects(arena.notify(), (err) => err instanceof ArenaError && err.type === "failed" && err.reason === "Notifications are not set up for this network");
});

// The lobby's pager offers a next page after a full one.
test("the board and a player's matches come 50 a page, the most the realm returns", async () => {
  const asked = [];
  const chain = {
    evalJSON: async (expr) => {
      asked.push(expr);
      return load(expr.includes(".Open(") ? "open" : "matches").results;
    },
    typeJSON: async (id) => load(id.endsWith("OpenChallenge") ? "qtype-OpenChallenge" : "qtype-MatchSummary"),
  };
  const arena = createArena({ chain, wallet: walletFor(alice), engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory() });
  await arena.connect();
  await arena.openChallenges(1);
  await arena.myMatches(1);
  assert.deepEqual(asked, [`${realm}.Open(50, 50)`, `${realm}.Matches("${alice}", 50, 50)`]);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fakeIndexer hands the test the handlers the arena gives the indexer.
function fakeIndexer() {
  const feed = { stopped: false };
  feed.watchCalls = (watched, onCall, onState) => {
    Object.assign(feed, { watched, onCall, onState });
    return () => {
      feed.stopped = true;
    };
  };
  return feed;
}

test("subscribe reports each arena call with the match it touches; a new challenge touches none", () => {
  const indexer = fakeIndexer();
  const arena = createArena({ chain: null, wallet: null, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory(), indexer });
  const changes = [];
  const stop = arena.subscribe((c) => changes.push(c));
  assert.equal(indexer.watched, realm);

  indexer.onCall({ height: 5, caller: alice, func: "Play", args: ["7", picks] });
  indexer.onCall({ height: 6, caller: bob, func: "Challenge", args: ["Ironhide", "seal", "seal", "box", ""] });
  assert.deepEqual(changes, [
    { match: "7", func: "Play", caller: alice, height: 5 },
    { match: null, func: "Challenge", caller: bob, height: 6 },
  ]);
  stop();
  assert.equal(indexer.stopped, true);
});

// The indexer reports only calls indexed after its first answer, so each time it starts
// answering the feed reports a change that names no match; polling the node stands in
// while it does not answer.
test("each time the indexer starts answering a change is reported, and polling runs only while it does not", async () => {
  const indexer = fakeIndexer();
  const arena = createArena({ chain: null, wallet: null, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory(), indexer });
  const changes = [];
  const stop = arena.subscribe((c) => changes.push(c), { interval: 5 });
  await sleep(30);
  assert.deepEqual(changes, []);

  indexer.onState("up");
  assert.deepEqual(changes, [{}]);
  await sleep(30);
  assert.equal(changes.length, 1);

  indexer.onState("down");
  await sleep(40);
  assert.ok(changes.length >= 4, `polled ${changes.length - 1} times`);
  assert.ok(changes.every((c) => c.match === undefined));

  indexer.onState("up");
  const reconnected = changes.length;
  await sleep(30);
  assert.equal(changes.length, reconnected);
  stop();
});

test("without an indexer, subscribe polls every interval until stopped", async () => {
  const arena = createArena({ chain: null, wallet: null, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory() });
  const changes = [];
  const stop = arena.subscribe((c) => changes.push(c), { interval: 5 });
  await sleep(40);
  stop();
  const polled = changes.length;
  assert.ok(polled >= 3, `polled ${polled} times`);
  assert.deepEqual(changes[0], {});
  await sleep(20);
  assert.equal(changes.length, polled);
});

test("watch reads a match again on a call to it, and not on a call to another match", async () => {
  let reads = 0;
  const chain = {
    evalJSON: async () => {
      reads++;
      return load("match-play").results;
    },
    typeJSON: async () => load("qtype-MatchView"),
  };
  const indexer = fakeIndexer();
  const arena = createArena({ chain, wallet: null, engine, signer, realm, chainId: "dev", origin: "http://x", storage: memory(), indexer });
  const stop = arena.watch("1", () => {});
  await sleep(10);
  assert.equal(reads, 1);

  indexer.onCall({ height: 9, caller: bob, func: "Play", args: ["2", picks] });
  await sleep(10);
  assert.equal(reads, 1);
  indexer.onCall({ height: 9, caller: bob, func: "Play", args: ["1", picks] });
  await sleep(10);
  assert.equal(reads, 2);
  stop();
});
