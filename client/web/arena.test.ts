import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import * as v from "valibot";

import {
  type Arena,
  type ArenaChange,
  ArenaError,
  type ArenaOptions,
  type Connection,
  type MatchDetail,
  type MatchView,
  type Notifier,
  actionFor,
  cardIDs,
  cardNames,
  checkOpening,
  checkPlan,
  createArena,
  errorFrom,
  moveCall,
  pendingClash,
  planFrom,
  replay,
  sessionLocks,
  walletFailure,
} from "./arena.ts";
import { type Chain, ChainError, type Session } from "./chain.ts";
import { devAccounts, devWallet } from "./devwallet.ts";
import type { GameState, Gnome, LegalPlansRequest } from "./engine.ts";
import { nodeEngine } from "./engine-node.ts";
import { known, unexpectedAsync, unusedPage } from "./fixture.ts";
import { type Address, address, matchId } from "./ids.ts";
import type { IndexedCall, Indexer } from "./indexer.ts";
import { createLobby } from "./lobby.ts";
import * as signer from "./signer.ts";
import type { SignRequest } from "./signer.ts";
import {
  type TxRequest,
  type Wallet,
  WalletError,
  deriveKeys,
  newSalt,
  openBox,
  revokeMessage,
  sealBox,
  sealOf,
  sessionBudget,
  sessionMessage,
  sessionReserve,
} from "./wallet.ts";

const engine = await nodeEngine();
const alice = address("g1alice");
const bob = address("g1bob");
const carol = address("g1carol");
const deckA = "Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine";
const deckB = "Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche";
const picks = "Pick,Pick,Pick";
const braces = "Brace,Brace,Brace";

// view builds a decoded MatchView, as gnovalue gives it.
const view = (fields: Partial<MatchView>): MatchView => ({
  ID: matchId("1"),
  Phase: "open",
  Round: 1,
  Challenger: alice,
  Acceptor: "",
  ChallengerClan: "Pickers",
  AcceptorClan: "",
  ToMove: "",
  Deadline: 2_000_000_000,
  Result: "",
  Reason: "",
  Opponent: "",
  ChallengerDeck: "",
  AcceptorDeck: "",
  Plans: [],
  Box: "",
  HP: [],
  DeadlinePassed: false,
  ...fields,
});
const accepted: Partial<MatchView> = { Acceptor: bob, AcceptorClan: "Ironhide", AcceptorDeck: deckB };
const now = 1_900_000_000;
// fullHP is a gnome as a match starts.
const fullHP = (): Gnome => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] });

test("card names and ids convert both ways through the engine's cards", () => {
  const ids = cardIDs(deckA, engine.cards);
  assert.equal(ids.length, 8);
  assert.equal(cardNames(ids, engine.cards), deckA);
  assert.throws(
    () => cardIDs("Pick,Bulwerk", engine.cards),
    (err) => err instanceof ArenaError && err.type === "outOfStep",
  );
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
    state: { round: 1, gnomes: [fullHP(), fullHP()] },
    decks: [cardIDs(deckA, engine.cards), cardIDs(deckB, engine.cards)],
    a: cardIDs("Chalk Dust,Double Tap", engine.cards),
    b: cardIDs("Hammer Blow,Spiked Shield", engine.cards),
  });
  const hp: [number, number] = [round1.state.gnomes[0].hp, round1.state.gnomes[1].hp];
  const played = view({
    ...accepted,
    Phase: "play",
    Round: 2,
    ChallengerDeck: deckA,
    Plans: [
      ["Chalk Dust,Double Tap", "Hammer Blow,Spiked Shield"],
      ["", ""],
    ],
    HP: [hp],
  });

  const { rounds, state } = replay(played, engine);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0]?.events, round1.events);
  assert.equal(state.round, 2);

  const wrong = { ...played, HP: [[hp[0] + 1, hp[1]]] };
  assert.throws(
    () => replay(wrong, engine),
    (err) => err instanceof ArenaError && err.type === "outOfStep",
  );
});

test("the pending clash resolves the challenger's sealed plan against the acceptor's", () => {
  const reveal = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  const opened = {
    deck: cardIDs(deckA, engine.cards),
    deckSalt: "d",
    plan: cardIDs(picks, engine.cards),
    planSalt: "p",
  };
  const pending = pendingClash(reveal, opened, replay(reveal, engine).state, engine);
  assert.equal(pending.round, 1);
  assert.deepEqual(pending.plans, [cardIDs(picks, engine.cards), cardIDs(braces, engine.cards)]);
  assert.equal(pending.result, "ongoing");
  assert.equal(pending.state.round, 2);
});

test("the player to move plans from their side, deck and the state their round starts in", () => {
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  const state: GameState = { round: 2, gnomes: [fullHP(), fullHP()] };
  assert.deepEqual(planFrom(play, state, undefined, "", engine.cards), {
    state,
    side: 1,
    deck: cardIDs(deckB, engine.cards),
  });

  const reveal = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  const pending: { state: GameState } = { state: { round: 2, gnomes: [fullHP(), fullHP()] } };
  assert.deepEqual(planFrom(reveal, state, pending, deckA, engine.cards), {
    state: pending.state,
    side: 0,
    deck: cardIDs(deckA, engine.cards),
  });
  // A device that has not authorized cannot open the box, so it has nothing to plan from.
  assert.equal(planFrom(reveal, state, undefined, "", engine.cards), undefined);
});

const start: GameState = { round: 1, gnomes: [fullHP(), fullHP()] };
const illegal = (err: unknown) => err instanceof ArenaError && err.type === "illegalPlan";

test("a plan the engine refuses is never sealed or sent", () => {
  const planning: LegalPlansRequest = { state: start, side: 0, deck: cardIDs(deckA, engine.cards) };
  assert.doesNotThrow(() => checkPlan(engine, planning, cardIDs(picks, engine.cards)));
  assert.throws(() => checkPlan(engine, planning, cardIDs("Stone Guard", engine.cards)), illegal);
  assert.throws(() => checkPlan(engine, planning, cardIDs("Pick,Pick", engine.cards)), illegal);
});

test("a challenge or acceptance with a deck or plan the engine refuses is never sent", () => {
  const deck = cardIDs(deckA, engine.cards);
  assert.doesNotThrow(() => checkOpening(engine, "Pickers", deck, cardIDs(picks, engine.cards), 0));
  const foreign = [...deck.slice(1), known(cardIDs("Stone Guard", engine.cards)[0])];
  assert.throws(() => checkOpening(engine, "Pickers", foreign, cardIDs(picks, engine.cards), 0), illegal);
  assert.throws(() => checkOpening(engine, "Pickers", deck, cardIDs("Bulwark,Pick", engine.cards), 0), illegal);
  assert.throws(
    () => checkOpening(engine, "Ironhide", cardIDs(deckB, engine.cards), cardIDs("Kneecap,Pick,Pick", engine.cards), 1),
    illegal,
  );
});

