// A bare console for arena matches on a local chain, with no lobby: decks and plans are
// picked at random. Two browsers, one with ?dev=alice and one with ?dev=bob, play a match
// end to end. Without dev it uses Adena; &contract=1 has the wallet sign every move;
// &rpc=, &chain=, &realm= and &indexer= point it elsewhere, and an empty &indexer= polls.

import { ArenaError, createArena } from "./arena.mjs";
import { randomDeck, randomPlan } from "./bot.ts";
import { createChain } from "./chain.ts";
import { devWallet } from "./devwallet.ts";
import { loadEngine } from "./engine.ts";
import { createIndexer } from "./indexer.ts";
import { networkFrom, networks } from "./network.ts";
import * as signer from "./signer.ts";
import { waitForAdena } from "./wallet.ts";

const params = new URLSearchParams(location.search);
const { chainId, rpc, realm, indexer: indexerURL } = networkFrom(params, networks.local);
const devName = params.get("dev");

const $ = (id) => document.getElementById(id);
const engine = await loadEngine("engine.wasm", "cards.json");
const chain = createChain({ rpc });
const wallet = devName === null ? await waitForAdena() : devWallet({ name: devName, signer, chain, chainId });
const indexer = indexerURL === null ? undefined : createIndexer({ url: indexerURL });
const arena = createArena({
  chain,
  wallet,
  engine,
  signer,
  realm,
  chainId,
  origin: location.origin,
  storage: localStorage,
  indexer,
  signEachMove: params.get("contract") === "1",
});
let connected = false;

for (const clan of engine.clans) $("clan").append(new Option(clan.name, clan.name));

function log(text) {
  const line = document.createElement("li");
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  $("log").prepend(line);
}

// run logs an action and its outcome, then refreshes the lists.
async function run(label, action) {
  log(`${label}…`);
  try {
    const out = await action();
    log(`${label}: done${out === undefined ? "" : ` (${out})`}`);
  } catch (err) {
    log(`${label}: ${err.type ?? "error"}: ${err.reason ?? err.message}`);
  }
  await refresh();
}

function showStatus(account) {
  connected = account.address !== undefined;
  const fallback = account.fallback ? `, fallback: ${account.fallback}` : "";
  $("status").textContent =
    `${account.address ?? "no address"}: ${account.state}, mode ${account.mode ?? "?"}${fallback}`;
  return account.state;
}

const startState = () => ({
  round: 1,
  gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })),
});
const clanOf = (name) => engine.clans.find((c) => c.name === name);
const short = (address) => (address === "" ? "" : `${address.slice(0, 8)}…${address.slice(-4)}`);

function opening(side) {
  const clan = clanOf($("clan").value);
  const deck = randomDeck(clan, engine.cards, Math.random);
  const plan = randomPlan(engine.legalPlans({ state: startState(), side, deck }), Math.random);
  return { clan: clan.name, deck, plan };
}

function button(label, action, id, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.dataset.action = action;
  b.dataset.id = id;
  b.onclick = handler;
  return b;
}

function row(cells, buttons) {
  const tr = document.createElement("tr");
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  const td = document.createElement("td");
  td.append(...buttons);
  tr.append(td);
  return tr;
}

async function play(id) {
  const view = await arena.match(id);
  if (view.planning === undefined)
    throw new ArenaError("unauthorized", "Authorize this device to open your sealed plan");
  const { state, side, deck } = view.planning;
  const plan = randomPlan(engine.legalPlans({ state, side, deck }), Math.random);
  await arena.move(id, plan);
  return `round ${view.Round}`;
}

function actionButtons(m) {
  const id = m.ID;
  const out = [];
  if (m.action === "move") out.push(button("Move", "move", id, () => run(`move in ${id}`, () => play(id))));
  if (m.action === "finish")
    out.push(button("Finish", "finish", id, () => run(`finish ${id}`, () => arena.finish(id))));
  if (m.action === "claimForfeit")
    out.push(button("Claim forfeit", "claimForfeit", id, () => run(`claim ${id}`, () => arena.claimForfeit(id))));
  if (m.Phase === "open" || m.Phase === "reveal" || m.Phase === "play") {
    out.push(
      button(m.Phase === "open" ? "Withdraw" : "Resign", "resign", id, () =>
        run(`resign ${id}`, () => arena.resign(id)),
      ),
    );
  }
  return out;
}

async function refresh() {
  try {
    const board = await arena.openChallenges();
    $("board").replaceChildren(
      ...board.map((c) =>
        row(
          [c.ID, c.Clan, short(c.Challenger), short(c.Opponent) || "anyone"],
          c.action === "accept"
            ? [button("Accept", "accept", c.ID, () => run(`accept ${c.ID}`, () => arena.accept(c.ID, opening(1))))]
            : [],
        ),
      ),
    );
    if (!connected) return;
    const mine = await arena.myMatches();
    const views = await Promise.all(mine.map((m) => (m.Phase === "open" ? m : arena.match(m.ID))));
    $("matches").replaceChildren(
      ...views.map((m) =>
        row(
          [
            m.ID,
            m.Result === "" ? m.Phase : `${m.Phase}: ${m.Result} by ${m.Reason}`,
            String(m.Round),
            `${m.ChallengerClan} v ${m.AcceptorClan || "?"}`,
            (m.HP ?? []).map((hp) => hp.join("-")).join(" "),
            short(m.ToMove),
          ],
          actionButtons(m),
        ),
      ),
    );
  } catch (err) {
    log(`refresh: ${err.type ?? "error"}: ${err.reason ?? err.message}`);
  }
}

$("connect").onclick = () => run("connect", async () => showStatus(await arena.connect()));
$("authorize").onclick = () => run("authorize", async () => showStatus(await arena.authorize()));
$("post").onclick = () => run("post", () => arena.challenge({ ...opening(0), opponent: $("opponent").value.trim() }));

log(wallet === undefined ? "no Adena in this browser" : `wallet: ${devName ?? "Adena"}, chain ${chainId} at ${rpc}`);
await refresh();
arena.subscribe((change) => {
  if (change.func !== undefined)
    log(`chain: ${short(change.caller)} called ${change.func}${change.match === null ? "" : ` on ${change.match}`}`);
  void refresh();
});
