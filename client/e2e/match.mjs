// Plays arena matches on a running `make dev`: one with a session per player and match,
// alice's renewed mid-match, then one the wallet signs move by move. Given an indexer, it
// also checks that the indexer's feed reports every call, in order.
//
//   [CHAIN=<chain id>] node client/e2e/match.mjs [rpc url] [indexer GraphQL url]

import assert from "node:assert/strict";

import { createArena } from "../web/arena.mjs";
import { createChain, payFor } from "../web/chain.mjs";
import { devWallet } from "../web/devwallet.mjs";
import { nodeEngine } from "../web/engine-node.mjs";
import { decode, structTypes, typeFields } from "../web/gnovalue.mjs";
import { createIndexer } from "../web/indexer.mjs";
import * as signer from "../web/signer.mjs";
import { deriveKeys, generations } from "../web/wallet.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:36657";
const indexerURL = process.argv[3];
const realm = "gno.land/r/gfanton/gnomehall/arena";
const chainId = process.env.CHAIN ?? "gnomehall-dev";
// Alice's sessions last this many seconds, so one expires mid-match.
const shortLifetime = 30;

const engine = await nodeEngine();
const chain = createChain({ rpc });

function memory() {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
}

function player(name, options = {}) {
  const wallet = devWallet({ name, signer, chain, chainId });
  return createArena({ chain, wallet, engine, signer, realm, chainId, origin: "http://e2e.local", storage: memory(), ...options });
}

const fields = new Map();
async function read(expr) {
  const [result] = await chain.evalJSON(expr);
  for (const id of structTypes(result)) {
    if (!fields.has(id)) for (const [type, names] of typeFields(await chain.typeJSON(id))) fields.set(type, names);
  }
  return decode(result, fields);
}
const locksOn = async (address, id) => (await read(`${realm}.Locks("${address}")`)).filter((l) => l.Match === id);

const deckOf = (clan) => {
  const { cards } = engine.clans.find((c) => c.name === clan);
  return cards.slice(0, 8).some((id) => engine.cards[id].rare) ? cards.slice(0, 8) : [...cards.slice(0, 7), cards.find((id) => engine.cards[id].rare)];
};
const decks = { a: deckOf("Pickers"), b: deckOf("Ironhide") };
for (const [clan, deck] of [["Pickers", decks.a], ["Ironhide", decks.b]]) assert.equal(engine.legalDeck({ clan, deck }), true);

// planFor picks a legal plan that spends a special when one is left, so rounds differ.
function planFor(state, side, deck) {
  const plans = engine.legalPlans({ state, side, deck });
  return plans.find((p) => p.some((id) => engine.cards[id].special)) ?? plans[0];
}
const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) };
const openings = [
  { clan: "Pickers", deck: decks.a, plan: planFor(start, 0, decks.a) },
  { clan: "Ironhide", deck: decks.b, plan: planFor(start, 1, decks.b) },
];