test("a move the wallet sent but the chain refused keeps the chain's reason", () => {
  const failed = (message: string) => walletFailure({ status: "failure", type: "TRANSACTION_FAILED", message });
  assert.equal(failed("wrong phase").type, "wrongPhase");
  assert.equal(failed("deadline not passed").type, "failed");
  assert.equal(failed("deadline not passed").reason, "deadline not passed");
  assert.equal(
    walletFailure({ status: "failure", type: "TRANSACTION_REJECTED", message: "User rejected" }).type,
    "refused",
  );
  assert.equal(walletFailure(undefined).type, "refused");
});

test("the challenger's move reveals, naming the box's cards, with the deck on round 1 only, and seals the next plan", () => {
  const opened = {
    deck: cardIDs(deckA, engine.cards),
    deckSalt: "ds",
    plan: cardIDs(picks, engine.cards),
    planSalt: "ps",
  };
  const next = { plan: braces, seal: "nextseal", box: "nextbox" };
  const round1 = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", braces]] });
  assert.deepEqual(moveCall(round1, opened, next, engine.cards), {
    func: "Reveal",
    args: ["1", deckA, "ds", picks, "ps", "nextseal", "nextbox"],
  });

  const round2 = view({ ...accepted, Phase: "reveal", Round: 2, ToMove: alice, ChallengerDeck: deckA });
  const later = { plan: cardIDs(picks, engine.cards), planSalt: "ps" };
  assert.deepEqual(moveCall(round2, later, next, engine.cards), {
    func: "Reveal",
    args: ["1", "", "", picks, "ps", "nextseal", "nextbox"],
  });
  assert.deepEqual(moveCall(round2, later, null, engine.cards), {
    func: "Reveal",
    args: ["1", "", "", picks, "ps", "", ""],
  });
});

test("the acceptor's move plays face up", () => {
  const play = view({ ...accepted, Phase: "play", Round: 2, ToMove: bob });
  assert.deepEqual(moveCall(play, null, { plan: picks }, engine.cards), { func: "Play", args: ["1", picks] });
});

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, value) => items.set(k, String(value)) };
}

test("notify opts the wallet's address in to the arena's two triggers", async () => {
  const sent: { trigger: string; value: Address }[][] = [];
  const notifier: Notifier = {
    enable: async () => ({}),
    triggers: async (target) => {
      assert.equal(target, "gno.land/r/gfanton/gnomehall/arena");
      return [
        { id: "0000001", event: "Turn" },
        { id: "0000002", event: "Ended" },
        { id: "0000003", event: "Other" },
      ];
    },
    setOptins: async (optins) => sent.push(optins),
  };
  const wallet = devWallet({ name: "alice", signer, chain: arenaChain(), chainId: "dev" });
  const arena = createArena({
    chain: arenaChain(),
    wallet,
    engine,
    signer,
    realm: "gno.land/r/gfanton/gnomehall/arena",
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    notifier,
  });
  await arena.connect();
  assert.equal(await arena.notify(), 2);
  assert.deepEqual(sent, [
    [
      { trigger: "0000001", value: devAccounts.alice.address },
      { trigger: "0000002", value: devAccounts.alice.address },
    ],
  ]);
});

test("the arena says whether it found a wallet and can send notifications", () => {
  const realm = "gno.land/r/gfanton/gnomehall/arena";
  const bare = createArena({
    chain: arenaChain(),
    wallet: null,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  assert.equal(bare.hasWallet, false);
  assert.equal(bare.canNotify, false);
  const full = createArena({
    chain: arenaChain(),
    wallet: walletFor(address("g1alice")),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    notifier: { enable: async () => ({}), triggers: async () => [], setOptins: async () => ({}) },
  });
  assert.equal(full.hasWallet, true);
  assert.equal(full.canNotify, true);
});

test("watch reports a match when it changes, and stops", async () => {
  const answers = ["match-play", "match-play", "match-ended"];
  const chain = {
    ...arenaChain(),
    evalJSON: async () => recorded(answers.shift() ?? "match-ended").results,
    typeJSON: async () => load("qtype-MatchView"),
  };
  const arena = createArena({
    chain,
    wallet: null,
    engine,
    signer,
    realm: "gno.land/r/gfanton/gnomehall/arena",
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  const seen: (ArenaError | string)[] = [];
  const stop = arena.watch(
    matchId("1"),
    (view, err) => {
      seen.push(err ?? known(view).Phase);
    },
    { interval: 5 },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  const count = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen, ["play", "ended"]);
  assert.equal(seen.length, count);
});

const realm = "gno.land/r/gfanton/gnomehall/arena";
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url), "utf8"));
// A recorded vm/qeval_json answer.
const RecordedSchema = v.object({ results: v.array(v.unknown()) });
type Recorded = v.InferOutput<typeof RecordedSchema>;
const recorded = (name: string): Recorded => v.parse(RecordedSchema, load(name));

type TestWallet = Pick<
  Wallet,
  "AddEstablish" | "GetNetwork" | "SwitchNetwork" | "GetAccount" | "SignArbitrary" | "DoContract"
>;

// walletFor answers Adena's connection calls for account, with the given overrides.
const walletFor = (account: Address, overrides: Partial<TestWallet> = {}): TestWallet => ({
  AddEstablish: async () => ({ status: "success" }),
  GetNetwork: async () => ({ status: "success", data: { chainId: "dev" } }),
  SwitchNetwork: unexpectedAsync("SwitchNetwork"),
  GetAccount: async () => ({ status: "success", data: { address: account } }),
  SignArbitrary: unexpectedAsync("SignArbitrary"),
  DoContract: unexpectedAsync("DoContract"),
  ...overrides,
});

type TestLock = { Session: Address; Match: string; Expires: number };

// lockAnswer is the realm's Locks answer for locks in vm/qeval_json's form, and lockType
// the vm/qtype_json answer for SessionLock.
const lockTypeID = `${realm}.SessionLock`;
const typedText = (value: string) => ({
  T: { "@type": "/gno.PrimitiveType", value: "16" },
  V: { "@type": "/gno.StringValue", value },
});
function typedInt64(n: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(n), true);
  return { T: { "@type": "/gno.PrimitiveType", value: "1024" }, N: btoa(String.fromCharCode(...bytes)) };
}
const lockAnswer = (locks: TestLock[]) => [
  {
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
      Offset: "0",
      Length: String(locks.length),
      Maxcap: String(locks.length),
    },
  },
];
const lockType = {
  typeid: lockTypeID,
  type: {
    "@type": "/gno.DeclaredType",
    PkgPath: realm,
    Name: "SessionLock",
    Base: { "@type": "/gno.StructType", Fields: ["Session", "Match", "Expires"].map((Name) => ({ Name })) },
  },
};

