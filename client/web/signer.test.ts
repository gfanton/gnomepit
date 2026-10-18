import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import * as v from "valibot";

import { browserBundle } from "../build.ts";
import { fromBase64 } from "./encoding.ts";
import { known } from "./fixture.ts";
import { keyInfo, signBytes, signTx, type Signer } from "./signer.ts";

const TxRequestSchema = v.object({
  chainId: v.string(),
  accountNumber: v.number(),
  sequence: v.number(),
  privKey: v.string(),
  sessionAddr: v.string(),
  fee: v.object({ gasWanted: v.number(), gasFee: v.string() }),
  memo: v.string(),
  msgs: v.array(v.object({ type: v.string(), value: v.record(v.string(), v.unknown()) })),
});
const BytesRequestSchema = v.object({ privKey: v.string(), bytes: v.string() });
type TxRequest = v.InferOutput<typeof TxRequestSchema>;

// Signed by client/golden with the chain's own Go types; make golden writes it.
const golden = v.parse(
  v.array(v.object({ name: v.string(), request: v.unknown(), tx: v.string() })),
  JSON.parse(readFileSync(new URL("./testdata/golden-tx.json", import.meta.url), "utf8")),
);
const goldenRequest = (name: string) => v.parse(TxRequestSchema, known(golden.find((c) => c.name === name)).request);

type GoldenSigner = Pick<Signer, "signBytes" | "signTx">;
const signGolden = (signer: GoldenSigner, name: string, request: unknown) => {
  if (name !== "sign-bytes") return signer.signTx(v.parse(TxRequestSchema, request));
  const { privKey, bytes } = v.parse(BytesRequestSchema, request);
  return signer.signBytes(privKey, bytes);
};

// callerOf is the caller of a request's first message, a realm call.
const callerOf = (request: TxRequest) => v.parse(v.object({ caller: v.string() }), known(request.msgs[0]).value).caller;

for (const { name, request, tx } of golden) {
  test(`${name} signs to the chain's own bytes`, async () => {
    const signed = await signGolden({ signBytes, signTx }, name, request);
    assert.equal(signed, tx);
  });
}

// isSigner narrows the bundled module to the signer functions the golden cases call.
function isSigner(value: unknown): value is GoldenSigner {
  return (
    typeof value === "object" &&
    value !== null &&
    "signBytes" in value &&
    typeof value.signBytes === "function" &&
    "signTx" in value &&
    typeof value.signTx === "function"
  );
}

// The page runs the gno clients on the shims' Buffer and crypto, not Node's.
test("the page's bundle of the signer signs the golden transactions the same", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gnomehall-signer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = join(dir, "signer.mjs");
  await esbuild.build({
    ...browserBundle(),
    entryPoints: [fileURLToPath(new URL("./signer.ts", import.meta.url))],
    outfile,
  });
  const bundle: unknown = await import(pathToFileURL(outfile).href);
  assert.ok(isSigner(bundle), "the bundle exports signBytes and signTx");
  for (const { name, request, tx } of golden) {
    assert.equal(await signGolden(bundle, name, request), tx, name);
  }
});

test("keyInfo gives the addresses and session key the golden requests carry", async () => {
  const wallet = goldenRequest("wallet-call");
  assert.equal((await keyInfo(wallet.privKey)).address, callerOf(wallet));

  const session = goldenRequest("session-call");
  const sessionKey = await keyInfo(session.privKey);
  assert.equal(sessionKey.address, session.sessionAddr);
  const create = goldenRequest("create-and-revoke").msgs.find((m) => m.type === "/auth.m_create_session");
  const { session_key: key } = v.parse(v.object({ session_key: v.object({ value: v.string() }) }), create?.value);
  assert.deepEqual(fromBase64(key.value), Uint8Array.of(0x0a, 33, ...fromBase64(sessionKey.pubKey)));
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

test("a message signer.ts does not know is refused", async () => {
  // Names every object inherits must not pass for a message codec.
  for (const type of ["/bank.MsgSend", "constructor", "__proto__", "toString"]) {
    const request = { ...goldenRequest("wallet-call"), msgs: [{ type, value: {} }] };
    await assert.rejects(
      signTx(request),
      (err) => err instanceof Error && err.message === `unsupported message ${type}`,
      type,
    );
  }
});

const goldenTx = (name: string) => known(golden.find((c) => c.name === name)).tx;

test("a request without sessionAddr signs as the account itself", async () => {
  const { sessionAddr, ...request } = goldenRequest("wallet-call");
  assert.equal(sessionAddr, "");
  assert.equal(await signTx(request), goldenTx("wallet-call"));
});

test("a call without the fields Adena leaves out signs as one with them empty", async () => {
  const request = goldenRequest("session-call");
  const call = known(request.msgs[0]);
  const { send, max_deposit: maxDeposit, ...value } = call.value;
  assert.deepEqual([send, maxDeposit], ["", ""]);
  assert.equal(await signTx({ ...request, msgs: [{ ...call, value }] }), goldenTx("session-call"));
});

test("a request without a chain id is refused", async () => {
  for (const chainId of ["", undefined]) {
    await assert.rejects(
      // @ts-expect-error: a caller in JavaScript can leave the chain id out.
      signTx({ ...goldenRequest("wallet-call"), chainId }),
      /missing chain id/,
      String(chainId),
    );
  }
});

test("a request with no message is refused", async () => {
  for (const msgs of [[], undefined]) {
    await assert.rejects(
      // @ts-expect-error: a caller in JavaScript can leave the messages out.
      signTx({ ...goldenRequest("wallet-call"), msgs }),
      /no message to sign/,
      String(msgs),
    );
  }
});

test("an account number or sequence that is not a non-negative integer is refused", async () => {
  for (const [field, name] of [
    ["accountNumber", "account number"],
    ["sequence", "sequence"],
  ] as const) {
    for (const value of [-1, 1.5, "3", undefined, Number.NaN, 2 ** 53]) {
      const request = { ...goldenRequest("wallet-call"), [field]: value };
      await assert.rejects(
        signTx(request),
        (err) => err instanceof Error && err.message === `${name} must be a non-negative integer`,
        `${field} ${value}`,
      );
    }
  }
});

test("a session address that is not the signing key's own is refused", async () => {
  const wallet = goldenRequest("wallet-call");
  const session = goldenRequest("session-call");
  // The master key signing as its session, the session key naming its master, and text that is no address.
  for (const request of [
    { ...wallet, sessionAddr: session.sessionAddr },
    { ...session, sessionAddr: callerOf(wallet) },
    { ...session, sessionAddr: "g1nope" },
  ]) {
    await assert.rejects(signTx(request), /session address is not the signing key's address/, request.sessionAddr);
  }
});

// The chain's amino JSON leaves an empty spend_limit out of the sign bytes and the JS
// client writes it, so the chain would refuse the signature.
test("a session with no spend limit is refused", async () => {
  const request = goldenRequest("create-and-revoke");
  for (const spendLimit of ["", undefined]) {
    const msgs = request.msgs.map((m) =>
      m.type === "/auth.m_create_session" ? { ...m, value: { ...m.value, spend_limit: spendLimit } } : m,
    );
    await assert.rejects(signTx({ ...request, msgs }), /session needs a spend limit/, String(spendLimit));
  }
});
