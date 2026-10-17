// Measures what each arena move locks in storage on a running `make dev`: alice and bob
// play the realm test's worked match twice, each through a session for the match, and a
// table per match gives each move's storage, gas, fee and deposit. On a fresh gnodev the
// first match carries the one-time costs, two new players and a new chunk, and the second
// gives what a match between known players locks.
//
//   [CHAIN=<chain id>] node scripts/measure-storage.mjs [rpc url]

import assert from "node:assert/strict";

import { cardIDs, createArena } from "../client/web/arena.mjs";
import { createChain, feeFor, gasWantedFor } from "../client/web/chain.mjs";
import { devWallet } from "../client/web/devwallet.mjs";
import { nodeEngine } from "../client/web/engine-node.mjs";
import * as signer from "../client/web/signer.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:36657";
const realm = "gno.land/r/gfanton/gnomehall/arena";
const chainId = process.env.CHAIN ?? "gnomehall-dev";

// The worked match of r/arena/play_test.gno.
const deckA = "Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine";
const deckB = "Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche";
const picks = "Pick,Pick,Pick";
const braces = "Brace,Brace,Brace";

const engine = await nodeEngine();
const ids = (names) => cardIDs(names, engine.cards);

// The last broadcast's answer, whose deposit events give the ugnot locked.
let answer;
const chain = createChain({
  rpc,
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (JSON.parse(init.body).method !== "broadcast_tx_commit") return response;
    answer = await response.json();
    return { ok: response.ok, status: response.status, json: async () => answer };
  },
});
const landed = [];
const broadcast = chain.broadcast;
chain.broadcast = async (tx) => {
  const result = await broadcast(tx);
  const deposits = (answer.result.deliver_tx.ResponseBase.Events ?? []).filter(
    (e) => e["@type"] === "/tm.StorageDepositEvent",
  );
  landed.push({ ...result, deposit: deposits.reduce((sum, e) => sum + parseInt(e.fee_delta, 10), 0) });
  return result;
};

function memory() {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
}

function player(name) {
  const wallet = devWallet({ name, signer, chain, chainId });
  return createArena({
    chain,
    wallet,
    engine,
    signer,
    realm,
    chainId,
    origin: "http://measure.local",
    storage: memory(),
  });
}

const alice = player("alice");
const bob = player("bob");
for (const arena of [alice, bob]) {
  await arena.connect();
  assert.equal((await arena.authorize()).state, "active");
}

// step makes one move and returns its row: the fee is what payFor signs for that gas. An
// opening through a session lands the wallet's session transaction before the move.
async function step(move, make) {
  const price = await chain.gasPrice();
  const before = landed.length;
  const id = await make();
  assert.ok(landed.length > before, `${move} sends a transaction`);
  const { storage, gasUsed, deposit } = landed.at(-1);
  return { id, row: { move, storage, gasUsed, fee: feeFor(gasWantedFor(gasUsed), price), deposit } };
}

async function playMatch() {
  const { id, row: posted } = await step("Challenge", () =>
    alice.challenge({ clan: "Pickers", deck: ids(deckA), plan: ids("Chalk Dust,Double Tap") }),
  );
  const rows = [posted];
  const moves = [
    ["Accept", () => bob.accept(id, { clan: "Ironhide", deck: ids(deckB), plan: ids("Hammer Blow,Spiked Shield") })],
    ["Reveal, round 1", () => alice.move(id, ids(picks))],
    ["Play, round 2", () => bob.move(id, ids(braces))],
    ["Reveal, round 2", () => alice.move(id, ids(picks))],
    ["Play, round 3", () => bob.move(id, ids(braces))],
    ["Reveal, round 3", () => alice.finish(id)],
  ];
  for (const [move, make] of moves) rows.push((await step(move, make)).row);
  const ended = await alice.match(id);
  assert.equal(ended.Phase, "ended");
  assert.equal(ended.Reason, "hp");
  return { id, rows };
}

const sum = (rows, column) => rows.reduce((total, row) => total + row[column], 0);
const totals = (rows) => ({
  move: "Total",
  ...Object.fromEntries(["storage", "gasUsed", "fee", "deposit"].map((c) => [c, sum(rows, c)])),
});
const n = (value) => value.toLocaleString("en-US");
const line = ({ move, storage, gasUsed, fee, deposit }) =>
  `| ${move} | ${n(storage)} B | ${n(gasUsed)} | ${n(fee)} ugnot | ${n(deposit)} ugnot |`;

const matches = [await playMatch()];
assert.equal(matches[0].id, "1", "the first match must be the chain's first; restart gnodev");
matches.push(await playMatch());
for (const arena of [alice, bob]) assert.equal(arena.account().mode, "session", "every move went through a session");

for (const { id, rows } of matches) {
  console.log(`\nMatch ${id}\n\n| Move | Storage | Gas used | Fee | Deposit |\n|---|---|---|---|---|`);
  for (const row of [...rows, totals(rows)]) console.log(line(row));
}
const [first, second] = matches.map(({ rows }) => totals(rows));
console.log(
  `\nOne-time costs, match ${matches[0].id} minus match ${matches[1].id}: ${n(first.storage - second.storage)} B, ${n(first.deposit - second.deposit)} ugnot deposit`,
);
process.exit(0);
