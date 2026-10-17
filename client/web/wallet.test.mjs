import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { nodeEngine } from "./engine-node.mjs";
import * as signer from "./signer.mjs";
import {
  WalletError, classifySessions, connect, deriveKeys, generations, lockedMatches, newSalt, openBox, revokeMessage, rootText, sealBox, sealOf,
  sessionBudget, sessionMessage, sessionReserve, waitForAdena,
} from "./wallet.mjs";

const engine = await nodeEngine();
// gnodev's gas price, 1 ugnot per 1,000 gas, at which client/ONLINE.md works the budgets out.
const floor = { gas: 1000, amount: 1, denom: "ugnot" };
const busy = { ...floor, amount: 5 };
const signature = btoa("a root signature of 64 bytes, as a wallet would return one....");
const otherSignature = btoa("another root signature, from another wallet or another site....");
const realm = "gno.land/r/gfanton/gnomehall/arena";
const now = 1_800_000_000;

const failure = (type) => (err) => err instanceof WalletError && err.type === type;

test("waitForAdena returns Adena once the extension injects it, and nothing without it", async (t) => {
  globalThis.window = {};
  t.after(() => delete globalThis.window);
  assert.equal(await waitForAdena(0), undefined);
  const adena = { AddEstablish() {} };
  setTimeout(() => (globalThis.window.adena = adena), 100);
  assert.equal(await waitForAdena(2000), adena);
});

test("the root text names Gnomehall and the site", () => {
  assert.equal(
    rootText("http://127.0.0.1:8080"),
    "Gnomehall at http://127.0.0.1:8080\nSign once on each device to play online. This signs no transaction.",
  );
});

test("keys derive the same from the same signature, per generation", async () => {
  const a = await deriveKeys(signature, 0, signer);
  const b = await deriveKeys(signature, 0, signer);
  const next = await deriveKeys(signature, 1, signer);
  assert.equal(a.sessionKey, b.sessionKey);
  assert.match(a.sessionKey, /^[0-9a-f]{64}$/);
  assert.equal(a.sessionAddress, (await signer.keyInfo(a.sessionKey)).address);
  assert.notEqual(next.sessionAddress, a.sessionAddress);
});

test("a box opens with the keys that sealed it, and only with them", async () => {
  const { boxKey } = await deriveKeys(signature, 0, signer);
  const contents = { plan: [0, 0, 0], planSalt: newSalt() };
  const box = await sealBox(boxKey, contents);
  assert.deepEqual(await openBox(boxKey, box), contents);
  assert.deepEqual(await openBox((await deriveKeys(signature, 3, signer)).boxKey, box), contents);

  const other = await deriveKeys(otherSignature, 0, signer);
  await assert.rejects(openBox(other.boxKey, box), failure("box"));
  await assert.rejects(openBox(boxKey, "not a box"), failure("box"));
});

const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) };
const boxSize = (box) => atob(box).length;

// The realm takes boxes of at most 104 bytes. The deck travels as a card set, so it comes
// back in card id order, which is the order its seal must name it in.
test("every legal round-1 plan of each clan fits a box, round 1 in 104 bytes and later rounds in 64", async () => {
  const { boxKey } = await deriveKeys(signature, 0, signer);
  for (const { name, cards: pool } of engine.clans) {
    const plans = engine.legalPlans({ state: start, side: 0, deck: pool });
    assert.ok(plans.length > 0, name);
    const deck = [...pool].reverse();
    for (const plan of plans) {
      const round1 = { deck, deckSalt: newSalt(), plan, planSalt: newSalt() };
      const box = await sealBox(boxKey, round1);
      assert.ok(boxSize(box) <= 104, `${name} ${plan}: ${boxSize(box)} bytes`);
      assert.deepEqual(await openBox(boxKey, box), { ...round1, deck: [...pool].sort((a, b) => a - b) });

      const later = { plan, planSalt: newSalt() };
      const laterBox = await sealBox(boxKey, later);
      assert.ok(boxSize(laterBox) <= 64, `${name} ${plan}: ${boxSize(laterBox)} bytes`);
      assert.deepEqual(await openBox(boxKey, laterBox), later);
    }
  }
});

