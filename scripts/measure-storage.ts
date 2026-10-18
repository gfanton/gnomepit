// Measures what each arena move locks in storage on a running `make dev`: alice and bob
// play the realm test's worked match twice, then a third that bob resigns after round 1,
// then carol and dave play the worked match, each through a session for the match, and a
// table per match gives each move's storage, gas, fee and deposit. On a fresh gnodev the
// first match carries the one-time costs, two new players, a new chunk, both players' first
// standings and ladder entries and the clan records, all but the chunk in its last Reveal;
// the second gives what a match between known players locks, and the third what a
// resignation costs. The fourth ends two players' first rated match on a ladder that already
// holds players, which adds more ladder nodes than the first match's ending did.
//
//   [CHAIN=<chain id>] node scripts/measure-storage.ts [rpc url]

import assert from "node:assert/strict";

import * as v from "valibot";

import { type Arena, cardIDs, createArena } from "../client/web/arena.ts";
import { type Broadcast, createChain, feeFor, gasWantedFor } from "../client/web/chain.ts";
import { type devAccounts, devWallet } from "../client/web/devwallet.ts";
import { nodeEngine } from "../client/web/engine-node.ts";
import type { MatchId } from "../client/web/ids.ts";
import { networks } from "../client/web/network.ts";
import * as signer from "../client/web/signer.ts";

const rpc = process.argv[2] ?? networks.local.rpc;
const { realm } = networks.local;
const chainId = process.env.CHAIN ?? networks.local.chainId;

// The worked match of r/arena/play_test.gno.
const deckA = "Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine";
const deckB = "Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche";
const picks = "Pick,Pick,Pick";
const braces = "Brace,Brace,Brace";

const engine = await nodeEngine();
const ids = (names: string) => cardIDs(names, engine.cards);

// What the script reads of a request it sends, and of a committed transaction's answer.
const RequestSchema = v.object({ method: v.string() });
const CommitSchema = v.object({
  result: v.object({
    deliver_tx: v.object({
      ResponseBase: v.object({
        Events: v.nullish(v.array(v.object({ "@type": v.optional(v.string()), fee_delta: v.optional(v.string()) }))),
      }),
    }),
  }),
});
type Row = { move: string; storage: number; gasUsed: number; fee: number; deposit: number };

// The last broadcast's answer, whose deposit events give the ugnot locked.
let answer: unknown;
const chain = createChain({
  rpc,
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (v.parse(RequestSchema, JSON.parse(init.body)).method !== "broadcast_tx_commit") return response;
    answer = await response.json();
    return { ok: response.ok, status: response.status, json: async () => answer };
  },
});
const landed: (Broadcast & { deposit: number })[] = [];
const broadcast = chain.broadcast.bind(chain);
chain.broadcast = async (tx) => {
  const result = await broadcast(tx);
  const deposits = (v.parse(CommitSchema, answer).result.deliver_tx.ResponseBase.Events ?? []).filter(
    (e) => e["@type"] === "/tm.StorageDepositEvent",
  );
  landed.push({ ...result, deposit: deposits.reduce((sum, e) => sum + parseInt(e.fee_delta ?? "", 10), 0) });
  return result;
};

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, value) => items.set(k, String(value)) };
}

