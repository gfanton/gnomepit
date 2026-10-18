// Plays arena matches on a running `make dev`: one with a session per player and match,
// alice's renewed mid-match, then one the wallet signs move by move. Given an indexer, it
// also checks that the indexer's feed reports every call, in order.
//
//   [CHAIN=<chain id>] node client/e2e/match.ts [rpc url] [indexer GraphQL url]

import assert from "node:assert/strict";

import {
  type Arena,
  type ArenaChange,
  type ArenaOptions,
  type Opening,
  createArena,
  sessionLocks,
} from "../web/arena.ts";
import { ChainError, type Session, createChain, payFor } from "../web/chain.ts";
import { type devAccounts, devWallet } from "../web/devwallet.ts";
import { type GameState, type Side, cardOf, startState } from "../web/engine.ts";
import { nodeEngine } from "../web/engine-node.ts";
import { createReader } from "../web/gnovalue.ts";
import type { Address, MatchId } from "../web/ids.ts";
import { createIndexer } from "../web/indexer.ts";
import { networks } from "../web/network.ts";
import * as signer from "../web/signer.ts";
import { type ClanStanding, type Standing, createStandings } from "../web/standings.ts";
import { type SessionKeys, deriveKeys, generations, rootSignature } from "../web/wallet.ts";

const rpc = process.argv[2] ?? networks.local.rpc;
const indexerURL = process.argv[3];
const { realm } = networks.local;
const chainId = process.env.CHAIN ?? networks.local.chainId;
const origin = "http://e2e.local";
// Alice's sessions last this many seconds, so one expires mid-match. Each, the renewed one
// included, must outlast the moves that follow it.
const shortLifetime = 30;

const engine = await nodeEngine();
const chain = createChain({ rpc });

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, value) => items.set(k, String(value)) };
}

function player(
  name: keyof typeof devAccounts,
  options: Partial<Pick<ArenaOptions, "sessionLifetime" | "signEachMove">> = {},
): Arena {
  const wallet = devWallet({ name, signer, chain, chainId });
  return createArena({ chain, wallet, engine, signer, realm, chainId, origin, storage: memory(), ...options });
}

const read = createReader(chain);
const locksOn = async (address: Address, id: MatchId) =>
  (await sessionLocks(read, realm, address)).filter((l) => l.Match === id);

const deckOf = (clan: string): number[] => {
  const pool = engine.clans.find((c) => c.name === clan);
  assert.ok(pool !== undefined, `the engine deals no clan ${clan}`);
  const { cards } = pool;
  if (cards.slice(0, 8).some((id) => cardOf(engine.cards, id).rare)) return cards.slice(0, 8);
  const rare = cards.find((id) => cardOf(engine.cards, id).rare);
  assert.ok(rare !== undefined, `${clan} has no Rare`);
  return [...cards.slice(0, 7), rare];
};
const decks = { a: deckOf("Pickers"), b: deckOf("Ironhide") };
for (const [clan, deck] of [
  ["Pickers", decks.a],
  ["Ironhide", decks.b],
] as const)
  assert.equal(engine.legalDeck({ clan, deck }), true);

// planFor picks a legal plan that spends a special when one is left, so rounds differ.
function planFor(state: GameState, side: Side, deck: number[]): number[] {
  const plans = engine.legalPlans({ state, side, deck });
  const plan = plans.find((p) => p.some((id) => cardOf(engine.cards, id).special)) ?? plans[0];
  assert.ok(plan !== undefined, "the engine lists no legal plan");
  return plan;
}
const start = startState(engine.hp);
const openings: [Opening, Opening] = [
  { clan: "Pickers", deck: decks.a, plan: planFor(start, 0, decks.a) },
  { clan: "Ironhide", deck: decks.b, plan: planFor(start, 1, decks.b) },
];

const log = (...line: unknown[]) => console.log(...line);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unixNow = () => Math.floor(Date.now() / 1000);

