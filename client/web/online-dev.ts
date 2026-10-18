// A bare console for arena matches on a local chain, with no lobby: decks and plans are
// picked at random. Two browsers, one with ?dev=alice and one with ?dev=bob, play a match
// end to end. Without dev it uses Adena; &contract=1 has the wallet sign every move;
// &rpc=, &chain=, &realm= and &indexer= point it elsewhere, and an empty &indexer= polls.

import * as v from "valibot";

import { ArenaError, type Connection, type Listed, type MatchSummary, type Opening, createArena } from "./arena.ts";
import { randomDeck, randomPlan } from "./bot.ts";
import { ChainError, createChain } from "./chain.ts";
import { devWallet } from "./devwallet.ts";
import { elementById } from "./dom.ts";
import { type GameState, type Side, loadEngine } from "./engine.ts";
import type { MatchId } from "./ids.ts";
import { createIndexer } from "./indexer.ts";
import { networkFrom, networks } from "./network.ts";
import * as signer from "./signer.ts";
import { type Wallet, WalletError, waitForAdena } from "./wallet.ts";

const params = new URLSearchParams(location.search);
const { chainId, rpc, realm, indexer: indexerURL } = networkFrom(params, networks.local);
const devName = params.get("dev");
const DevNameSchema = v.picklist(["alice", "bob"]);

const engine = await loadEngine("engine.wasm", "cards.json");
const chain = createChain({ rpc });
const wallet: Wallet | undefined =
  devName === null
    ? await waitForAdena()
    : devWallet({ name: v.parse(DevNameSchema, devName), signer, chain, chainId });
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

for (const clan of engine.clans) elementById("clan", HTMLSelectElement).append(new Option(clan.name, clan.name));

function log(text: string): void {
  const line = document.createElement("li");
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  elementById("log", HTMLOListElement).prepend(line);
}

// run logs an action and its outcome, then refreshes the lists.
async function run(label: string, action: () => Promise<unknown>): Promise<void> {
  log(`${label}…`);
  try {
    const out = await action();
    log(`${label}: done${typeof out === "string" ? ` (${out})` : ""}`);
  } catch (err) {
    log(`${label}: ${failure(err)}`);
  }
  await refresh();
}

// failure names an arena, chain or wallet error by its type and reason, another by its message.
function failure(err: unknown): string {
  if (err instanceof ArenaError || err instanceof ChainError || err instanceof WalletError)
    return `${err.type}: ${err.reason}`;
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}

function showStatus(account: Connection): string {
  const settled = "address" in account ? account : null;
  connected = settled !== null;
  const reason = settled?.fallback ?? "";
  const fallback = reason === "" ? "" : `, fallback: ${reason}`;
  elementById("status", HTMLParagraphElement).textContent =
    `${settled?.address ?? "no address"}: ${account.state}, mode ${settled?.mode ?? "?"}${fallback}`;
  return account.state;
}

const startState = (): GameState => {
  const gnome = () => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] });
  return { round: 1, gnomes: [gnome(), gnome()] };
};
const clanOf = (name: string) => engine.clans.find((c) => c.name === name);
const short = (address: string) => (address === "" ? "" : `${address.slice(0, 8)}…${address.slice(-4)}`);

function opening(side: Side): Opening {
  const clan = clanOf(elementById("clan", HTMLSelectElement).value);
  if (clan === undefined) throw new Error("No clan is picked");
  const deck = randomDeck(clan, engine.cards, Math.random);
  const plan = randomPlan(engine.legalPlans({ state: startState(), side, deck }), Math.random);
  return { clan: clan.name, deck, plan };
}

function button(label: string, action: string, id: MatchId, handler: () => Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.dataset.action = action;
  b.dataset.id = id;
  b.onclick = handler;
  return b;
}

function row(cells: string[], buttons: HTMLButtonElement[]): HTMLTableRowElement {
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

async function play(id: MatchId): Promise<string> {
  const view = await arena.match(id);
  if (view.planning === undefined)
    throw new ArenaError("unauthorized", "Authorize this device to open your sealed plan");
  const { state, side, deck } = view.planning;
  const plan = randomPlan(engine.legalPlans({ state, side, deck }), Math.random);
  await arena.move(id, plan);
  return `round ${view.Round}`;
}

function actionButtons(m: Listed<MatchSummary>): HTMLButtonElement[] {
  const id = m.ID;
  const out: HTMLButtonElement[] = [];
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

async function refresh(): Promise<void> {
  try {
    const board = await arena.openChallenges();
    elementById("board", HTMLTableSectionElement).replaceChildren(
      ...board.map((c) =>
        row(
          [c.ID, c.Clan, short(c.Challenger), c.Opponent === "" ? "anyone" : short(c.Opponent)],
          c.action === "accept"
            ? [button("Accept", "accept", c.ID, () => run(`accept ${c.ID}`, () => arena.accept(c.ID, opening(1))))]
            : [],
        ),
      ),
    );
    if (!connected) return;
    const mine = await arena.myMatches();
    const views = await Promise.all(mine.map(async (m) => (m.Phase === "open" ? m : arena.match(m.ID))));
    elementById("matches", HTMLTableSectionElement).replaceChildren(
      ...views.map((m) =>
        row(
          [
            m.ID,
            m.Result === "" ? m.Phase : `${m.Phase}: ${m.Result} by ${m.Reason}`,
            String(m.Round),
            `${m.ChallengerClan} v ${m.AcceptorClan === "" ? "?" : m.AcceptorClan}`,
            ("HP" in m ? m.HP : []).map((hp) => hp.join("-")).join(" "),
            short(m.ToMove),
          ],
          actionButtons(m),
        ),
      ),
    );
  } catch (err) {
    log(`refresh: ${failure(err)}`);
  }
}

elementById("connect", HTMLButtonElement).onclick = () => run("connect", async () => showStatus(await arena.connect()));
elementById("authorize", HTMLButtonElement).onclick = () =>
  run("authorize", async () => showStatus(await arena.authorize()));
elementById("post", HTMLButtonElement).onclick = () =>
  run("post", () =>
    arena.challenge({ ...opening(0), opponent: elementById("opponent", HTMLInputElement).value.trim() }),
  );

log(wallet === undefined ? "no Adena in this browser" : `wallet: ${devName ?? "Adena"}, chain ${chainId} at ${rpc}`);
await refresh();
arena.subscribe((change) => {
  if ("func" in change)
    log(`chain: ${short(change.caller)} called ${change.func}${change.match === null ? "" : ` on ${change.match}`}`);
  void refresh();
});
