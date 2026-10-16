import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ChainError, createChain, payFor } from "./chain.mjs";

const recorded = (name) => JSON.parse(readFileSync(new URL(`./testdata/rpc/${name}.json`, import.meta.url)));

// replay answers each request with the next recording, and keeps what was sent.
function replay(...names) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, ...JSON.parse(init.body) });
    const answer = recorded(names.shift());
    return { ok: true, status: 200, json: async () => answer };
  };
  return { chain: createChain({ rpc: "http://node", fetch }), sent };
}

const rejects = (promise, type, reason) =>
  assert.rejects(promise, (err) => err instanceof ChainError && err.type === type && err.reason === reason);

test("an account gives its number and sequence", async () => {
  const { chain, sent } = replay("account");
  const account = await chain.account("g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w");
  assert.equal(account.accountNumber, 1);
  assert.equal(typeof account.sequence, "number");
  assert.equal(account.coins.endsWith("ugnot"), true);
  assert.equal(sent[0].method, "abci_query");
  assert.equal(sent[0].params.path, "auth/accounts/g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w");
});

test("an address the chain has never seen has no account", async () => {
  const { chain } = replay("account-missing");
  assert.equal(await chain.account("g1nobody"), null);
});

test("the gas price is a price per amount of gas", async () => {
  const { chain } = replay("gasprice");
  assert.deepEqual(await chain.gasPrice(), { gas: 1000, amount: 1, denom: "ugnot" });
});

test("a query sends its expression and returns the typed values", async () => {
  const { chain, sent } = replay("qeval-ok");
  const [open] = await chain.evalJSON("gno.land/r/gfanton/gnomehall/arena.Open(0, 50)");
  assert.equal(open.T.Elt.ID, "gno.land/r/gfanton/gnomehall/arena.OpenChallenge");
  assert.equal(sent[0].params.path, "vm/qeval_json");
  assert.equal(atob(sent[0].params.data), "gno.land/r/gfanton/gnomehall/arena.Open(0, 50)");
});

test("a type query gives the type's declaration", async () => {
  const { chain } = replay("qtype");
  const answer = await chain.typeJSON("gno.land/r/gfanton/gnomehall/arena.OpenChallenge");
  assert.equal(answer.type.Name, "OpenChallenge");
});

test("a query the realm refuses fails with the realm's reason", async () => {
  const { chain } = replay("qeval-error");
  await rejects(chain.evalJSON('gno.land/r/gfanton/gnomehall/arena.Match("99")'), "failed", "unknown match");
});

test("a simulation gives the gas the transaction uses", async () => {
  const { chain, sent } = replay("simulate");
  const gas = await chain.simulate("dHg=");
  // record-rpc.mjs simulates and then broadcasts the same transaction.
  assert.equal(gas, Number(recorded("broadcast-ok").result.deliver_tx.GasUsed));
  assert.equal(sent[0].params.path, ".app/simulate");
  assert.equal(sent[0].params.data, "dHg=");
});

test("a simulation the realm refuses fails with the realm's reason", async () => {
  const { chain } = replay("simulate-error");
  await rejects(chain.simulate("dHg="), "failed", "unknown match");
});

// storageOf lists the bytes_delta of a recorded transaction's storage events: positive
// for a deposit, negative for an unlock.
function storageOf(name) {
  const events = recorded(name).result.deliver_tx.ResponseBase.Events;
  const deltas = (type) => events.filter((e) => e["@type"] === type).map((e) => Number(e.bytes_delta));
  return { deposits: deltas("/tm.StorageDepositEvent"), unlocks: deltas("/tm.StorageUnlockEvent") };
}
const sum = (numbers) => numbers.reduce((a, b) => a + b, 0);

test("a broadcast that lands gives its hash, height, gas and the storage it locked", async () => {
  const { chain, sent } = replay("broadcast-ok");
  const landed = await chain.broadcast("dHg=");
  assert.equal(typeof landed.hash, "string");
  assert.equal(landed.height > 0, true);
  assert.equal(landed.gasUsed > 0, true);
  const { deposits, unlocks } = storageOf("broadcast-ok");
  assert.equal(deposits.length > 0, true);
  assert.equal(landed.storage, sum(deposits) + sum(unlocks));
  assert.equal(landed.storage > 0, true);
  assert.equal(sent[0].method, "broadcast_tx_commit");
  assert.deepEqual(sent[0].params, { tx: "dHg=" });
});