// sealContents seals raw contents with the box key, the way sealBox wraps its own.
async function sealContents(boxKey, contents) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, boxKey, contents));
  return btoa(String.fromCharCode(...iv, ...sealed));
}

test("a box whose contents are not a plan, or a deck and a plan, is refused", async () => {
  const { boxKey } = await deriveKeys(signature, 0, signer);
  const salt = Array(32).fill(7);
  const deck = Array(8).fill(0);
  const refused = [
    [], salt, [...salt, 0], [...salt, 2, 0], [...salt, 4, 0, 0, 0, 0], Array(50).fill(1),
    [...salt, ...salt, ...deck], [...salt, ...salt, ...deck, 0], [...salt, ...salt, ...deck, 1], [...salt, ...salt, ...deck, 4, 0, 0, 0, 0],
    [...new TextEncoder().encode(JSON.stringify({ plan: "Pick,Pick,Pick", planSalt: "00".repeat(32) }))],
  ];
  for (const contents of refused) {
    await assert.rejects(openBox(boxKey, await sealContents(boxKey, new Uint8Array(contents))), failure("box"), `${contents.length} bytes`);
  }
});

test("a seal is the sha256 of the salt's bytes and the text", async () => {
  const salt = newSalt();
  const want = createHash("sha256").update(Buffer.from(salt, "hex")).update("Pick,Pick,Pick").digest("hex");
  assert.equal(await sealOf(salt, "Pick,Pick,Pick"), want);
});

test("a new salt is 32 random bytes in hex", () => {
  assert.match(newSalt(), /^[0-9a-f]{64}$/);
  assert.notEqual(newSalt(), newSalt());
});

test("a session message lets the session key call the arena alone, for its lifetime and spend limit", async () => {
  const keys = await deriveKeys(signature, 0, signer);
  const { type, value } = sessionMessage("g1master", keys.sessionPubKey, now, realm, sessionBudget("challenger", floor), 30);
  assert.equal(type, "/auth.m_create_session");
  assert.equal(value.creator, "g1master");
  assert.equal(value.session_key.type_url, "/tm.PubKeySecp256k1");
  const wrapped = Uint8Array.from(atob(value.session_key.value), (c) => c.charCodeAt(0));
  assert.deepEqual([...wrapped.subarray(0, 2)], [0x0a, 33]);
  assert.equal(btoa(String.fromCharCode(...wrapped.subarray(2))), keys.sessionPubKey);
  assert.equal(value.expires_at, String(now + 30));
  assert.deepEqual(value.allow_paths, [`vm/exec:${realm}`]);
  assert.equal(value.spend_limit, `${sessionBudget("challenger", floor)}ugnot`);
  assert.equal(value.spend_period, "0");
});

// The golden revoke was built with the chain's own Go types, for the golden session key.
test("a revoke message names the session key as the chain's own revoke does", async () => {
  const golden = JSON.parse(readFileSync(new URL("./testdata/golden-tx.json", import.meta.url)));
  const request = (name) => golden.find((c) => c.name === name).request;
  const { pubKey } = await signer.keyInfo(request("session-call").privKey);
  const revoke = request("create-and-revoke").msgs.find((m) => m.type === "/auth.m_revoke_session");
  assert.deepEqual(revokeMessage(revoke.value.creator, pubKey), revoke);
});

