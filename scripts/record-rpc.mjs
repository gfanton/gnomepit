// Records raw JSON-RPC answers from a running `make dev` into client/web/testdata/rpc:
// every answer chain.mjs's tests and the dev wallet's tests replay. It signs as the dev
// wallet's alice, and creates one more session for her on each run.
//
//   [CHAIN=<chain id>] node scripts/record-rpc.mjs [rpc url]

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import { nodeEngine } from "../client/web/engine-node.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:36657";
const chainId = process.env.CHAIN ?? "gnomehall-dev";
const out = new URL("../client/web/testdata/rpc/", import.meta.url);
const arena = "gno.land/r/gfanton/gnomehall/arena";
const devKey = (name) => createHash("sha256").update(`gnomehall dev ${name}`).digest("hex");
const seal = "0101010101010101010101010101010101010101010101010101010101010101";
const box = btoa("box");

const engine = await nodeEngine();
const alice = { key: devKey("alice"), ...engine.keyInfo(devKey("alice")) };
const nobody = engine.keyInfo(devKey("nobody"));

async function rpcCall(method, params) {
  const res = await fetch(rpc, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return res.json();
}
const query = (path, data = "") => rpcCall("abci_query", { path, data: btoa(data) });
const record = (name, answer) => writeFile(new URL(`${name}.json`, out), `${JSON.stringify(answer, null, 2)}\n`);

function call(func, args, sequence, accountNumber) {
  return engine.signTx({
    chainId,
    accountNumber,
    sequence,
    privKey: alice.key,
    fee: { gasWanted: 100_000_000, gasFee: "100000ugnot" },
    msgs: [{ type: "/vm.m_call", value: { caller: alice.address, send: "", max_deposit: "", pkg_path: arena, func, args } }],
  });
}

await mkdir(out, { recursive: true });
const account = await query(`auth/accounts/${alice.address}`);
await record("account", account);
await record("account-missing", await query(`auth/accounts/${nobody.address}`));
await record("gasprice", await query("auth/gasprice"));
await record("qeval-ok", await query("vm/qeval_json", `${arena}.Open(0, 50)`));
await record("qeval-error", await query("vm/qeval_json", `${arena}.Match("99")`));
await record("qtype", await query("vm/qtype_json", `${arena}.OpenChallenge`));

const { account_number: accountNumber, sequence } = JSON.parse(atob(account.result.response.ResponseBase.Data)).BaseAccount;
const challenge = call("Challenge", ["Pickers", seal, seal, box, ""], Number(sequence), Number(accountNumber));
await record("simulate", await rpcCall("abci_query", { path: ".app/simulate", data: challenge }));
await record("simulate-error", await rpcCall("abci_query", {
  path: ".app/simulate",
  data: call("Accept", ["99", "Ironhide", "x", "y"], Number(sequence), Number(accountNumber)),
}));
await record("broadcast-ok", await rpcCall("broadcast_tx_commit", { tx: challenge }));
await record("broadcast-duplicate", await rpcCall("broadcast_tx_commit", { tx: challenge }));
await record("broadcast-checktx", await rpcCall("broadcast_tx_commit", {
  tx: call("Challenge", ["Pickers", seal, seal, box, ""], Number(sequence) + 5, Number(accountNumber)),
}));
await record("broadcast-delivertx", await rpcCall("broadcast_tx_commit", {
  tx: call("Accept", ["99", "Ironhide", "x", "y"], Number(sequence) + 1, Number(accountNumber)),
}));

// A session for a key named after alice's current sequence, so each run makes a new one,
// then a call that key signs for alice.
const session = engine.keyInfo(createHash("sha256").update(`gnomehall dev alice session ${sequence}`).digest("hex"));
const sessionKey = createHash("sha256").update(`gnomehall dev alice session ${sequence}`).digest("hex");
await record("broadcast-session-create", await rpcCall("broadcast_tx_commit", {
  tx: engine.signTx({
    chainId,
    accountNumber: Number(accountNumber),
    sequence: Number(sequence) + 2,
    privKey: alice.key,
    fee: { gasWanted: 10_000_000, gasFee: "10000ugnot" },
    msgs: [{
      type: "/auth.m_create_session",
      value: {
        creator: alice.address,
        session_key: { "@type": "/tm.PubKeySecp256k1", value: session.pubKey },
        expires_at: String(Math.floor(Date.now() / 1000) + 7 * 24 * 3600),
        allow_paths: [`vm/exec:${arena}`],
        spend_limit: "1000000ugnot",
        spend_period: "0",
      },
    }],
  }),
}));
await record("sessions", await query(`auth/accounts/${alice.address}/sessions`));
const sessionAccount = await query(`auth/accounts/${alice.address}/session/${session.address}`);
await record("session", sessionAccount);
await record("session-missing", await query(`auth/accounts/${alice.address}/session/${nobody.address}`));
const { BaseAccount: s } = JSON.parse(atob(sessionAccount.result.response.ResponseBase.Data)).BaseSessionAccount;
await record("broadcast-session-call", await rpcCall("broadcast_tx_commit", {
  tx: engine.signTx({
    chainId,
    accountNumber: Number(s.account_number),
    sequence: Number(s.sequence),
    privKey: sessionKey,
    sessionAddr: session.address,
    fee: { gasWanted: 30_000_000, gasFee: "30000ugnot" },
    msgs: [{ type: "/vm.m_call", value: { caller: alice.address, send: "", max_deposit: "", pkg_path: arena, func: "Challenge", args: ["Ironhide", seal, seal, btoa("session"), ""] } }],
  }),
}));
process.exit(0);