function player(name: keyof typeof devAccounts): Arena {
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
const carol = player("carol");
const dave = player("dave");
for (const arena of [alice, bob, carol, dave]) {
  await arena.connect();
  assert.equal((await arena.authorize()).state, "active");
}

// step makes one move and returns its row: the fee is what payFor signs for that gas. An
// opening through a session lands the wallet's session transaction before the move.
async function step<T>(move: string, make: () => Promise<T>): Promise<{ id: T; row: Row }> {
  const price = await chain.gasPrice();
  const before = landed.length;
  const id = await make();
  const last = landed.at(-1);
  assert.ok(landed.length > before && last !== undefined, `${move} sends a transaction`);
  const { storage, gasUsed, deposit } = last;
  return { id, row: { move, storage, gasUsed, fee: feeFor(gasWantedFor(gasUsed), price), deposit } };
}

// playMatch plays the worked match, a challenging and b accepting.
async function playMatch(a: Arena, b: Arena): Promise<{ id: MatchId; rows: Row[] }> {
  const { id, row: posted } = await step("Challenge", () =>
    a.challenge({ clan: "Pickers", deck: ids(deckA), plan: ids("Chalk Dust,Double Tap") }),
  );
  const rows = [posted];
  const moves: [string, () => Promise<void>][] = [
    ["Accept", () => b.accept(id, { clan: "Ironhide", deck: ids(deckB), plan: ids("Hammer Blow,Spiked Shield") })],
    ["Reveal, round 1", () => a.move(id, ids(picks))],
    ["Play, round 2", () => b.move(id, ids(braces))],
    ["Reveal, round 2", () => a.move(id, ids(picks))],
    ["Play, round 3", () => b.move(id, ids(braces))],
    ["Reveal, round 3", () => a.finish(id)],
  ];
  for (const [move, make] of moves) rows.push((await step(move, make)).row);
  const ended = await a.match(id);
  assert.equal(ended.Phase, "ended");
  assert.equal(ended.Reason, "hp");
  return { id, rows };
}

// resignedMatch is the worked match's opening and first reveal, then bob's resignation.
async function resignedMatch(): Promise<{ id: MatchId; rows: Row[] }> {
  const { id, row: posted } = await step("Challenge", () =>
    alice.challenge({ clan: "Pickers", deck: ids(deckA), plan: ids("Chalk Dust,Double Tap") }),
  );
  const rows = [posted];
  const moves: [string, () => Promise<void>][] = [
    ["Accept", () => bob.accept(id, { clan: "Ironhide", deck: ids(deckB), plan: ids("Hammer Blow,Spiked Shield") })],
    ["Reveal, round 1", () => alice.move(id, ids(picks))],
    ["Resign", () => bob.resign(id)],
  ];
  for (const [move, make] of moves) rows.push((await step(move, make)).row);
  assert.equal((await alice.match(id)).Reason, "resign");
  return { id, rows };
}

const sum = (rows: Row[], column: Exclude<keyof Row, "move">) => rows.reduce((total, row) => total + row[column], 0);
const totals = (rows: Row[]): Row => ({
  move: "Total",
  storage: sum(rows, "storage"),
  gasUsed: sum(rows, "gasUsed"),
  fee: sum(rows, "fee"),
  deposit: sum(rows, "deposit"),
});
const n = (value: number) => value.toLocaleString("en-US");
const line = ({ move, storage, gasUsed, fee, deposit }: Row) =>
  `| ${move} | ${n(storage)} B | ${n(gasUsed)} | ${n(fee)} ugnot | ${n(deposit)} ugnot |`;

const opening = await playMatch(alice, bob);
assert.equal(opening.id, "1", "the first match must be the chain's first; restart gnodev");
const matches = [opening, await playMatch(alice, bob), await resignedMatch(), await playMatch(carol, dave)] as const;
for (const arena of [alice, bob, carol, dave])
  assert.equal(arena.account().mode, "session", "every move went through a session");

for (const { id, rows } of matches) {
  console.log(`\nMatch ${id}\n\n| Move | Storage | Gas used | Fee | Deposit |\n|---|---|---|---|---|`);
  for (const row of [...rows, totals(rows)]) console.log(line(row));
}
const [first, second] = [totals(matches[0].rows), totals(matches[1].rows)];
console.log(
  `\nOne-time costs, match ${matches[0].id} minus match ${matches[1].id}: ${n(first.storage - second.storage)} B, ${n(first.deposit - second.deposit)} ugnot deposit`,
);
for (const [label, match] of [
  ["on an empty ladder", matches[0]],
  ["on a ladder that holds players", matches[3]],
] as const) {
  const ending = match.rows.at(-1);
  assert.ok(ending?.move === "Reveal, round 3");
  console.log(
    `First rated ending ${label}, match ${match.id}'s Reveal, round 3: ${n(ending.gasUsed)} gas used, ${n(ending.deposit)} ugnot deposit`,
  );
}
process.exit(0);