// The recording withdraws an open challenge, which frees its storage.
test("a broadcast that frees storage reports it as negative", async () => {
  const { chain } = replay("broadcast-unlock");
  const landed = await chain.broadcast("dHg=");
  const { deposits, unlocks } = storageOf("broadcast-unlock");
  assert.equal(unlocks.length > 0 && unlocks.every((bytes) => bytes < 0), true);
  assert.equal(landed.storage, sum(deposits) + sum(unlocks));
  assert.equal(landed.storage < 0, true);
});

test("a transaction CheckTx refuses is rejected with its reason", async () => {
  const { chain } = replay("broadcast-checktx");
  await rejects(chain.broadcast("dHg="), "rejected", "signature verification failed; verify correct account, sequence, and chain-id");
});

test("a transaction the node already holds is rejected", async () => {
  const { chain } = replay("broadcast-duplicate");
  await rejects(chain.broadcast("dHg="), "rejected", "error on broadcastTxCommit: Tx already exists in cache");
});

test("a transaction the realm refuses fails with the realm's reason", async () => {
  const { chain } = replay("broadcast-delivertx");
  await rejects(chain.broadcast("dHg="), "failed", "unknown match");
});

test("an account's sessions list each session's account and limits", async () => {
  const { chain, sent } = replay("sessions");
  const sessions = await chain.sessions("g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w");
  assert.equal(sessions.length > 0, true);
  const [first] = sessions;
  assert.equal(first.address.startsWith("g1"), true);
  assert.equal(typeof first.accountNumber, "number");
  assert.equal(typeof first.sequence, "number");
  assert.equal(typeof first.expiresAt, "number");
  assert.deepEqual(first.allowPaths, ["vm/exec:gno.land/r/gfanton/gnomehall/arena"]);
  assert.equal(first.spendLimit, 1_000_000);
  assert.equal(typeof first.spendUsed, "number");
  assert.equal(sent[0].params.path, "auth/accounts/g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w/sessions");
});

test("one session's account, or null when the chain has none", async () => {
  const { chain, sent } = replay("session", "session-missing");
  const session = await chain.sessionAccount("g1master", "g1session");
  assert.equal(session.sequence, 0);
  assert.equal(sent[0].params.path, "auth/accounts/g1master/session/g1session");
  assert.equal(await chain.sessionAccount("g1master", "g1other"), null);
});

test("a transaction pays for the gas its simulation used, with a margin", async () => {
  const { chain } = replay("gasprice", "simulate");
  const fees = [];
  const tx = await payFor(chain, (fee) => {
    fees.push(fee);
    return `tx-${fees.length}`;
  });
  assert.equal(tx, "tx-2");
  // A simulation checks no fee against the gas price, but a session's allowance must
  // cover it, so it pays the least it can.
  assert.deepEqual(fees[0], { gasWanted: 100_000_000, gasFee: "1ugnot" });
  const used = await createChain({ rpc: "", fetch: async () => ({ ok: true, json: async () => recorded("simulate") }) }).simulate("x");
  const gasWanted = Math.ceil(used * 1.2) + 100_000;
  assert.deepEqual(fees[1], { gasWanted, gasFee: `${Math.ceil(gasWanted / 1000)}ugnot` });
});

test("a broadcast that times out may still land, so it is a network error", async () => {
  const timeout = { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: "request timeout" } };
  const chain = createChain({ rpc: "http://node", fetch: async () => ({ ok: true, status: 200, json: async () => timeout }) });
  await rejects(chain.broadcast("dHg="), "network", "request timeout");
});

test("no answer from the node is a network error", async () => {
  const chain = createChain({ rpc: "http://node", fetch: async () => { throw new TypeError("fetch failed"); } });
  await rejects(chain.gasPrice(), "network", "fetch failed");
  const down = createChain({ rpc: "http://node", fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  await rejects(down.gasPrice(), "network", "the node answered 502");
});