// gnodev's gas price, at which the chain below charges unless a test sets another.
const floor = { gas: 1000, amount: 1, denom: "ugnot" };
const budget = { challenger: sessionBudget("challenger", floor), acceptor: sessionBudget("acceptor", floor) };

type ArenaChain = Chain & {
  sessionList: Session[];
  locks: TestLock[];
  sequence: number;
  broadcasts: number;
  reads: number[];
  matchReads: string[];
};
// What Match(id) answers: a recorded answer by file name or as parsed JSON, or an error it throws.
type MatchAnswer = string | Recorded | ChainError;

// arenaChain holds master's session accounts in sessions, answers Locks with locks, and
// answers Match(id) with the recorded answer matches names for id, by file name or as
// parsed JSON, or throws it when it is an error, or fails with "unknown match". A
// broadcast lands after a short wait and moves the sequence of every session on; reads
// lists the sequence each sessions() read, and matchReads each id Match read.
function arenaChain({
  sessions = [],
  locks = [],
  matches = {},
}: { sessions?: Session[]; locks?: TestLock[]; matches?: Record<string, MatchAnswer> } = {}): ArenaChain {
  const chain: ArenaChain = {
    sessionList: sessions,
    locks,
    sequence: 0,
    broadcasts: 0,
    reads: [],
    matchReads: [],
    sessions: async () => {
      chain.reads.push(chain.sequence);
      return chain.sessionList.map((s) => ({ ...s, sequence: chain.sequence }));
    },
    evalJSON: async (expr) => {
      if (expr.startsWith(`${realm}.Locks(`)) return lockAnswer(chain.locks);
      if (expr.startsWith(`${realm}.Matches(`)) return recorded("matches").results;
      if (expr.startsWith(`${realm}.Open(`)) return recorded("open").results;
      const id = /\.Match\("(\d+)"\)$/.exec(expr)?.[1];
      if (id === undefined) throw new Error(`the test chain does not answer ${expr}`);
      chain.matchReads.push(id);
      const answer = matches[id];
      if (answer === undefined) throw new ChainError("failed", "unknown match");
      if (answer instanceof Error) throw answer;
      return (typeof answer === "string" ? recorded(answer) : answer).results;
    },
    typeJSON: async (id) => (id === lockTypeID ? lockType : load(`qtype-${id.split(".").at(-1) ?? ""}`)),
    account: unexpectedAsync("account"),
    sessionAccount: unexpectedAsync("sessionAccount"),
    gasPrice: async () => floor,
    simulate: async () => 1_000_000,
    broadcast: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      chain.sequence++;
      chain.broadcasts++;
      return { hash: "h", height: 1, gasUsed: 1, storage: 0 };
    },
  };
  return chain;
}

// revealWith is the recorded match in its reveal phase, holding box as the challenger's.
function revealWith(box: string): Recorded {
  const recordedText = readFileSync(new URL("./testdata/qeval/match-reveal.json", import.meta.url), "utf8");
  return v.parse(RecordedSchema, JSON.parse(recordedText.replace('"box1"', JSON.stringify(box))));
}

test("a challenger on a device that has not authorized sees the match, and a box it cannot open is unauthorized", async () => {
  // In the recorded match, gnodev's test1 account challenged and must reveal.
  const player = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const chain = {
    ...arenaChain(),
    evalJSON: async () => recorded("match-reveal").results,
    typeJSON: async () => load("qtype-MatchView"),
  };
  const storage = memory();
  const arena = createArena({
    chain,
    wallet: walletFor(player),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage,
  });
  assert.equal((await arena.connect()).state, "missing");

  const unopened = await arena.match(matchId("1"));
  assert.equal(unopened.action, "move");
  assert.equal(unopened.planning, undefined);

  storage.setItem(`gnomehall:dev:${player}:root`, btoa("a signature from another site"));
  await assert.rejects(arena.match(matchId("1")), (err) => err instanceof ArenaError && err.type === "unauthorized");
});