async function ready(name: string, arena: Arena): Promise<Address> {
  const before = await arena.connect();
  const after = await arena.authorize();
  log(
    `${name}: ${before.state} -> ${after.state} (${after.mode})${(after.fallback ?? "") === "" ? "" : `, fallback: ${after.fallback}`}`,
  );
  assert.equal(after.state, "active");
  assert.ok(after.address !== null, `${name} is connected`);
  return after.address;
}

// The feed's first change, {}, comes once the indexer has taken the subscription.
const feed: Extract<ArenaChange, { func: string }>[] = [];
let stopFeed = () => {};
if (indexerURL !== undefined) {
  const watcher = createArena({
    chain,
    wallet: null,
    engine,
    signer,
    realm,
    chainId,
    origin,
    storage: memory(),
    indexer: createIndexer({ url: indexerURL }),
  });
  await new Promise<void>((resolve) => {
    stopFeed = watcher.subscribe((change) => {
      if ("func" in change) feed.push(change);
      else resolve();
    });
  });
}
// Every arena call that lands, as [func, match], match being null for a challenge.
const sent: [string, MatchId | null][] = [];

async function post(arena: Arena): Promise<MatchId> {
  const id = await arena.challenge(openings[0]);
  sent.push(["Challenge", null]);
  log(`match ${id} posted`);
  return id;
}

async function accept(arena: Arena, id: MatchId): Promise<void> {
  assert.equal((await arena.openChallenges()).find((c) => c.ID === id)?.action, "accept");
  await arena.accept(id, openings[1]);
  sent.push(["Accept", id]);
  log(`match ${id} accepted`);
}

// play takes match id from its acceptance to its end, a revealing and b playing;
// afterRound1 runs once round 1 is resolved.
async function play(id: MatchId, a: Arena, b: Arena, afterRound1 = async () => {}): Promise<void> {
  for (let moves = 0; moves < 10; moves++) {
    const va = await a.match(id);
    if (va.Phase === "ended") break;
    if (va.action === "move") {
      const { pending } = va;
      assert.ok(pending !== undefined, `alice's move in match ${id} comes with her opened clash`);
      log(`alice reveals round ${va.Round} (${pending.result}) and seals the next`);
      await a.move(id, planFor(pending.state, 0, decks.a));
      sent.push(["Reveal", id]);
      if (va.Round === 1) await afterRound1();
    } else if (va.action === "finish") {
      log(`alice reveals round ${va.Round}, the last`);
      await a.finish(id);
      sent.push(["Reveal", id]);
    }
    const vb = await b.match(id);
    if (vb.action === "move") {
      log(`bob plays round ${vb.Round}`);
      await b.move(id, planFor(vb.state, 1, decks.b));
      sent.push(["Play", id]);
    }
  }
  const seenByA = await a.match(id);
  const seenByB = await b.match(id);
  assert.equal(seenByA.Phase, "ended");
  assert.equal(seenByA.Result, seenByB.Result);
  assert.equal(seenByA.action, "done");
  assert.equal(seenByA.rounds.at(-1)?.result, seenByA.Result, "the page's replay ends the match the way the realm did");
  log(`match ${id} ended: ${seenByA.Result} by ${seenByA.Reason}, HP ${JSON.stringify(seenByA.HP)}`);
}

// forceCall sends the arena call func(args) signed with session, a session of master's that
// the arena itself would not pick, and returns the chain's refusal.
async function forceCall(
  master: Address,
  root: string,
  session: Session,
  func: string,
  args: string[],
): Promise<string> {
  let keys: SessionKeys | undefined;
  for (let g = 0; g < generations && keys === undefined; g++) {
    const k = await deriveKeys(root, g, signer);
    if (k.sessionAddress === session.address) keys = k;
  }
  assert.ok(keys !== undefined, "the session's key is one of the root signature's generations");
  const msg = { type: "/vm.m_call", value: { caller: master, send: "", max_deposit: "", pkg_path: realm, func, args } };
  const request = {
    chainId,
    accountNumber: session.accountNumber,
    sequence: session.sequence,
    privKey: keys.sessionKey,
    sessionAddr: keys.sessionAddress,
    memo: "",
    msgs: [msg],
  };
  try {
    await chain.broadcast(await payFor(chain, (fee) => signer.signTx({ ...request, fee })));
  } catch (err) {
    if (err instanceof ChainError) return err.reason;
    throw err;
  }
  assert.fail(`the chain took ${func} from a locked session`);
}

