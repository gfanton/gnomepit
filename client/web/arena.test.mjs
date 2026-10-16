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
import { WalletError, deriveKeys, newSalt, openBox, revokeMessage, sealBox, sealOf, sessionBudget, sessionMessage } from "./wallet.mjs";

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

// lockAnswer is the realm's Locks answer for locks in vm/qeval_json's form, and lockType
// the vm/qtype_json answer for SessionLock.
const lockTypeID = `${realm}.SessionLock`;
const typedText = (value) => ({ T: { "@type": "/gno.PrimitiveType", value: "16" }, V: { "@type": "/gno.StringValue", value } });
function typedInt64(n) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(n), true);
  return { T: { "@type": "/gno.PrimitiveType", value: "1024" }, N: btoa(String.fromCharCode(...bytes)) };
}
const lockAnswer = (locks) => [{
  T: { "@type": "/gno.SliceType", Elt: { "@type": "/gno.RefType", ID: lockTypeID }, Vrd: false },
  V: {
    "@type": "/gno.SliceValue",
    Base: {
      "@type": "/gno.ArrayValue",
      List: locks.map((l) => ({
        T: { "@type": "/gno.RefType", ID: lockTypeID },
        V: { "@type": "/gno.StructValue", Fields: [typedText(l.Session), typedText(l.Match), typedInt64(l.Expires)] },
      })),
      Data: null,
    },
    Offset: "0", Length: String(locks.length), Maxcap: String(locks.length),
  },
}];
const lockType = {
  typeid: lockTypeID,
  type: { "@type": "/gno.DeclaredType", PkgPath: realm, Name: "SessionLock", Base: { "@type": "/gno.StructType", Fields: ["Session", "Match", "Expires"].map((Name) => ({ Name })) } },
};

// arenaChain holds master's session accounts in sessions, answers Locks with locks, and
// answers Match(id) with the recorded answer matches names for id, by file name or as
// parsed JSON, or fails with "unknown match". A broadcast lands after a short wait and
// moves the sequence of every session on; reads lists the sequence each sessions() read.
function arenaChain({ sessions = [], locks = [], matches = {} } = {}) {
  const chain = {
    sessionList: sessions, locks, sequence: 0, broadcasts: 0, reads: [],
    sessions: async () => {
      chain.reads.push(chain.sequence);
      return chain.sessionList.map((s) => ({ ...s, sequence: chain.sequence }));
    },
    evalJSON: async (expr) => {
      if (expr.startsWith(`${realm}.Locks(`)) return lockAnswer(chain.locks);
      if (expr.startsWith(`${realm}.Matches(`)) return load("matches").results;
      const [, id] = /\.Match\("(\d+)"\)$/.exec(expr);
      const answer = matches[id];
      if (answer === undefined) throw new ChainError("failed", "unknown match");
      return (typeof answer === "string" ? load(answer) : answer).results;
    },
    typeJSON: async (id) => (id === lockTypeID ? lockType : load(`qtype-${id.split(".").pop()}`)),
    gasPrice: async () => ({ gas: 1000, amount: 1, denom: "ugnot" }),
    simulate: async () => 1_000_000,
    broadcast: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      chain.sequence++;
      chain.broadcasts++;
      return { hash: "h", height: 1, gasUsed: 1 };
    },
  };
  return chain;
}

// revealWith is the recorded match in its reveal phase, holding box as the challenger's.
function revealWith(box) {
  const recordedText = readFileSync(new URL("./testdata/qeval/match-reveal.json", import.meta.url), "utf8");
  return JSON.parse(recordedText.replace('"box1"', JSON.stringify(box)));
}

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
  const chain = arenaChain({ matches: { 1: revealWith(box) } });
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

// gnodev's test1 plays both sides of the recorded match, as its challenger first.
const test1 = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const rootSigned = btoa("a root signature");
const keysOf = (generation) => deriveKeys(rootSigned, generation, signer);
const sessionOf = async (generation, fields = {}) => ({
  address: (await keysOf(generation)).sessionAddress,
  accountNumber: 20 + generation, sequence: 0, expiresAt: now + 3600, spendLimit: sessionBudget.challenger, spendUsed: 0, allowPaths: [`vm/exec:${realm}`],
  ...fields,
});
const lockOn = async (generation, match, expires = now + 3600) => ({ Session: (await keysOf(generation)).sessionAddress, Match: match, Expires: expires });
const day = 24 * 60 * 60;
const sessionExpired = (err) => err instanceof ArenaError && err.type === "sessionExpired";