const keys = new Map();
for (let generation = 0; generation < generations; generation++) keys.set(generation, await deriveKeys(signature, generation, signer));
const addressOf = (generation) => keys.get(generation).sessionAddress;
const sessionAt = (generation, fields = {}) => ({
  address: addressOf(generation),
  accountNumber: 9, sequence: 2, expiresAt: now + 3600, spendLimit: sessionBudget("challenger", floor), spendUsed: 0, allowPaths: [`vm/exec:${realm}`], ...fields,
});
const lockOf = (generation, match, expires = now + 3600) => ({ Session: addressOf(generation), Match: match, Expires: expires });
const classify = (onChain, locks = [], matches = new Map(), price = floor) =>
  classifySessions({ onChain, keys, locks, matches, now, realm, reserve: sessionReserve(price) });
const reserve = sessionReserve(floor);
const budget = sessionBudget("challenger", floor);

test("at the floor price, the budgets and reserves are client/ONLINE.md's", () => {
  assert.equal(sessionBudget("challenger", floor), 654_056);
  assert.equal(sessionBudget("acceptor", floor), 535_923);
  assert.deepEqual(reserve, { opening: { challenger: 262_607, acceptor: 245_023 }, later: { challenger: 59_036, acceptor: 25_555 } });
});

// Deposits are priced per byte and stay; only the fees follow the gas price.
test("at five times the floor price, budgets and reserves pay five times the fees and the same deposits", () => {
  assert.equal(sessionBudget("challenger", busy), 1_315_067);
  assert.equal(sessionBudget("acceptor", busy), 957_202);
  assert.deepEqual(sessionReserve(busy), { opening: { challenger: 335_431, acceptor: 363_911 }, later: { challenger: 295_177, acceptor: 127_767 } });
});

// The chain refuses a move the session can no longer pay at the price of its block, and
// charges nothing, so only the price tells the page the session is used up.
test("a session live at the floor price is dead at five times that price", () => {
  const sessions = [sessionAt(0, { spendUsed: budget - reserve.later.challenger }), sessionAt(1, { spendUsed: budget - reserve.opening.challenger })];
  const locks = [lockOf(0, "4")];
  const running = new Map([["4", { phase: "reveal", role: "challenger" }]]);
  const atFloor = classify(sessions, locks, running);
  assert.equal(atFloor.byMatch.get("4").generation, 0);
  assert.deepEqual(generationsOf(atFloor.unlocked), [1]);
  const atFive = classify(sessions, locks, running, busy);
  assert.equal(atFive.byMatch.size, 0);
  assert.deepEqual(atFive.unlocked, []);
  assert.deepEqual(generationsOf(atFive.dead), [0, 1]);
});
const generationsOf = (entries) => entries.map((e) => e.generation);
const allBut = (...taken) => [...keys.keys()].filter((g) => !taken.includes(g));

test("a live session locked to a running match is that match's, and a live one locked to none is unlocked", () => {
  const out = classify([sessionAt(0), sessionAt(1)], [lockOf(0, "4")], new Map([["4", { phase: "play", role: "acceptor" }]]));
  assert.deepEqual([...out.byMatch.keys()], ["4"]);
  assert.equal(out.byMatch.get("4").generation, 0);
  assert.equal(out.byMatch.get("4").session.address, addressOf(0));
  assert.equal(out.byMatch.get("4").keys, keys.get(0));
  assert.deepEqual(generationsOf(out.unlocked), [1]);
  assert.deepEqual(out.dead, []);
  assert.deepEqual(generationsOf(out.free), allBut(0, 1));
});

test("an expired or used-up session is dead, locked or not", () => {
  const running = new Map([["4", { phase: "reveal", role: "challenger" }]]);
  const usedUp = { spendUsed: budget - reserve.opening.acceptor + 1 };
  const out = classify(
    [sessionAt(0, { expiresAt: now }), sessionAt(1, usedUp), sessionAt(2, { expiresAt: now - 1 })],
    [lockOf(2, "4", now - 1)],
    running,
  );
  assert.deepEqual(generationsOf(out.dead), [0, 1, 2]);
  assert.equal(out.byMatch.size, 0);
  assert.deepEqual(out.unlocked, []);
});