const log = (...line) => console.log(...line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unixNow = () => Math.floor(Date.now() / 1000);

async function ready(name, arena) {
  const before = await arena.connect();
  const after = await arena.authorize();
  log(`${name}: ${before.state} -> ${after.state} (${after.mode})${after.fallback ? `, fallback: ${after.fallback}` : ""}`);
  assert.equal(after.state, "active");
  return after.address;
}

// The feed's first change, {}, comes once the indexer has taken the subscription.
const feed = [];
let stopFeed = () => {};
if (indexerURL !== undefined) {
  const watcher = createArena({ chain, wallet: null, engine, realm, chainId, origin: "http://e2e.local", storage: memory(), indexer: createIndexer({ url: indexerURL }) });
  await new Promise((resolve) => {
    stopFeed = watcher.subscribe((change) => (change.func === undefined ? resolve() : feed.push(change)));
  });
}
// Every arena call that lands, as [func, match], match being null for a challenge.
const sent = [];

async function post(arena) {
  const id = await arena.challenge(openings[0]);
  sent.push(["Challenge", null]);
  log(`match ${id} posted`);
  return id;
}

async function accept(arena, id) {
  assert.equal((await arena.openChallenges()).find((c) => c.ID === id)?.action, "accept");
  await arena.accept(id, openings[1]);
  sent.push(["Accept", id]);
  log(`match ${id} accepted`);
}

// play takes match id from its acceptance to its end, a revealing and b playing;
// afterRound1 runs once round 1 is resolved.
async function play(id, a, b, afterRound1 = async () => {}) {
  for (let moves = 0; moves < 10; moves++) {
    const va = await a.match(id);
    if (va.Phase === "ended") break;
    if (va.action === "move") {
      log(`alice reveals round ${va.Round} (${va.pending.result}) and seals the next`);
      await a.move(id, planFor(va.pending.state, 0, decks.a));
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
  assert.equal(seenByA.rounds.at(-1).result, seenByA.Result, "the page's replay ends the match the way the realm did");
  log(`match ${id} ended: ${seenByA.Result} by ${seenByA.Reason}, HP ${JSON.stringify(seenByA.HP)}`);
}

// forceChallenge sends a Challenge signed with session, a session of master's that the
// arena itself would not pick, and returns the chain's refusal.
async function forceChallenge(master, root, session) {
  let keys;
  for (let g = 0; g < generations && keys === undefined; g++) {
    const k = await deriveKeys(root, g, signer);
    if (k.sessionAddress === session.address) keys = k;
  }
  assert.ok(keys !== undefined, "the session's key is one of the root signature's generations");
  const seal = "ab".repeat(32);
  const msg = { type: "/vm.m_call", value: { caller: master, send: "", max_deposit: "", pkg_path: realm, func: "Challenge", args: ["Pickers", seal, seal, "AAAA", ""] } };
  const request = { chainId, accountNumber: session.accountNumber, sequence: session.sequence, privKey: keys.sessionKey, sessionAddr: keys.sessionAddress, memo: "", msgs: [msg] };
  try {
    await chain.broadcast(await payFor(chain, (fee) => signer.signTx({ ...request, fee })));
  } catch (err) {
    return err.reason;
  }
  assert.fail("the chain took a second challenge from a locked session");
}

// ---- Sessions

const aliceStorage = memory();
const alice = player("alice", { storage: aliceStorage, sessionLifetime: shortLifetime });
const bob = player("bob");
const aliceAddress = await ready("alice", alice);
const bobAddress = await ready("bob", bob);

const id = await post(alice);
assert.equal((await alice.account()).mode, "session", "alice's challenge got a session");
const [first] = await locksOn(aliceAddress, id);
assert.ok(first !== undefined, `Locks lists alice's lock on match ${id}`);
log(`alice's session ${first.Session} is locked to match ${id}`);

const firstSession = (await chain.sessions(aliceAddress)).find((s) => s.address === first.Session && s.expiresAt === first.Expires);
const refusal = await forceChallenge(aliceAddress, aliceStorage.getItem(`gnomehall:${chainId}:${aliceAddress}:root`), firstSession);
assert.match(refusal, new RegExp(`session locked to match ${id}$`));
log(`a second challenge with that session: ${refusal}`);

await accept(bob, id);
assert.equal((await bob.account()).mode, "session", "bob's acceptance got a session");
assert.equal((await locksOn(bobAddress, id)).length, 1, `Locks lists bob's lock on match ${id}`);
log(`bob's session is locked to match ${id}`);

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
  assert.ok(!sessions.some((s) => s.address === first.Session && s.expiresAt === first.Expires), "renewing revoked the expired session");
  log(`alice renewed her session for match ${id}, revoking the expired one`);
});

// The renewed session's first move locked it and dropped the expired session's lock.
const renewedLocks = await locksOn(aliceAddress, id);
assert.equal(renewedLocks.length, 1);
const [renewed] = renewedLocks;
assert.notDeepEqual([renewed.Session, renewed.Expires], [first.Session, first.Expires]);
assert.ok(renewed.Expires > unixNow(), "the renewed session is live, so only its ended match can make it dead");

const second = await post(alice);
const [next] = await locksOn(aliceAddress, second);
assert.ok(next !== undefined, `Locks lists alice's lock on match ${second}`);
assert.notDeepEqual([next.Session, next.Expires], [renewed.Session, renewed.Expires], `match ${second} has a session of its own`);
const sessions = await chain.sessions(aliceAddress);
assert.ok(!sessions.some((s) => s.address === renewed.Session && s.expiresAt === renewed.Expires), `posting match ${second} revoked the session of ended match ${id}`);
log(`match ${second} got session ${next.Session}, revoking ${renewed.Session} of ended match ${id}`);

// ---- The wallet signs each move

const aliceByWallet = player("alice", { signEachMove: true });
const bobByWallet = player("bob", { signEachMove: true });
await ready("alice", aliceByWallet);
await ready("bob", bobByWallet);
const third = await post(aliceByWallet);
await accept(bobByWallet, third);
await play(third, aliceByWallet, bobByWallet);
for (const address of [aliceAddress, bobAddress]) assert.deepEqual(await locksOn(address, third), [], "a wallet-signed call locks nothing");

if (indexerURL !== undefined) {
  const calls = () => feed.map((c) => [c.func, c.match]);
  for (let waited = 0; waited < 15_000 && feed.length < sent.length; waited += 250) await sleep(250);
  stopFeed();
  assert.deepEqual(calls(), sent, "the indexer's feed reports every call, in order");
  log(`the indexer reported all ${sent.length} calls`);
}
process.exit(0);