// sessionPlayer is test1's arena on chain, with a wallet that signs the root text and
// answers each DoContract with created(request), and a signer that keeps every request.
function sessionPlayer(chain, { created = async () => ({ status: "success" }), ...options } = {}) {
  const contracts = [];
  const signed = [];
  const wallet = walletFor(test1, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature: rootSigned } } }),
    DoContract: async (request) => {
      contracts.push(request);
      return created(request);
    },
  });
  const recording = { ...signer, signTx: (request) => (signed.push(request), signer.signTx(request)) };
  const arena = createArena({ chain, wallet, engine, signer: recording, realm, chainId: "dev", origin: "http://x", storage: memory(), now: () => now, ...options });
  return { arena, contracts, signed };
}

const opening = { clan: "Pickers", deck: cardIDs(deckA, engine.cards), plan: cardIDs(picks, engine.cards) };

test("a challenge revokes the dead sessions and creates one in one approval, then signs the Challenge with it", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0, { expiresAt: now - 1 }), await sessionOf(1), await sessionOf(2)],
    locks: [await lockOn(1, "1"), await lockOn(2, "9")],
    matches: { 1: "match-ended" },
  });
  const { arena, contracts, signed } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(3, { accountNumber: 41 })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  assert.equal(contracts.length, 0, "authorizing asks for no session");

  await arena.challenge(opening);
  const [k0, k1, k2, k3] = await Promise.all([0, 1, 2, 3].map(keysOf));
  assert.equal(contracts.length, 1);
  assert.deepEqual(contracts[0].messages, [
    revokeMessage(test1, k0.sessionPubKey), revokeMessage(test1, k1.sessionPubKey), revokeMessage(test1, k2.sessionPubKey),
    sessionMessage(test1, k3.sessionPubKey, now, realm, sessionBudget.challenger, day),
  ]);
  assert.equal(chain.broadcasts, 1);
  const call = signed.at(-1);
  assert.equal(call.msgs[0].value.func, "Challenge");
  assert.deepEqual([call.privKey, call.sessionAddr, call.accountNumber, call.sequence], [k3.sessionKey, k3.sessionAddress, 41, 0]);
  assert.equal((await arena.connect()).mode, "session");
});

// Adena signs session messages with the fee the page gives, or else with 2,000,000,000 gas
// for 0.1 GNOT, which a chain at 1ugnot per 1000 gas refuses.
test("the session request names its gas per message and a fee at the chain's gas price", async () => {
  const chain = arenaChain({ sessions: [await sessionOf(0, { expiresAt: now - 1 })] });
  chain.gasPrice = async () => ({ gas: 1000, amount: 25, denom: "ugnot" });
  const { arena, contracts } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(1)];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.equal(contracts[0].messages.length, 2);
  assert.equal(contracts[0].gasWanted, 6_000_000);
  assert.equal(contracts[0].gasFee, 150_000);
});