// A role's moves cost what its own costliest move bounds, so a session locked to a match is
// judged by its side in that match.
test("a locked session is used up below the reserve of its side in the match", () => {
  const left = { spendUsed: budget - reserve.later.challenger + 1 };
  const matches = new Map([["4", { phase: "reveal", role: "challenger" }], ["5", { phase: "play", role: "acceptor" }]]);
  const out = classify([sessionAt(0, left), sessionAt(1, left)], [lockOf(0, "4"), lockOf(1, "5")], matches);
  assert.deepEqual(generationsOf(out.dead), [0]);
  assert.deepEqual([...out.byMatch.keys()], ["5"]);
});

// A locked session never pays an opening again, while an unlocked one may still pay either side's.
test("a locked session needs only its side's later moves left, an unlocked one an opening", () => {
  const left = { spendUsed: budget - reserve.later.challenger };
  const out = classify([sessionAt(0, left), sessionAt(1, left)], [lockOf(0, "4")], new Map([["4", { phase: "reveal", role: "challenger" }]]));
  assert.equal(out.byMatch.get("4").generation, 0);
  assert.deepEqual(generationsOf(out.dead), [1]);
});

// Only a live session's lock can make it a match's; the realm keeps a revoked session's lock
// until that session's expiry.
test("the matches to read are those the live sessions are locked to", () => {
  const onChain = [sessionAt(0), sessionAt(1, { expiresAt: now - 1 }), sessionAt(2, { expiresAt: now + 7200 }), sessionAt(3)];
  const locks = [lockOf(0, "4"), lockOf(1, "5", now - 1), lockOf(2, "6"), lockOf(4, "7"), lockOf(3, "4")];
  assert.deepEqual(lockedMatches({ onChain, locks, now }), ["4"]);
});

test("a session locked to an ended match, or to one the realm no longer knows, is dead", () => {
  const out = classify([sessionAt(0), sessionAt(1)], [lockOf(0, "4"), lockOf(1, "9")], new Map([["4", { phase: "ended", role: "challenger" }]]));
  assert.deepEqual(generationsOf(out.dead), [0, 1]);
  assert.equal(out.byMatch.size, 0);
});

test("generations with no session are free, and other apps' sessions are left alone", () => {
  const foreign = { ...sessionAt(0, { expiresAt: now - 1 }), address: "g1someothersession" };
  const out = classify([foreign, sessionAt(2)]);
  assert.deepEqual(generationsOf(out.free), allBut(2));
  assert.equal(out.free[0].keys, keys.get(0));
  assert.deepEqual(generationsOf(out.unlocked), [2]);
  assert.deepEqual(out.dead, []);
});

// Revoking a key and registering it again gives a session with a new expiry, which the
// realm treats as unlocked.
test("a lock under another expiry is an earlier session's, so the session is unlocked", () => {
  const out = classify([sessionAt(0, { expiresAt: now + 7200 })], [lockOf(0, "4", now + 3600)], new Map([["4", { phase: "play", role: "acceptor" }]]));
  assert.equal(out.byMatch.size, 0);
  assert.deepEqual(generationsOf(out.unlocked), [0]);
});

test("a generation registered again signs with the account number the chain gives it", () => {
  const out = classify([sessionAt(0, { accountNumber: 31, sequence: 0, expiresAt: now + 7200 })], [lockOf(0, "4", now + 3600)], new Map([["4", { phase: "ended", role: "challenger" }]]));
  assert.deepEqual(out.dead, []);
  assert.equal(out.unlocked[0].session.accountNumber, 31);
  assert.equal(out.unlocked[0].session.sequence, 0);
});