// ---- Sessions

const alice = player("alice", { sessionLifetime: shortLifetime });
const bob = player("bob");
const aliceAddress = await ready("alice", alice);
const bobAddress = await ready("bob", bob);

const standings = createStandings({ chain, realm });
const standingsBefore = {
  alice: await standings.standing(aliceAddress),
  bob: await standings.standing(bobAddress),
  clans: await standings.clanStandings(),
};

const id = await post(alice);
assert.equal(alice.account().mode, "session", "alice's challenge got a session");
const [first] = await locksOn(aliceAddress, id);
assert.ok(first !== undefined, `Locks lists alice's lock on match ${id}`);
log(`alice's session ${first.Session} is locked to match ${id}`);

const firstSession = (await chain.sessions(aliceAddress)).find(
  (s) => s.address === first.Session && s.expiresAt === first.Expires,
);
assert.ok(firstSession !== undefined, `the chain lists the session locked to match ${id}`);
// The dev wallet signs the root text the same way every time, so this is the arena's root.
const root = await rootSignature(devWallet({ name: "alice", signer, chain, chainId }), aliceAddress, origin);
const seal = "ab".repeat(32);
const refusal = await forceCall(aliceAddress, root, firstSession, "Challenge", ["Pickers", seal, seal, "AAAA", ""]);
assert.match(refusal, new RegExp(`session locked to match ${id}$`));
log(`a second challenge with that session: ${refusal}`);
// Alice's wallet posts a match of her own, where that session may not act either.
const aliceByWallet = player("alice", { signEachMove: true });
await ready("alice", aliceByWallet);
const elsewhere = await post(aliceByWallet);
const resignation = await forceCall(aliceAddress, root, firstSession, "Resign", [elsewhere]);
assert.match(resignation, new RegExp(`session locked to match ${id}$`));
log(`a resignation in match ${elsewhere} with that session: ${resignation}`);

await accept(bob, id);
assert.equal(bob.account().mode, "session", "bob's acceptance got a session");
assert.equal((await locksOn(bobAddress, id)).length, 1, `Locks lists bob's lock on match ${id}`);
log(`bob's session is locked to match ${id}`);

let renewedAfterRound1 = false;
await play(id, alice, bob, async () => {
  const wait = (first.Expires + 1) * 1000 - Date.now();
  log(`waiting ${Math.ceil(wait / 1000)} s for alice's session to expire`);
  await sleep(wait);
  const view = await alice.match(id);
  assert.notEqual(view.Phase, "ended", "the match goes on after round 1");
  assert.equal(view.session, "expired");
  await alice.renew(id);
  assert.equal((await alice.match(id)).session, "active");
  const sessions = await chain.sessions(aliceAddress);
  assert.ok(
    !sessions.some((s) => s.address === first.Session && s.expiresAt === first.Expires),
    "renewing revoked the expired session",
  );
  log(`alice renewed her session for match ${id}, revoking the expired one`);
  renewedAfterRound1 = true;
});
assert.ok(renewedAfterRound1, `match ${id} went past round 1, so alice's session expired and was renewed`);

// The renewed session's first move locked it and dropped the expired session's lock.
const renewedLocks = await locksOn(aliceAddress, id);
assert.equal(renewedLocks.length, 1, `Locks lists one lock of alice's on match ${id}`);
const [renewed] = renewedLocks;
assert.ok(renewed !== undefined, `Locks lists the renewed session's lock on match ${id}`);
assert.notDeepEqual(
  [renewed.Session, renewed.Expires],
  [first.Session, first.Expires],
  `the renewed session holds the lock on match ${id}`,
);
assert.ok(renewed.Expires > unixNow(), "the renewed session is live, so only its ended match can make it dead");