test("a match view the page cannot read fails as failed", async () => {
  const player = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const typeText = readFileSync(new URL("./testdata/qeval/qtype-MatchView.json", import.meta.url), "utf8");
  const renamed: unknown = JSON.parse(typeText.replace('"Name": "Phase"', '"Name": "Stage"'));
  const chain = {
    ...arenaChain(),
    evalJSON: async () => recorded("match-reveal").results,
    typeJSON: async () => renamed,
  };
  const arena = createArena({
    chain,
    wallet: walletFor(player),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  await arena.connect();
  await assert.rejects(arena.match(matchId("1")), (err) => err instanceof ArenaError && err.type === "failed");
});

test("a player's session locks read as typed locks, and an answer of another shape fails as failed", async () => {
  const asked: string[] = [];
  const read = async (expr: string): Promise<unknown> => {
    asked.push(expr);
    return [{ Session: "g1session", Match: "4", Expires: 1792748377 }];
  };
  assert.deepEqual(await sessionLocks(read, realm, alice), [
    { Session: address("g1session"), Match: matchId("4"), Expires: 1792748377 },
  ]);
  assert.deepEqual(asked, [`${realm}.Locks("g1alice")`]);
  const unreadable = async (): Promise<unknown> => [{ Session: "g1session", Match: 4 }];
  await assert.rejects(
    sessionLocks(unreadable, realm, alice),
    (err) => err instanceof ArenaError && err.type === "failed",
  );
});

test("a stored mode the page does not know reads as session", async () => {
  const player = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const storage = memory();
  storage.setItem(`gnomehall:dev:${player}:mode`, "sometimes");
  const arena = createArena({
    chain: arenaChain(),
    wallet: walletFor(player),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage,
  });
  assert.equal(accountOf(await arena.connect()).mode, "session");
});

test("values the page stored before this change still read", async () => {
  const player = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const storage = memory();
  storage.setItem(`gnomehall:dev:${player}:root`, btoa("sig"));
  storage.setItem(`gnomehall:dev:${player}:mode`, "contract");
  storage.setItem(`gnomehall:dev:${player}:fallback`, "Adena cannot create sessions");
  const arena = createArena({
    chain: arenaChain(),
    wallet: walletFor(player),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage,
  });
  assert.deepEqual(await arena.connect(), {
    address: player,
    state: "active",
    mode: "contract",
    fallback: "Adena cannot create sessions",
  });
});

test("a challenger's opened box gives the pending clash and the deck to plan from, as card ids", async () => {
  const player = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const signature = btoa("a root signature");
  const deck = cardIDs(deckA, engine.cards);
  const box = await sealBox((await deriveKeys(signature, 0, signer)).boxKey, {
    deck,
    deckSalt: newSalt(),
    plan: cardIDs(picks, engine.cards),
    planSalt: newSalt(),
  });
  const chain = arenaChain({ matches: { 1: revealWith(box) } });
  const storage = memory();
  const arena = createArena({
    chain,
    wallet: walletFor(player),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage,
  });
  await arena.connect();
  storage.setItem(`gnomehall:dev:${player}:root`, signature);

  const opened = await arena.match(matchId("1"));
  assert.equal(opened.action, "move");
  assert.deepEqual(opened.pending?.plans, [cardIDs(picks, engine.cards), cardIDs(braces, engine.cards)]);
  assert.deepEqual(
    opened.planning?.deck,
    [...deck].sort((a, b) => a - b),
  );
});

// The box keeps the deck as a card set, so a deck sealed in the player's order could never
// be revealed: the reveal names the box's deck in card id order.
test("a challenge seals its deck and plan as their reveal will name them", async () => {
  const signature = btoa("a root signature");
  let args: string[] = [];
  const wallet = walletFor(alice, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature } } }),
    DoContract: async ({ messages: [msg] }) => {
      args = v.parse(v.array(v.string()), msg?.value.args);
      return { status: "success" };
    },
  });
  const chain = {
    ...arenaChain(),
    evalJSON: async () => recorded("matches").results,
    typeJSON: async () => load("qtype-MatchSummary"),
  };
  const arena = createArena({
    chain,
    wallet,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    signEachMove: true,
  });
  await arena.connect();
  await arena.authorize();

  const deck = cardIDs(deckA, engine.cards).reverse();
  await arena.challenge({ clan: "Pickers", deck, plan: cardIDs("Chalk Dust,Double Tap", engine.cards) });
  const [clan, deckSeal, planSeal, box] = args;
  assert.equal(clan, "Pickers");
  const opened = await openBox((await deriveKeys(signature, 0, signer)).boxKey, known(box));
  const round1 = view({ ...accepted, Phase: "reveal", ToMove: alice, Plans: [["", "Hammer Blow,Spiked Shield"]] });
  const [, deckText, deckSalt, planText, planSalt] = moveCall(round1, opened, null, engine.cards).args;
  assert.equal(await sealOf(known(deckSalt), known(deckText)), deckSeal);
  assert.equal(await sealOf(known(planSalt), known(planText)), planSeal);
  assert.equal(planText, "Chalk Dust,Double Tap");
});

// gnodev's test1 plays both sides of the recorded match, as its challenger first.
const test1 = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
const rootSigned = btoa("a root signature");
const keysOf = (generation: number) => deriveKeys(rootSigned, generation, signer);
const day = 24 * 60 * 60;
// A session lasts a day from now unless fields say otherwise, as one the page creates does.
const sessionOf = async (generation: number, fields: Partial<Session> = {}): Promise<Session> => ({
  address: (await keysOf(generation)).sessionAddress,
  accountNumber: 20 + generation,
  sequence: 0,
  expiresAt: now + day,
  spendLimit: budget.challenger,
  spendUsed: 0,
  allowPaths: [`vm/exec:${realm}`],
  ...fields,
});
const lockOn = async (generation: number, match: string, expires = now + day): Promise<TestLock> => ({
  Session: (await keysOf(generation)).sessionAddress,
  Match: match,
  Expires: expires,
});
const sessionExpired = (err: unknown) => err instanceof ArenaError && err.type === "sessionExpired";

type PlayerOptions = Partial<Omit<ArenaOptions, "chain" | "wallet" | "signer">> & {
  created?: (request: TxRequest) => Promise<unknown>;
};

// sessionPlayer is test1's arena on chain, with a wallet that signs the root text and
// answers each DoContract with created(request), and a signer that keeps every request.
function sessionPlayer(
  chain: ArenaOptions["chain"],
  { created = async () => ({ status: "success" }), ...options }: PlayerOptions = {},
) {
  const contracts: TxRequest[] = [];
  const signed: SignRequest[] = [];
  const wallet = walletFor(test1, {
    SignArbitrary: async () => ({ status: "success", data: { signature: { signature: rootSigned } } }),
    DoContract: async (request) => {
      contracts.push(request);
      return created(request);
    },
  });
  const recording = { ...signer, signTx: (request: SignRequest) => (signed.push(request), signer.signTx(request)) };
  const arena = createArena({
    chain,
    wallet,
    engine,
    signer: recording,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    now: () => now,
    ...options,
  });
  return { arena, contracts, signed };
}

// accountOf is a connection's account state; a connection with no wallet fails the test.
function accountOf(connection: Connection) {
  assert.ok("mode" in connection, `no wallet connected: ${connection.state}`);
  return connection;
}

// firstLegal is the first plan the engine allows the player who moves in view.
const firstLegal = (view: MatchDetail): number[] => known(engine.legalPlans(known(view.planning))[0]);

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
  assert.deepEqual(contracts[0]?.messages, [
    revokeMessage(test1, known(k0).sessionPubKey),
    revokeMessage(test1, known(k1).sessionPubKey),
    revokeMessage(test1, known(k2).sessionPubKey),
    sessionMessage(test1, known(k3).sessionPubKey, now, realm, budget.challenger, day),
  ]);
  assert.equal(chain.broadcasts, 1);
  const call = known(signed.at(-1));
  assert.equal(call.msgs[0]?.value.func, "Challenge");
  assert.deepEqual(
    [call.privKey, call.sessionAddr, call.accountNumber, call.sequence],
    [known(k3).sessionKey, known(k3).sessionAddress, 41, 0],
  );
  assert.equal(accountOf(await arena.connect()).mode, "session");
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
  assert.equal(contracts[0]?.messages.length, 2);
  assert.equal(contracts[0]?.gasWanted, 6_000_000);
  assert.equal(contracts[0]?.gasFee, 150_000);
});

