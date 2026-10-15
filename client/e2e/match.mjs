// Plays one whole arena match on a running `make dev`: alice signs through a session,
// bob through his wallet on every move. It checks that both players see the same
// result, and that the page's replay agrees with the realm's HP.
//
//   node client/e2e/match.mjs [rpc url]

import assert from "node:assert/strict";

import { createArena } from "../web/arena.mjs";
import { createChain } from "../web/chain.mjs";
import { devWallet } from "../web/devwallet.mjs";
import { nodeEngine } from "../web/engine-node.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:36657";
const realm = "gno.land/r/gfanton/gnomehall/arena";
const chainId = "dev";

const engine = await nodeEngine();
const chain = createChain({ rpc });

function memory() {
  const items = new Map();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
}

function player(name, signEachMove) {
  const wallet = devWallet({ name, signer: engine, chain, chainId });
  return createArena({ chain, wallet, engine, realm, chainId, origin: "http://e2e.local", storage: memory(), signEachMove });
}

const deckOf = (clan) => {
  const { cards } = engine.clans.find((c) => c.name === clan);
  return cards.slice(0, 8).some((id) => engine.cards[id].rare) ? cards.slice(0, 8) : [...cards.slice(0, 7), cards.find((id) => engine.cards[id].rare)];
};
const decks = { a: deckOf("Pickers"), b: deckOf("Ironhide") };
for (const [clan, deck] of [["Pickers", decks.a], ["Ironhide", decks.b]]) assert.equal(engine.legalDeck({ clan, deck }), true);

// planFor picks a legal plan that spends a special when one is left, so rounds differ.
function planFor(state, side, deck) {
  const plans = engine.legalPlans({ state, side, deck });
  return plans.find((p) => p.some((id) => engine.cards[id].special)) ?? plans[0];
}

const log = (...line) => console.log(...line);
const alice = player("alice", false);
const bob = player("bob", true);

for (const [name, arena] of [["alice", alice], ["bob", bob]]) {
  const before = await arena.connect();
  const after = await arena.authorize();
  log(`${name}: ${before.state} -> ${after.state} (${after.mode})${after.fallback ? `, fallback: ${after.fallback}` : ""}`);
  assert.equal(after.state, "active");
}
assert.equal((await alice.connect()).mode, "session");

const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) };
const id = await alice.challenge({ clan: "Pickers", deck: decks.a, plan: planFor(start, 0, decks.a) });
log(`match ${id} posted`);
assert.equal((await bob.openChallenges()).find((c) => c.ID === id)?.action, "accept");
await bob.accept(id, { clan: "Ironhide", deck: decks.b, plan: planFor(start, 1, decks.b) });
log(`match ${id} accepted`);

for (let moves = 0; moves < 10; moves++) {
  const a = await alice.match(id);
  if (a.Phase === "ended") break;
  if (a.action === "move") {
    log(`alice reveals round ${a.Round} (${a.pending.result}) and seals the next`);
    await alice.move(id, planFor(a.pending.state, 0, decks.a));
  } else if (a.action === "finish") {
    log(`alice reveals round ${a.Round}, the last`);
    await alice.finish(id);
  }
  const b = await bob.match(id);
  if (b.action === "move") {
    log(`bob plays round ${b.Round}`);
    await bob.move(id, planFor(b.state, 1, decks.b));
  }
}

const seenByAlice = await alice.match(id);
const seenByBob = await bob.match(id);
assert.equal(seenByAlice.Phase, "ended");
assert.equal(seenByAlice.Result, seenByBob.Result);
assert.equal(seenByAlice.action, "done");
const last = seenByAlice.rounds.at(-1);
assert.equal(last.result, seenByAlice.Result, "the page's replay ends the match the way the realm did");
log(`match ${id} ended: ${seenByAlice.Result} by ${seenByAlice.Reason}, HP ${JSON.stringify(seenByAlice.HP)}`);
process.exit(0);
