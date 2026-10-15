import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createChain } from "./chain.mjs";
import { devAccounts, devWallet, toSignerMsg } from "./devwallet.mjs";
import { nodeEngine } from "./engine-node.mjs";
import { deriveKeys, sessionMessage } from "./wallet.mjs";

const engine = await nodeEngine();
const alice = devAccounts.alice.address;

// replayChain answers each RPC request with the next recording.
function replayChain(...names) {
  const fetch = async () => {
    const answer = JSON.parse(readFileSync(new URL(`./testdata/rpc/${names.shift()}.json`, import.meta.url)));
    return { ok: true, status: 200, json: async () => answer };
  };
  return createChain({ rpc: "http://node", fetch });
}

test("each dev account's key gives its listed address", () => {
  for (const { key, address } of Object.values(devAccounts)) assert.equal(engine.keyInfo(key).address, address);
});

test("the dev wallet answers connection calls like Adena", async () => {
  const wallet = devWallet({ name: "alice", signer: engine, chain: null, chainId: "dev" });
  assert.equal((await wallet.AddEstablish("Gnomehall")).status, "success");
  assert.equal((await wallet.GetNetwork()).data.chainId, "dev");
  assert.equal((await wallet.GetAccount()).data.address, alice);
  assert.equal((await wallet.SwitchNetwork("onyx-1")).type, "UNADDED_NETWORK");
});

test("SignArbitrary signs Adena's document the same way every time", async () => {
  const wallet = devWallet({ name: "alice", signer: engine, chain: null, chainId: "dev" });
  const first = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://x" });
  const again = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://x" });
  assert.equal(first.status, "success");
  assert.equal(first.data.signature.signature, again.data.signature.signature);
  assert.equal(first.data.signature.pubKey.value, engine.keyInfo(devAccounts.alice.key).pubKey);
  const [msg] = first.data.signed.msgs;
  assert.equal(msg.type, "sign/MsgSignData");
  assert.equal(atob(msg.value.data), "Gnomehall at http://x");
  assert.equal(first.data.signed.chain_id, "dev");

  const other = await wallet.SignArbitrary({ signer: alice, data: "Gnomehall at http://elsewhere" });
  assert.notEqual(other.data.signature.signature, first.data.signature.signature);
  assert.equal((await wallet.SignArbitrary({ signer: devAccounts.bob.address, data: "x" })).status, "failure");
});

test("a session creation in Adena's form becomes the signer's amino JSON", async () => {
  const keys = await deriveKeys(btoa("root signature"), 0, engine);
  const msg = toSignerMsg(sessionMessage(alice, keys.sessionPubKey, 1_800_000_000, "gno.land/r/x"));
  assert.equal(msg.type, "/auth.m_create_session");
  assert.deepEqual(msg.value.session_key, { "@type": "/tm.PubKeySecp256k1", value: keys.sessionPubKey });
  assert.equal(msg.value.expires_at, "1800604800");
  assert.equal(msg.value.spend_limit, "10000000ugnot");
});

test("a call in Adena's form gets the fields Adena leaves out", () => {
  const msg = toSignerMsg({ type: "/vm.m_call", value: { caller: alice, pkg_path: "gno.land/r/x", func: "F", args: ["1"] } });
  assert.deepEqual(msg, {
    type: "/vm.m_call",
    value: { caller: alice, send: "", max_deposit: "", pkg_path: "gno.land/r/x", func: "F", args: ["1"] },
  });
  assert.throws(() => toSignerMsg({ type: "/bank.MsgSend", value: {} }), /unsupported message/);
});

const call = { type: "/vm.m_call", value: { caller: alice, send: "", pkg_path: "gno.land/r/x", func: "F", args: [] } };

test("SignTx signs for the account's sequence and the simulated gas", async () => {
  const wallet = devWallet({ name: "alice", signer: engine, chain: replayChain("account", "gasprice", "simulate"), chainId: "dev" });
  const signed = await wallet.SignTx({ messages: [call] });
  assert.equal(signed.status, "success");
  assert.match(signed.data.encodedTransaction, /^[A-Za-z0-9+/]+=*$/);
});

test("DoContract broadcasts and answers like Adena, or fails with the chain's reason", async () => {
  const ok = devWallet({ name: "alice", signer: engine, chain: replayChain("account", "gasprice", "simulate", "broadcast-ok"), chainId: "dev" });
  const landed = await ok.DoContract({ messages: [call] });
  assert.equal(landed.status, "success");
  assert.equal(typeof landed.data.hash, "string");

  const refused = devWallet({ name: "alice", signer: engine, chain: replayChain("account", "gasprice", "simulate-error"), chainId: "dev" });
  const failed = await refused.DoContract({ messages: [call] });
  assert.equal(failed.status, "failure");
  assert.equal(failed.message, "unknown match");
});