// The same keys may hold sessions for another arena the site plays on.
test("a session for another realm path is neither live nor dead until it expires", () => {
  const elsewhere = { allowPaths: ["vm/exec:gno.land/r/gfanton/gnomehall/arena_v1"] };
  const out = classify([sessionAt(0, elsewhere), sessionAt(1, { ...elsewhere, expiresAt: now - 1 })]);
  assert.deepEqual(out.unlocked, []);
  assert.deepEqual(generationsOf(out.dead), [1]);
  assert.deepEqual(generationsOf(out.free), allBut(0, 1));
});

// adena answers like Adena, with the given overrides.
const adena = (overrides) => ({
  AddEstablish: async () => ({ status: "success", type: "CONNECTION_SUCCESS" }),
  GetNetwork: async () => ({ status: "success", data: { chainId: "dev" } }),
  SwitchNetwork: async () => ({ status: "failure", type: "UNADDED_NETWORK" }),
  GetAccount: async () => ({ status: "success", data: { address: "g1player" } }),
  ...overrides,
});

test("connecting gives the wallet's address on the right network", async () => {
  assert.deepEqual(await connect(adena({}), "dev"), { address: "g1player" });
  const already = adena({ AddEstablish: async () => ({ status: "failure", type: "ALREADY_CONNECTED" }) });
  assert.deepEqual(await connect(already, "dev"), { address: "g1player" });
});

test("connecting switches network, or says the network is missing when Adena cannot add it", async () => {
  let switched = "";
  const elsewhere = { GetNetwork: async () => ({ status: "success", data: { chainId: "onyx-1" } }) };
  const switching = adena({ ...elsewhere, SwitchNetwork: async (id) => { switched = id; return { status: "success" }; } });
  assert.deepEqual(await connect(switching, "dev"), { address: "g1player" });
  assert.equal(switched, "dev");
  await assert.rejects(connect(adena(elsewhere), "dev"), failure("wrongNetwork"));
});

test("connecting adds the game's network when Adena does not know it, then switches", async () => {
  const calls = [];
  let added = false;
  const wallet = adena({
    GetNetwork: async () => ({ status: "success", data: { chainId: "onyx-1" } }),
    SwitchNetwork: async (id) => { calls.push(`switch ${id}`); return added ? { status: "success" } : { status: "failure", type: "UNADDED_NETWORK" }; },
    AddNetwork: async (net) => { calls.push(`add ${net.chainId} ${net.rpcUrl}`); added = true; return { status: "success" }; },
  });
  assert.deepEqual(await connect(wallet, "dev", { chainName: "dev", rpcUrl: "http://127.0.0.1:36657" }), { address: "g1player" });
  assert.deepEqual(calls, ["switch dev", "add dev http://127.0.0.1:36657", "switch dev"]);
});

test("without a network to offer, connecting never asks Adena to add one", async () => {
  let asked = false;
  const wallet = adena({
    GetNetwork: async () => ({ status: "success", data: { chainId: "onyx-1" } }),
    AddNetwork: async () => { asked = true; return { status: "success" }; },
  });
  await assert.rejects(connect(wallet, "other-1", undefined), failure("wrongNetwork"));
  assert.equal(asked, false);
});

test("a network Adena refuses to add leaves the player on the wrong network", async () => {
  const wallet = adena({
    GetNetwork: async () => ({ status: "success", data: { chainId: "onyx-1" } }),
    AddNetwork: async () => ({ status: "failure", type: "ADD_NETWORK_REJECTED", message: "User rejected" }),
  });
  await assert.rejects(connect(wallet, "dev", { chainName: "dev", rpcUrl: "http://x" }), failure("wrongNetwork"));
});

test("connecting without a wallet, or when the player refuses, fails with its reason", async () => {
  await assert.rejects(connect(undefined, "dev"), failure("noWallet"));
  const refused = adena({ AddEstablish: async () => ({ status: "failure", type: "CONNECTION_REJECTED", message: "User rejected" }) });
  await assert.rejects(connect(refused, "dev"), (err) => err.type === "refused" && err.reason === "User rejected");
});