test("an unlocked session with the role's budget left signs the opening without asking the wallet", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0, { spendUsed: budget.challenger - budget.acceptor }), await sessionOf(1)],
  });
  const { arena, contracts, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.equal(contracts.length, 0);
  assert.equal(signed.at(-1)?.sessionAddr, (await keysOf(1)).sessionAddress);

  await arena.accept(matchId("1"), {
    clan: "Ironhide",
    deck: cardIDs(deckB, engine.cards),
    plan: cardIDs(braces, engine.cards),
  });
  assert.equal(contracts.length, 0);
  assert.equal(signed.at(-1)?.sessionAddr, (await keysOf(0)).sessionAddress);
});

test("with no generation free, the first one revoked takes the new session", async () => {
  // Every generation holds a session: 5 and 9 expired, the others live but short of a budget.
  const short = { spendUsed: budget.challenger - 300_000 };
  const sessions = await Promise.all(
    [...Array(16).keys()].map((g) => sessionOf(g, g === 5 || g === 9 ? { expiresAt: now - 1 } : short)),
  );
  const chain = arenaChain({ sessions });
  const { arena, contracts, signed } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(5, { accountNumber: 77 })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  const [k5, k9] = await Promise.all([5, 9].map(keysOf));
  assert.deepEqual(contracts[0]?.messages, [
    revokeMessage(test1, known(k5).sessionPubKey),
    revokeMessage(test1, known(k9).sessionPubKey),
    sessionMessage(test1, known(k5).sessionPubKey, now, realm, budget.challenger, day),
  ]);
  // The revoked session's account was 25; the chain gives the new one another.
  assert.deepEqual(
    [signed.at(-1)?.sessionAddr, signed.at(-1)?.accountNumber, signed.at(-1)?.sequence],
    [known(k5).sessionAddress, 77, 0],
  );
});

// A read served before the approval's block applies still shows what the chain held before.
test("a new session the chain does not show yet signs nothing", async () => {
  const expiredAt5 = await sessionOf(5, { expiresAt: now - 1 });
  const short = { spendUsed: budget.challenger - 300_000 };
  const full = await Promise.all([...Array(16).keys()].map(async (g) => (g === 5 ? expiredAt5 : sessionOf(g, short))));
  const cases: [string, Session[]][] = [
    ["none", []],
    ["the revoked one", full],
  ];
  for (const [name, sessions] of cases) {
    const chain = arenaChain({ sessions });
    const { arena, contracts } = sessionPlayer(chain);
    await arena.connect();
    await arena.authorize();
    await assert.rejects(
      arena.challenge(opening),
      (err) => err instanceof ArenaError && err.type === "failed" && /not on the chain yet/.test(err.reason),
      name,
    );
    assert.equal(contracts.length, 1, name);
    assert.equal(chain.broadcasts, 0, name);
  }
});

test("an opening neither reuses nor revokes a session locked to a running match", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0)],
    locks: [await lockOn(0, "1")],
    matches: { 1: "match-play" },
  });
  const { arena, contracts, signed } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [...chain.sessionList, await sessionOf(1)];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  const k1 = await keysOf(1);
  assert.deepEqual(
    contracts.map((c) => c.messages),
    [[sessionMessage(test1, k1.sessionPubKey, now, realm, budget.challenger, day)]],
  );
  assert.equal(signed.at(-1)?.sessionAddr, k1.sessionAddress);
});

test("an opening reads only the matches its live sessions are locked to", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0, { expiresAt: now - 1 }), await sessionOf(1), await sessionOf(2)],
    // 0 has expired; 1 was revoked and created again, so its lock is the earlier session's;
    // 3 was revoked.
    locks: [
      await lockOn(0, "5", now - 1),
      await lockOn(1, "6", now + 3600),
      await lockOn(2, "1"),
      await lockOn(3, "7"),
    ],
    matches: { 1: "match-play", 5: "match-play", 6: "match-play", 7: "match-play" },
  });
  const { arena, contracts, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.deepEqual(chain.matchReads, ["1"]);
  assert.equal(contracts.length, 0);
  assert.equal(signed.at(-1)?.sessionAddr, (await keysOf(1)).sessionAddress);
});

test("an opening that cannot read a locked match sends nothing", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0)],
    locks: [await lockOn(0, "1")],
    matches: { 1: new ChainError("network", "fetch failed") },
  });
  const { arena, contracts } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await assert.rejects(arena.challenge(opening), (err) => err instanceof ArenaError && err.type === "network");
  assert.equal(contracts.length, 0);
  assert.equal(chain.broadcasts, 0);
});

test("with every generation holding a session it may not revoke, the wallet signs each move", async () => {
  const elsewhere = { allowPaths: ["vm/exec:gno.land/r/gfanton/gnomehall/arena_v1"] };
  const chain = arenaChain({ sessions: await Promise.all([...Array(16).keys()].map((g) => sessionOf(g, elsewhere))) });
  const { arena, contracts } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  await arena.challenge(opening);
  assert.deepEqual(
    contracts.map((c) => c.messages.map((m) => m.value.func)),
    [["Challenge"]],
  );
  const account = accountOf(await arena.connect());
  assert.equal(account.mode, "contract");
  assert.equal(account.fallback, "Every session this account can hold is used");
});

// Adena answers TRANSACTION_REJECTED when the player rejects a transaction or closes its window.
const rejected = {
  status: "failure",
  type: "TRANSACTION_REJECTED",
  message: "The transaction has been rejected by the user.",
};
// Adena answers UNSUPPORTED_TYPE for a message it cannot sign, such as a session it does not know.
const unsupported = {
  status: "failure",
  type: "UNSUPPORTED_TYPE",
  message: "Adena does not support the requested transaction type.",
};
const refusedCall = (err: unknown) =>
  err instanceof ArenaError && err.type === "refused" && err.reason === rejected.message;

test("a rejected session approval cancels its call, keeps the session mode and opens no second prompt", async () => {
  const chain = await expiredReveal();
  const { arena, contracts } = sessionPlayer(chain, { created: async () => rejected });
  await arena.connect();
  await arena.authorize();
  const calls: [string, () => Promise<unknown>][] = [
    ["challenge", () => arena.challenge(opening)],
    [
      "acceptance",
      () =>
        arena.accept(matchId("1"), {
          clan: "Ironhide",
          deck: cardIDs(deckB, engine.cards),
          plan: cardIDs(braces, engine.cards),
        }),
    ],
    ["renewal", () => arena.renew(matchId("1"))],
  ];
  for (const [name, call] of calls) {
    const prompts = contracts.length;
    await assert.rejects(call(), refusedCall, name);
    assert.deepEqual(
      contracts.slice(prompts).map((c) => c.messages.at(-1)?.type),
      ["/auth.m_create_session"],
      name,
    );
    assert.equal(chain.broadcasts, 0, name);
    assert.equal(arena.account().mode, "session", name);
    assert.equal(arena.account().fallback, null, name);
  }
});