const second = await post(alice);
const [next] = await locksOn(aliceAddress, second);
assert.ok(next !== undefined, `Locks lists alice's lock on match ${second}`);
assert.notDeepEqual(
  [next.Session, next.Expires],
  [renewed.Session, renewed.Expires],
  `match ${second} has a session of its own`,
);
const sessions = await chain.sessions(aliceAddress);
assert.ok(
  !sessions.some((s) => s.address === renewed.Session && s.expiresAt === renewed.Expires),
  `posting match ${second} revoked the session of ended match ${id}`,
);
log(`match ${second} got session ${next.Session}, revoking ${renewed.Session} of ended match ${id}`);

// ---- The wallet signs each move

const bobByWallet = player("bob", { signEachMove: true });
await ready("bob", bobByWallet);
const third = await post(aliceByWallet);
await accept(bobByWallet, third);
await play(third, aliceByWallet, bobByWallet);
for (const address of [aliceAddress, bobAddress])
  assert.deepEqual(await locksOn(address, third), [], "a wallet-signed call locks nothing");

// ---- Standings: matches id and third ended on HP, Pickers against Ironhide

const played = (s: Standing) => s.Wins + s.Losses + s.Draws;
const clanIn = (list: ClanStanding[], clan: string): ClanStanding => {
  const found = list.find((c) => c.Clan === clan);
  assert.ok(found !== undefined, `ClanStandings lists ${clan}`);
  return found;
};
const record = (s: Standing | ClanStanding) => [s.Wins, s.Losses, s.Draws];
const moved = (after: Standing | ClanStanding, before: Standing | ClanStanding) =>
  record(after).map((n, i) => n - (record(before)[i] ?? 0));
const standingsAfter = {
  alice: await standings.standing(aliceAddress),
  bob: await standings.standing(bobAddress),
  clans: await standings.clanStandings(),
};
assert.equal(
  played(standingsAfter.alice) - played(standingsBefore.alice),
  2,
  "alice's two finished matches were rated",
);
assert.equal(played(standingsAfter.bob) - played(standingsBefore.bob), 2, "bob's two finished matches were rated");
const [aliceWon, aliceLost, aliceDrew] = moved(standingsAfter.alice, standingsBefore.alice);
assert.deepEqual(
  moved(standingsAfter.bob, standingsBefore.bob),
  [aliceLost, aliceWon, aliceDrew],
  "bob's record mirrors alice's",
);
if (standingsAfter.alice.Rating > 0 && standingsAfter.bob.Rating > 0)
  assert.equal(
    standingsAfter.alice.Rating - standingsBefore.alice.Rating + standingsAfter.bob.Rating - standingsBefore.bob.Rating,
    0,
    "the two ratings moved by opposite amounts",
  );
if ((await standings.ratedPlayers()) === 2) {
  assert.equal(standingsAfter.alice.MainClan, "Pickers");
  assert.equal(standingsAfter.bob.MainClan, "Ironhide");
}
for (const [clan, player] of [
  ["Pickers", "alice"],
  ["Ironhide", "bob"],
] as const)
  assert.deepEqual(
    moved(clanIn(standingsAfter.clans, clan), clanIn(standingsBefore.clans, clan)),
    moved(standingsAfter[player], standingsBefore[player]),
    `${clan}'s record moved with ${player}'s`,
  );
assert.deepEqual(
  record(clanIn(standingsAfter.clans, "Delvers")),
  record(clanIn(standingsBefore.clans, "Delvers")),
  "Delvers played no match",
);
log(
  `standings: alice ${standingsAfter.alice.Rating} (#${standingsAfter.alice.Rank}), bob ${standingsAfter.bob.Rating} (#${standingsAfter.bob.Rank})`,
);

if (indexerURL !== undefined) {
  const calls = () => feed.map((c) => [c.func, c.match]);
  for (let waited = 0; waited < 15_000 && feed.length < sent.length; waited += 250) await sleep(250);
  stopFeed();
  assert.deepEqual(calls(), sent, "the indexer's feed reports every call, in order");
  log(`the indexer reported all ${sent.length} calls`);
}
process.exit(0);
