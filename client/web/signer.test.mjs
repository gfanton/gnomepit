import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fromBase64 } from "./encoding.mjs";
import { keyInfo, signBytes, signTx } from "./signer.mjs";

// Signed by client/golden with the chain's own Go types; make golden writes it.
const golden = JSON.parse(readFileSync(new URL("./testdata/golden-tx.json", import.meta.url)));
const goldenRequest = (name) => golden.find((c) => c.name === name).request;

for (const { name, request, tx } of golden) {
  test(`${name} signs to the chain's own bytes`, async () => {
    const signed = name === "sign-bytes" ? await signBytes(request.privKey, request.bytes) : await signTx(request);
    assert.equal(signed, tx);
  });
}

test("keyInfo gives the addresses and session key the golden requests carry", async () => {
  const wallet = goldenRequest("wallet-call");
  assert.equal((await keyInfo(wallet.privKey)).address, wallet.msgs[0].value.caller);

  const session = goldenRequest("session-call");
  const sessionKey = await keyInfo(session.privKey);
  assert.equal(sessionKey.address, session.sessionAddr);
  const create = goldenRequest("create-and-revoke").msgs.find((m) => m.type === "/auth.m_create_session");
  assert.deepEqual(fromBase64(create.value.session_key.value), Uint8Array.of(0x0a, 33, ...fromBase64(sessionKey.pubKey)));
});

test("a private key that is not 32 bytes of hex is refused", async () => {
  // Hex that does not parse would otherwise sign with whatever bytes it decodes to.
  for (const key of ["", "01".repeat(31), "zz".repeat(32), `${"01".repeat(31)}0`]) {
    await assert.rejects(keyInfo(key), /32 bytes of hex/, key);
    await assert.rejects(signBytes(key, "AA=="), /32 bytes of hex/, key);
  }
  for (const key of ["00".repeat(32), "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"]) {
    await assert.rejects(keyInfo(key), /not a valid secp256k1 private key/, key);
  }
});

test("a message signer.mjs does not know is refused", async () => {
  const request = { ...goldenRequest("wallet-call"), msgs: [{ type: "/bank.MsgSend", value: {} }] };
  await assert.rejects(signTx(request), /unsupported message \/bank\.MsgSend/);
});