test("a wallet that cannot create sessions signs each move until sessions resume", async () => {
  const chain = arenaChain();
  let attempts = 0;
  const { arena, contracts } = sessionPlayer(chain, {
    created: async (request) => {
      if (request.messages[0]?.type !== "/auth.m_create_session") return { status: "success" };
      attempts++;
      if (attempts === 1) return unsupported;
      chain.sessionList = [await sessionOf(0)];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();

  await arena.challenge(opening);
  assert.deepEqual(
    contracts.map((c) => c.messages[0]?.type),
    ["/auth.m_create_session", "/vm.m_call"],
  );
  const refused = accountOf(await arena.connect());
  assert.equal(refused.mode, "contract");
  assert.equal(refused.fallback, unsupported.message);
  assert.deepEqual(arena.account(), refused);
  assert.deepEqual(await arena.authorize(), refused, "authorizing again keeps the per-move mode");

  const again = arena.resumeSessions();
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
      chain.sessionList = [await sessionOf(0, { spendLimit: budget.acceptor })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  await arena.accept(matchId("1"), {
    clan: "Ironhide",
    deck: cardIDs(deckB, engine.cards),
    plan: cardIDs(braces, engine.cards),
  });
  assert.equal(contracts[0]?.messages[0]?.value.spend_limit, `${budget.acceptor}ugnot`);
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
  assert.equal(contracts[0]?.messages[0]?.value.expires_at, String(now + 30));
});

// expiredReveal is a chain where test1 must reveal in match 1, whose session has expired.
async function expiredReveal(): Promise<ArenaChain> {
  const deck = cardIDs(deckA, engine.cards);
  const box = await sealBox((await keysOf(0)).boxKey, {
    deck,
    deckSalt: newSalt(),
    plan: cardIDs(picks, engine.cards),
    planSalt: newSalt(),
  });
  return arenaChain({
    sessions: [await sessionOf(0, { expiresAt: now - 1 })],
    locks: [await lockOn(0, "1", now - 1)],
    matches: { 1: revealWith(box) },
  });
}

test("a move whose session has expired throws sessionExpired and sends nothing", async () => {
  const chain = await expiredReveal();
  const { arena, contracts } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  const view = await arena.match(matchId("1"));
  assert.equal(view.action, "move");
  assert.equal(view.session, "expired");
  await assert.rejects(arena.move(matchId("1"), firstLegal(view)), sessionExpired);
  assert.equal(chain.broadcasts, 0);
  assert.equal(contracts.length, 0);

  const { arena: byWallet } = sessionPlayer(chain, { signEachMove: true });
  await byWallet.connect();
  await byWallet.authorize();
  assert.equal((await byWallet.match(matchId("1"))).session, "active");
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
  await arena.renew(matchId("1"));
  const [k0, k1] = await Promise.all([0, 1].map(keysOf));
  assert.deepEqual(
    contracts.map((c) => c.messages),
    [
      [
        revokeMessage(test1, known(k0).sessionPubKey),
        sessionMessage(test1, known(k1).sessionPubKey, now, realm, budget.challenger, day),
      ],
    ],
  );
  assert.equal(chain.broadcasts, 0);

  const view = await arena.match(matchId("1"));
  assert.equal(view.session, "active");
  await arena.move(matchId("1"), firstLegal(view));
  assert.equal(chain.broadcasts, 1);
  assert.deepEqual([signed.at(-1)?.sessionAddr, signed.at(-1)?.accountNumber], [known(k1).sessionAddress, 52]);
});

// The chain refuses a move its session cannot pay at the block's gas price and charges
// nothing, so the session's spending never shows it.
test("a match whose session cannot pay the next move at the chain's gas price is expired, and renewing prices the budget", async () => {
  const box = await sealBox((await keysOf(0)).boxKey, {
    deck: cardIDs(deckA, engine.cards),
    deckSalt: newSalt(),
    plan: cardIDs(picks, engine.cards),
    planSalt: newSalt(),
  });
  const left = sessionReserve(floor).later.challenger;
  const chain = arenaChain({
    sessions: [await sessionOf(0, { spendUsed: budget.challenger - left })],
    locks: [await lockOn(0, "1")],
    matches: { 1: revealWith(box) },
  });
  const busy = { ...floor, amount: 5 };
  const { arena, contracts } = sessionPlayer(chain, {
    created: async () => {
      chain.sessionList = [await sessionOf(1, { spendLimit: sessionBudget("challenger", busy) })];
      return { status: "success" };
    },
  });
  await arena.connect();
  await arena.authorize();
  assert.equal((await arena.match(matchId("1"))).session, "active");

  chain.gasPrice = async () => busy;
  const view = await arena.match(matchId("1"));
  assert.equal(view.session, "expired");
  await assert.rejects(arena.move(matchId("1"), firstLegal(view)), sessionExpired);
  assert.equal(chain.broadcasts, 0);

  await arena.renew(matchId("1"));
  const [k0, k1] = await Promise.all([0, 1].map(keysOf));
  assert.deepEqual(
    contracts.map((c) => c.messages),
    [
      [
        revokeMessage(test1, known(k0).sessionPubKey),
        sessionMessage(test1, known(k1).sessionPubKey, now, realm, sessionBudget("challenger", busy), day),
      ],
    ],
  );
  assert.equal((await arena.match(matchId("1"))).session, "active");
});

// A session lasts a day from before the claimer's last move, so it has always expired by the
// time the opponent's deadline passes.
test("a claim, a withdrawal or a resignation with no live session has the wallet sign it", async () => {
  const cases: [string, string, (arena: Arena) => Promise<void>, string][] = [
    ["claim", "match-play", (arena) => arena.claimForfeit(matchId("1")), "ClaimForfeit"],
    ["withdrawal", "match-open", (arena) => arena.resign(matchId("1")), "Resign"],
    ["resignation", "match-play", (arena) => arena.resign(matchId("1")), "Resign"],
  ];
  for (const [name, answer, call, func] of cases) {
    const chain = arenaChain({
      sessions: [await sessionOf(0, { expiresAt: now - 1 })],
      locks: [await lockOn(0, "1", now - 1)],
      matches: { 1: answer },
    });
    const { arena, contracts } = sessionPlayer(chain);
    await arena.connect();
    await arena.authorize();
    await call(arena);
    assert.deepEqual(
      contracts.map((c) => c.messages.map((m) => m.value.func)),
      [[func]],
      name,
    );
    assert.equal(chain.broadcasts, 0, name);
  }
});

// Without the root signature the device derives no session key, so it holds no session.
test("a claim or a resignation on a device without the root signature has the wallet sign it", async () => {
  const cases: [string, (arena: Arena) => Promise<void>, string][] = [
    ["claim", (arena) => arena.claimForfeit(matchId("1")), "ClaimForfeit"],
    ["resignation", (arena) => arena.resign(matchId("1")), "Resign"],
  ];
  for (const [name, call, func] of cases) {
    const chain = arenaChain({
      sessions: [await sessionOf(0)],
      locks: [await lockOn(0, "1")],
      matches: { 1: "match-play" },
    });
    const { arena, contracts } = sessionPlayer(chain);
    assert.equal((await arena.connect()).state, "missing", name);
    await call(arena);
    assert.deepEqual(
      contracts.map((c) => c.messages.map((m) => m.value.func)),
      [[func]],
      name,
    );
    assert.equal(chain.broadcasts, 0, name);
  }
});

// The lobby's account state comes from the arena, so the per-move mode a wallet without
// sessions leaves shows on the page that met it, and on the next one.
test("the lobby shows the per-move mode a wallet without sessions leaves, until sessions resume", async (t) => {
  Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true });
  Object.defineProperty(globalThis, "history", { value: { replaceState() {} }, configurable: true });
  Object.defineProperty(globalThis, "location", {
    value: { pathname: "/", search: "", origin: "http://x" },
    configurable: true,
  });
  const pages: { lobby: ReturnType<typeof createLobby>; dialog: { innerHTML: string } }[] = [];
  // Leaving each lobby stops the watch on the posted match, whose polling would outlive the test.
  t.after(() => {
    for (const { lobby } of pages) void lobby.action("Exit");
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "history");
    Reflect.deleteProperty(globalThis, "location");
  });
  const chain = arenaChain({ matches: { 1: "match-open" } });
  const storage = memory();
  // page loads the lobby with an arena on this device's storage, whose wallet creates no session.
  const page = () => {
    const dialog = {
      innerHTML: "",
      value: "",
      open: false,
      showModal() {},
      close() {},
      addEventListener() {},
      append() {},
    };
    const app = { classList: { add() {}, remove() {} }, dataset: {}, innerHTML: "", querySelector: () => dialog };
    const { arena } = sessionPlayer(chain, {
      storage,
      created: async (request) =>
        request.messages[0]?.type === "/auth.m_create_session" ? unsupported : { status: "success" },
    });
    const lobby = createLobby({ ...unusedPage, app, arena, onRender() {}, onExit() {} });
    const loaded = { lobby, dialog };
    pages.push(loaded);
    return loaded;
  };

  const first = page();
  await first.lobby.action("Authorize");
  assert.equal(accountOf(known(first.lobby.model.account)).mode, "session");
  await first.lobby.sendDraft({ intent: "challenge", opponent: "" }, opening.clan, opening.deck, opening.plan);
  assert.equal(accountOf(known(first.lobby.model.account)).mode, "contract");
  await first.lobby.action("Account");
  assert.match(first.dialog.innerHTML, /Adena does not support the requested transaction type/);
  assert.match(first.dialog.innerHTML, /data-action="onlineResumeSessions"[^>]*>Use sessions again</);

  const reloaded = page();
  await reloaded.lobby.action("Authorize");
  assert.equal(accountOf(known(reloaded.lobby.model.account)).mode, "contract", "connecting keeps the per-move mode");
  await reloaded.lobby.action("ResumeSessions");
  assert.equal(accountOf(known(reloaded.lobby.model.account)).mode, "session");
  assert.equal(accountOf(known(reloaded.lobby.model.account)).fallback, null);
});

// The per-move mode stops new sessions, not the ones the device already holds.
test("in the per-move mode, a move signs with the live session locked to its match, and the wallet signs without one", async () => {
  const box = await sealBox((await keysOf(0)).boxKey, {
    deck: cardIDs(deckA, engine.cards),
    deckSalt: newSalt(),
    plan: cardIDs(picks, engine.cards),
    planSalt: newSalt(),
  });
  const chain = arenaChain({
    sessions: [await sessionOf(0), await sessionOf(1)],
    locks: [await lockOn(0, "1")],
    matches: { 1: revealWith(box), 2: "match-play" },
  });
  const storage = memory();
  storage.setItem(`gnomehall:dev:${test1}:mode`, "contract");
  const { arena, contracts, signed } = sessionPlayer(chain, { storage });
  await arena.connect();
  await arena.authorize();
  assert.equal(arena.account().mode, "contract");

  const locked = await arena.match(matchId("1"));
  await arena.move(matchId("1"), firstLegal(locked));
  assert.equal(contracts.length, 0);
  assert.equal(chain.broadcasts, 1);
  assert.equal(signed.at(-1)?.sessionAddr, (await keysOf(0)).sessionAddress);

  const unlocked = await arena.match(matchId("2"));
  await arena.move(matchId("2"), firstLegal(unlocked));
  assert.deepEqual(
    contracts.map((c) => c.messages.map((m) => m.value.func)),
    [["Play"]],
  );
  assert.equal(chain.broadcasts, 1);
});

test("a move signs with the session locked to its match before an unlocked one", async () => {
  const box = await sealBox((await keysOf(0)).boxKey, {
    deck: cardIDs(deckA, engine.cards),
    deckSalt: newSalt(),
    plan: cardIDs(picks, engine.cards),
    planSalt: newSalt(),
  });
  const chain = arenaChain({
    sessions: [await sessionOf(0), await sessionOf(1)],
    locks: [await lockOn(1, "1")],
    matches: { 1: revealWith(box) },
  });
  const { arena, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  const view = await arena.match(matchId("1"));
  await arena.move(matchId("1"), firstLegal(view));
  assert.equal(signed.at(-1)?.sessionAddr, (await keysOf(1)).sessionAddress);
});

test("session moves go out one at a time, each with the sequence the last one left", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0)],
    locks: [await lockOn(0, "1")],
    matches: { 1: "match-play" },
  });
  const { arena, signed } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  chain.reads.length = 0;

  await Promise.all([arena.resign(matchId("1")), arena.resign(matchId("1"))]);
  assert.deepEqual(chain.reads, [0, 1]);
  // Each move is signed twice, for its simulation and for its fee.
  assert.deepEqual(
    signed.map((r) => r.sequence),
    [0, 0, 1, 1],
  );
});

