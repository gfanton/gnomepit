import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { nodeEngine } from "./engine-node.mjs";
import {
  WalletError, connect, deriveKeys, findSession, newSalt, openBox, rootText, sealBox, sealOf, sessionMessage,
} from "./wallet.mjs";

const engine = await nodeEngine();
const signature = btoa("a root signature of 64 bytes, as a wallet would return one....");
const otherSignature = btoa("another root signature, from another wallet or another site....");
const realm = "gno.land/r/gfanton/gnomehall/arena";
const now = 1_800_000_000;

const failure = (type) => (err) => err instanceof WalletError && err.type === type;

test("the root text names Gnomehall and the site", () => {
  assert.equal(
    rootText("http://127.0.0.1:8080"),
    "Gnomehall at http://127.0.0.1:8080\nSign once on each device to play online. This signs no transaction.",
  );
});

test("keys derive the same from the same signature, per generation", async () => {
  const a = await deriveKeys(signature, 0, engine);
  const b = await deriveKeys(signature, 0, engine);
  const next = await deriveKeys(signature, 1, engine);
  assert.equal(a.sessionKey, b.sessionKey);
  assert.match(a.sessionKey, /^[0-9a-f]{64}$/);
  assert.equal(a.sessionAddress, engine.keyInfo(a.sessionKey).address);
  assert.notEqual(next.sessionAddress, a.sessionAddress);
});

test("a box opens with the keys that sealed it, and only with them", async () => {
  const { boxKey } = await deriveKeys(signature, 0, engine);
  const contents = { plan: "Pick,Pick,Pick", planSalt: newSalt() };
  const box = await sealBox(boxKey, contents);
  assert.deepEqual(await openBox(boxKey, box), contents);
  assert.deepEqual(await openBox((await deriveKeys(signature, 3, engine)).boxKey, box), contents);

  const other = await deriveKeys(otherSignature, 0, engine);
  await assert.rejects(openBox(other.boxKey, box), failure("box"));
  await assert.rejects(openBox(boxKey, "not a box"), failure("box"));
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

test("a session message lets the session key call the arena for 7 days", async () => {
  const keys = await deriveKeys(signature, 0, engine);
  const { type, value } = sessionMessage("g1master", keys.sessionPubKey, now, realm);
  assert.equal(type, "/auth.m_create_session");
  assert.equal(value.creator, "g1master");
  assert.equal(value.session_key.type_url, "/tm.PubKeySecp256k1");
  const wrapped = Uint8Array.from(atob(value.session_key.value), (c) => c.charCodeAt(0));
  assert.deepEqual([...wrapped.subarray(0, 2)], [0x0a, 33]);
  assert.equal(btoa(String.fromCharCode(...wrapped.subarray(2))), keys.sessionPubKey);
  assert.equal(value.expires_at, String(now + 604800));
  assert.deepEqual(value.allow_paths, [`vm/exec:${realm}`]);
  assert.equal(value.spend_limit, "10000000ugnot");
  assert.equal(value.spend_period, "0");
});

// chainWith answers sessions() with the given session accounts.
const chainWith = (sessions) => ({ sessions: async () => sessions });
const sessionAt = async (generation, fields) => ({
  address: (await deriveKeys(signature, generation, engine)).sessionAddress,
  accountNumber: 9, sequence: 2, expiresAt: now + 3600, spendLimit: 10_000_000, spendUsed: 0, allowPaths: [`vm/exec:${realm}`], ...fields,
});
const keysFor = (generation) => deriveKeys(signature, generation, engine);
const find = (sessions) => findSession(chainWith(sessions), "g1master", keysFor, now, realm);

test("an unexpired session with funds left is active", async () => {
  const found = await find([await sessionAt(0, {}), await sessionAt(1, {})]);
  assert.equal(found.state, "active");
  assert.equal(found.generation, 0);
  assert.equal(found.session.sequence, 2);
  assert.equal((await find([await sessionAt(0, { spendUsed: 8_400_000 })])).state, "active");
});

test("an expired session, or one that cannot pay for a challenge, asks for the next generation", async () => {
  for (const fields of [{ expiresAt: now - 1 }, { spendUsed: 9_500_000 }]) {
    const found = await find([await sessionAt(0, fields)]);
    assert.equal(found.state, "expired");
    assert.equal(found.generation, 1);
    assert.equal(found.keys.sessionAddress, (await keysFor(1)).sessionAddress);
  }
});

test("a session for another realm path is no use to this one", async () => {
  const found = await find([await sessionAt(0, { allowPaths: ["vm/exec:gno.land/r/gfanton/gnomehall/arena_v1"] })]);
  assert.equal(found.state, "expired");
  assert.equal(found.generation, 1);
});

test("no session at all starts at generation 0, whatever other apps' sessions exist", async () => {
  const foreign = { ...(await sessionAt(0, {})), address: "g1someothersession" };
  for (const sessions of [[], [foreign]]) {
    const found = await find(sessions);
    assert.equal(found.state, "missing");
    assert.equal(found.generation, 0);
  }
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

test("connecting switches network, or says the network is missing", async () => {
  let switched = "";
  const elsewhere = { GetNetwork: async () => ({ status: "success", data: { chainId: "onyx-1" } }) };
  const switching = adena({ ...elsewhere, SwitchNetwork: async (id) => { switched = id; return { status: "success" }; } });
  assert.deepEqual(await connect(switching, "dev"), { address: "g1player" });
  assert.equal(switched, "dev");
  await assert.rejects(connect(adena(elsewhere), "dev"), failure("wrongNetwork"));
});

test("connecting without a wallet, or when the player refuses, fails with its reason", async () => {
  await assert.rejects(connect(undefined, "dev"), failure("noWallet"));
  const refused = adena({ AddEstablish: async () => ({ status: "failure", type: "CONNECTION_REJECTED", message: "User rejected" }) });
  await assert.rejects(connect(refused, "dev"), (err) => err.type === "refused" && err.reason === "User rejected");
});
