import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createChain } from "./chain.mjs";
import { devAccounts, devWallet } from "./devwallet.mjs";
import * as signer from "./signer.mjs";
import { deriveKeys, sessionMessage } from "./wallet.mjs";

const alice = devAccounts.alice.address;

// replayChain answers each RPC request with the next recording.
function replayChain(...names) {
  const fetch = async () => {
    const answer = JSON.parse(readFileSync(new URL(`./testdata/rpc/${names.shift()}.json`, import.meta.url)));
    return { ok: true, status: 200, json: async () => answer };
  };
  return createChain({ rpc: "http://node", fetch });
}

test("each dev account's key gives its listed address", async () => {
  for (const { key, address } of Object.values(devAccounts)) assert.equal((await signer.keyInfo(key)).address, address);
});

test("the dev wallet answers connection calls like Adena", async () => {
  const wallet = devWallet({ name: "alice", signer, chain: null, chainId: "dev" });
  assert.equal((await wallet.AddEstablish("Gnomehall")).status, "success");
  assert.equal((await wallet.GetNetwork()).data.chainId, "dev");
  assert.equal((await wallet.GetAccount()).data.address, alice);
  assert.equal((await wallet.SwitchNetwork("onyx-1")).type, "UNADDED_NETWORK");
});

test("SignArbitrary signs Adena's document the same way every time", async () => {
  const wallet = devWallet({ name: "alice", signer, chain: null, chainId: "dev" });
  const first = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://x" });
  const again = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://x" });
  assert.equal(first.status, "success");
  assert.equal(first.data.signature.signature, again.data.signature.signature);
  assert.equal(first.data.signature.pubKey.value, (await signer.keyInfo(devAccounts.alice.key)).pubKey);
  const [msg] = first.data.signed.msgs;
  assert.equal(msg.type, "sign/MsgSignData");
  assert.equal(atob(msg.value.data), "Gnomehall at http://x");
  assert.equal(first.data.signed.chain_id, "dev");

  const other = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://elsewhere" });
  assert.notEqual(other.data.signature.signature, first.data.signature.signature);
  assert.equal((await wallet.SignArbitrary({ signer: devAccounts.bob.address, data: "x" })).status, "failure");
});

const call = { type: "/vm.m_call", value: { caller: alice, send: "", pkg_path: "gno.land/r/x", func: "F", args: [] } };

// recording passes every request on to signer.mjs and keeps it.
function recording() {
  const requests = [];
  return { requests, spy: { ...signer, signTx: (request) => (requests.push(request), signer.signTx(request)) } };
}

test("the signer gets the page's messages in Adena's form, as Adena would", async () => {
  const keys = await deriveKeys(btoa("root signature"), 0, signer);
  const session = sessionMessage(alice, keys.sessionPubKey, 1_800_000_000, "gno.land/r/x");
  const { requests, spy } = recording();
  const wallet = devWallet({ name: "alice", signer: spy, chain: replayChain("account", "account", "gasprice", "simulate"), chainId: "dev" });
  assert.equal((await wallet.SignTx({ messages: [session] })).status, "success");
  assert.equal((await wallet.SignTx({ messages: [call] })).status, "success");
  assert.deepEqual(requests.map((r) => r.msgs), [[session], [call], [call]]);
});

// A page that names too low a session fee, or none, then fails here as it fails in Adena.
test("a session creation is signed with the fee it names, as Adena signs it", async () => {
  const { requests, spy } = recording();
  const keys = await deriveKeys(btoa("root signature"), 0, signer);
  const session = sessionMessage(alice, keys.sessionPubKey, 1_800_000_000, "gno.land/r/x");
  const wallet = devWallet({ name: "alice", signer: spy, chain: replayChain("account", "account"), chainId: "dev" });
  assert.equal((await wallet.SignTx({ messages: [session], gasWanted: 3_000_000, gasFee: 3_000 })).status, "success");
  assert.equal((await wallet.SignTx({ messages: [session] })).status, "success");
  assert.deepEqual(requests.map((r) => r.fee), [
    { gasWanted: 3_000_000, gasFee: "3000ugnot" },
    { gasWanted: 2_000_000_000, gasFee: "100000ugnot" },
  ]);
});

test("SignTx signs for the account's sequence and the simulated gas", async () => {
  const wallet = devWallet({ name: "alice", signer, chain: replayChain("account", "gasprice", "simulate"), chainId: "dev" });
  const signed = await wallet.SignTx({ messages: [call] });
  assert.equal(signed.status, "success");
  assert.match(signed.data.encodedTransaction, /^[A-Za-z0-9+/]+=*$/);
});

test("DoContract broadcasts and answers like Adena, or fails with the chain's reason", async () => {
  const ok = devWallet({ name: "alice", signer, chain: replayChain("account", "gasprice", "simulate", "broadcast-ok"), chainId: "dev" });
  const landed = await ok.DoContract({ messages: [call] });
  assert.equal(landed.status, "success");
  assert.equal(typeof landed.data.hash, "string");

  const refused = devWallet({ name: "alice", signer, chain: replayChain("account", "gasprice", "simulate-error"), chainId: "dev" });
  const failed = await refused.DoContract({ messages: [call] });
  assert.equal(failed.status, "failure");
  assert.equal(failed.message, "unknown match");
});