test("chain and wallet errors become the arena's typed errors", () => {
  const failed = (reason: string) => errorFrom(new ChainError("failed", reason)).type;
  assert.equal(failed("wrong phase"), "wrongPhase");
  assert.equal(failed("not your move"), "wrongPhase");
  assert.equal(failed("seal mismatch"), "sealMismatch");
  assert.equal(failed("illegal plan"), "illegalPlan");
  assert.equal(failed("illegal deck"), "illegalPlan");
  assert.equal(failed("unknown card"), "illegalPlan");
  assert.equal(failed("deadline passed"), "deadlinePassed");
  assert.equal(failed("challenge expired"), "deadlinePassed");
  assert.equal(
    errorFrom(new ChainError("rejected", "session expired: expires_at=1, block_time=2")).type,
    "sessionExpired",
  );
  assert.equal(
    errorFrom(new ChainError("rejected", "session spend limit would be exceeded: attempted=1ugnot")).type,
    "sessionExpired",
  );
  assert.equal(errorFrom(new ChainError("rejected", "unknown session")).type, "sessionExpired");
  assert.equal(failed("session locked to match 3"), "sessionExpired");
  assert.equal(
    errorFrom(new ChainError("rejected", "insufficient funds to pay for fees; 0ugnot < 1ugnot")).type,
    "insufficientFunds",
  );
  assert.equal(errorFrom(new ChainError("network", "fetch failed")).type, "network");
  assert.equal(errorFrom(new WalletError("refused", "User rejected")).type, "refused");
  const other = errorFrom(new ChainError("failed", "something new"));
  assert.equal(other.type, "failed");
  assert.equal(other.reason, "something new");
  assert.equal(errorFrom(new ArenaError("outOfStep", "x")).type, "outOfStep");
});