test("an unlocked session with the role's budget left signs the opening without asking the wallet", async () => {
  const chain = arenaChain({ sessions: [await sessionOf(0, { spendUsed: sessionBudget.challenger - sessionBudget.acceptor }), await sessionOf(1)] });
  const { arena, contracts, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.equal(contracts.length, 0);
  assert.equal(signed.at(-1).sessionAddr, (await keysOf(1)).sessionAddress);

  await arena.accept("1", { clan: "Ironhide", deck: cardIDs(deckB, engine.cards), plan: cardIDs(braces, engine.cards) });
  assert.equal(contracts.length, 0);
  assert.equal(signed.at(-1).sessionAddr, (await keysOf(0)).sessionAddress);
});

test("with no generation free, the first one revoked takes the new session", async () => {
  // Every generation holds a session: 5 and 9 expired, the others live but short of a budget.
  const short = { spendUsed: sessionBudget.challenger - 300_000 };
  const sessions = await Promise.all([...Array(16).keys()].map((g) => sessionOf(g, g === 5 || g === 9 ? { expiresAt: now - 1 } : short)));
  const chain = arenaChain({ sessions });
  const { arena, contracts } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(5, { accountNumber: 77 })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  const [k5, k9] = await Promise.all([5, 9].map(keysOf));
  assert.deepEqual(contracts[0].messages, [
    revokeMessage(test1, k5.sessionPubKey), revokeMessage(test1, k9.sessionPubKey),
    sessionMessage(test1, k5.sessionPubKey, now, realm, sessionBudget.challenger, day),
  ]);
});

test("with every generation holding a session it may not revoke, the wallet signs each move", async () => {
  const elsewhere = { allowPaths: ["vm/exec:gno.land/r/gfanton/gnomehall/arena_v1"] };
  const chain = arenaChain({ sessions: await Promise.all([...Array(16).keys()].map((g) => sessionOf(g, elsewhere))) });
  const { arena, contracts } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.deepEqual(contracts.map((c) => c.messages.map((m) => m.value.func)), [["Challenge"]]);
  const account = await arena.connect();
  assert.equal(account.mode, "contract");
  assert.equal(account.fallback, "Every session this account can hold is used");
});

test("a refused session approval has the wallet sign the move, and the next authorization asks again", async () => {
  const chain = arenaChain();
  let attempts = 0;
  const { arena, contracts } = sessionPlayer(chain, {
    created: async (request) => {
      if (request.messages[0].type !== "/auth.m_create_session") return { status: "success" };
      attempts++;
      if (attempts === 1) return { status: "failure", type: "TRANSACTION_REJECTED", message: "User rejected" };
      chain.sessionList = [await sessionOf(0)];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();

  await arena.challenge(opening);
  assert.deepEqual(contracts.map((c) => c.messages[0].type), ["/auth.m_create_session", "/vm.m_call"]);
  const refused = await arena.connect();
  assert.equal(refused.mode, "contract");
  assert.equal(refused.fallback, "User rejected");

  const again = await arena.authorize();
  assert.equal(again.mode, "session");
  assert.equal(again.state, "active");
  assert.equal(again.fallback, null);
  await arena.challenge(opening);
  assert.equal(attempts, 2);
  assert.equal(chain.broadcasts, 1);
});

test("an acceptance asks for a session with the acceptor's budget", async () => {
  const chain = arenaChain();
  const { arena, contracts } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(0, { spendLimit: sessionBudget.acceptor })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.accept("1", { clan: "Ironhide", deck: cardIDs(deckB, engine.cards), plan: cardIDs(braces, engine.cards) });
  assert.equal(contracts[0].messages[0].value.spend_limit, `${sessionBudget.acceptor}ugnot`);
});

test("the arena's session lifetime sets the new session's expiry", async () => {
  const chain = arenaChain();
  const { arena, contracts } = sessionPlayer(chain, {
    sessionLifetime: 30,
    created: async () => {
      chain.sessionList = [await sessionOf(0, { expiresAt: now + 30 })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.equal(contracts[0].messages[0].value.expires_at, String(now + 30));
});

// expiredReveal is a chain where test1 must reveal in match 1, whose session has expired.
async function expiredReveal() {
  const deck = cardIDs(deckA, engine.cards);
  const box = await sealBox((await keysOf(0)).boxKey, { deck, deckSalt: newSalt(), plan: cardIDs(picks, engine.cards), planSalt: newSalt() });
  return arenaChain({ sessions: [await sessionOf(0, { expiresAt: now - 1 })], locks: [await lockOn(0, "1", now - 1)], matches: { 1: revealWith(box) } });
}

test("a move whose session has expired throws sessionExpired and sends nothing", async () => {
  const chain = await expiredReveal();
  const { arena, contracts } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  const view = await arena.match("1");
  assert.equal(view.action, "move");
  assert.equal(view.session, "expired");
  await assert.rejects(arena.move("1", engine.legalPlans(view.planning)[0]), sessionExpired);
  await assert.rejects(arena.resign("1"), sessionExpired);
  assert.equal(chain.broadcasts, 0);
  assert.equal(contracts.length, 0);

  const { arena: byWallet } = sessionPlayer(chain, { signEachMove: true });
  await byWallet.connect();
  await byWallet.authorize();
  assert.equal((await byWallet.match("1")).session, "active");
});

test("renew creates a session for the player's side without sending a move, and the next move signs with it", async () => {
  const chain = await expiredReveal();
  const { arena, contracts, signed } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(1, { accountNumber: 52 })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.renew("1");
  const [k0, k1] = await Promise.all([0, 1].map(keysOf));
  assert.deepEqual(contracts.map((c) => c.messages), [[
    revokeMessage(test1, k0.sessionPubKey), sessionMessage(test1, k1.sessionPubKey, now, realm, sessionBudget.challenger, day),
  ]]);
  assert.equal(chain.broadcasts, 0);

  const view = await arena.match("1");
  assert.equal(view.session, "active");
  await arena.move("1", engine.legalPlans(view.planning)[0]);
  assert.equal(chain.broadcasts, 1);
  assert.deepEqual([signed.at(-1).sessionAddr, signed.at(-1).accountNumber], [k1.sessionAddress, 52]);
});

test("session moves go out one at a time, each with the sequence the last one left", async () => {
  const chain = arenaChain({ sessions: [await sessionOf(0)], locks: [await lockOn(0, "1")], matches: { 1: "match-play" } });
  const { arena, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  chain.reads.length = 0;

  await Promise.all([arena.resign("1"), arena.resign("1")]);
  assert.deepEqual(chain.reads, [0, 1]);
  // Each move is signed twice, for its simulation and for its fee.
  assert.deepEqual(signed.map((r) => r.sequence), [0, 0, 1, 1]);
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
  assert.equal(failed("session locked to match 3"), "sessionExpired");
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