test("notifications without a gnotif client fail with a readable reason", async () => {
  const arena = createArena({
    chain: arenaChain(),
    wallet: walletFor(alice),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  await arena.connect();
  await assert.rejects(
    arena.notify(),
    (err) =>
      err instanceof ArenaError &&
      err.type === "failed" &&
      err.reason === "Notifications are not set up for this network",
  );
});

// The lobby's pager offers a next page after a full one.
test("the board and a player's matches come 50 a page, the most the realm returns", async () => {
  const asked: string[] = [];
  const chain = {
    ...arenaChain(),
    evalJSON: async (expr: string) => {
      asked.push(expr);
      return recorded(expr.includes(".Open(") ? "open" : "matches").results;
    },
    typeJSON: async (id: string) => load(id.endsWith("OpenChallenge") ? "qtype-OpenChallenge" : "qtype-MatchSummary"),
  };
  const arena = createArena({
    chain,
    wallet: walletFor(alice),
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  await arena.connect();
  await arena.openChallenges(1);
  await arena.myMatches(1);
  assert.deepEqual(asked, [`${realm}.Open(50, 50)`, `${realm}.Matches("${alice}", 50, 50)`]);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// fakeIndexer hands the test the handlers the arena gives the indexer.
function fakeIndexer() {
  const unwatched = () => {
    throw new Error("the arena watches no calls");
  };
  const feed: Indexer & {
    stopped: boolean;
    watched?: string;
    onCall: (call: IndexedCall) => void;
    onState: (state: "up" | "down") => void;
  } = {
    stopped: false,
    onCall: unwatched,
    onState: unwatched,
    watchCalls(watched, onCall, onState = unwatched) {
      Object.assign(feed, { watched, onCall, onState });
      return () => {
        feed.stopped = true;
      };
    },
  };
  return feed;
}

test("subscribe reports each arena call with the match it touches; a new challenge touches none", () => {
  const indexer = fakeIndexer();
  const arena = createArena({
    chain: arenaChain(),
    wallet: null,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    indexer,
  });
  const changes: ArenaChange[] = [];
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
  const arena = createArena({
    chain: arenaChain(),
    wallet: null,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    indexer,
  });
  const changes: ArenaChange[] = [];
  const stop = arena.subscribe((c) => changes.push(c), { interval: 5 });
  await sleep(30);
  assert.deepEqual<ArenaChange[]>(changes, []);

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
  const arena = createArena({
    chain: arenaChain(),
    wallet: null,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
  });
  const changes: ArenaChange[] = [];
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
    ...arenaChain(),
    evalJSON: async () => {
      reads++;
      return recorded("match-play").results;
    },
    typeJSON: async () => load("qtype-MatchView"),
  };
  const indexer = fakeIndexer();
  const arena = createArena({
    chain,
    wallet: null,
    engine,
    signer,
    realm,
    chainId: "dev",
    origin: "http://x",
    storage: memory(),
    indexer,
  });
  const stop = arena.watch(matchId("1"), () => {});
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

// While the indexer answers, nothing but a call to the match makes watch read it again, and
// a session expires without one.
test("watch reads a match again when the session for it expires", async () => {
  // The arena's clock stays put until watch has seen the live session, however long the setup
  // takes, then moves past the expiry; the expiry timer still waits its real second.
  const start = Math.floor(Date.now() / 1000);
  const expires = start + 1;
  let clock = start;
  const chain = arenaChain({
    sessions: [await sessionOf(0, { expiresAt: expires })],
    locks: [await lockOn(0, "1", expires)],
    matches: { 1: "match-play" },
  });
  const { arena } = sessionPlayer(chain, { indexer: fakeIndexer(), now: () => clock });
  await arena.connect();
  await arena.authorize();
  const seen: (ArenaError | string)[] = [];
  const stop = arena.watch(matchId("1"), (view, err) => {
    seen.push(err ?? known(view).session);
    clock = expires + 1;
  });
  for (const start = Date.now(); seen.length < 2 && Date.now() - start < 3000;) await sleep(10);
  stop();
  assert.deepEqual(seen, ["active", "expired"]);
});

test("watch reports a match whose session expires", async () => {
  const chain = arenaChain({
    sessions: [await sessionOf(0)],
    locks: [await lockOn(0, "1")],
    matches: { 1: "match-play" },
  });
  const { arena } = sessionPlayer(chain);
  await arena.connect();
  await arena.authorize();
  const seen: (ArenaError | string)[] = [];
  // reported waits, at most 2 s, until watch has reported count times.
  const reported = async (count: number) => {
    for (const start = Date.now(); seen.length < count && Date.now() - start < 2000;) await sleep(1);
  };
  const stop = arena.watch(
    matchId("1"),
    (view, err) => {
      seen.push(err ?? known(view).session);
    },
    { interval: 5 },
  );
  await reported(1);
  chain.sessionList = [];
  await reported(2);
  stop();
  assert.deepEqual(seen, ["active", "expired"]);
});
