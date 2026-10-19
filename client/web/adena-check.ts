// Adena checks, one button each, against a local gnodev: the root signature
// is stable, Adena creates a session the page then signs with, Adena revokes a dead
// session, and Adena signs a move itself. ?dev=alice runs the page with the dev wallet
// instead, to test the page.

import * as v from "valibot";

import {
  type AccountState,
  type Arena,
  ArenaError,
  type Listed,
  type OpenChallenge,
  createArena,
  sessionLocks,
} from "./arena.ts";
import { pageWallet } from "./arena-provider.ts";
import { randomDeck, randomPlan } from "./bot.ts";
import { ChainError, createChain } from "./chain.ts";
import { elementById } from "./dom.ts";
import { loadEngine, startState } from "./engine.ts";
import { createReader } from "./gnovalue.ts";
import type { Address } from "./ids.ts";
import { networkFrom, networks } from "./network.ts";
import * as signer from "./signer.ts";
import { WalletError, answer, replyOf, rootText } from "./wallet.ts";

const params = new URLSearchParams(location.search);
const { chainId, rpc, realm } = networkFrom(params, networks.local);
// The part of SignArbitrary's answer the check reads.
const SignatureSchema = v.object({ signature: v.object({ signature: v.string() }) });

const engine = await loadEngine("engine.wasm", "cards.json");
const chain = createChain({ rpc });
const read = createReader(chain);
const wallet = await pageWallet(params.get("dev"), { signer, chain, chainId });
const options = { chain, wallet, engine, signer, realm, chainId, origin: location.origin, storage: localStorage };
const bySession = createArena(options);
const byWallet = createArena({ ...options, signEachMove: true });

// check runs a check and writes its outcome; a check returns [passed, text].
function check(buttonId: string, outputId: string, run: () => Promise<[boolean, string]>): void {
  const button = elementById(buttonId, HTMLButtonElement);
  const output = elementById(outputId, HTMLOutputElement);
  button.onclick = async () => {
    button.disabled = true;
    output.dataset.verdict = "";
    output.textContent = "Running…";
    try {
      const [passed, text] = await run();
      output.dataset.verdict = passed ? "pass" : "fail";
      output.textContent = `${passed ? "PASS" : "FAIL"}: ${text}`;
    } catch (err) {
      output.dataset.verdict = "fail";
      output.textContent = `FAIL: ${failure(err)}`;
    } finally {
      button.disabled = false;
    }
  };
}

function failure(err: unknown): string {
  if (err instanceof ArenaError || err instanceof ChainError || err instanceof WalletError)
    return `${err.type}: ${err.reason}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// connected connects arena; without a wallet on the network the check fails with the reason.
async function connected(arena: Arena): Promise<AccountState & { address: Address }> {
  const account = await arena.connect();
  if ("reason" in account) throw new ArenaError(account.state, account.reason);
  const { address } = account;
  if (address === null) throw new ArenaError("noWallet", "The wallet connected no account");
  return { ...account, address };
}

// post posts a random challenge through arena and reads it back from the board.
async function post(arena: Arena): Promise<Listed<OpenChallenge> | undefined> {
  const clan = engine.clans[0];
  if (clan === undefined) throw new Error("The card file names no clan");
  const deck = randomDeck(clan, engine.cards, Math.random);
  const start = startState(engine.hp);
  const plan = randomPlan(engine.legalPlans({ state: start, side: 0, deck }), Math.random);
  const id = await arena.challenge({ clan: clan.name, deck, plan });
  return (await arena.openChallenges()).find((c) => c.ID === id);
}

elementById("add-network", HTMLButtonElement).onclick = async () => {
  const connection = elementById("connection", HTMLOutputElement);
  if (wallet === undefined) {
    connection.textContent = "No Adena in this browser.";
    return;
  }
  const added = replyOf(await wallet.AddNetwork?.({ chainId, chainName: "Gnomepit gnodev", rpcUrl: rpc }));
  connection.textContent = `AddNetwork: ${added?.status ?? "not offered"} ${added?.type ?? ""} ${added?.message ?? ""}`;
};

check("connect", "connection", async () => {
  const account = await bySession.connect();
  const adenaVersion: unknown = wallet !== undefined && "version" in wallet ? wallet.version : undefined;
  const version = typeof adenaVersion === "string" || typeof adenaVersion === "number" ? `, Adena ${adenaVersion}` : "";
  const address = "address" in account ? account.address : null;
  return [address !== null, `${account.state} ${address ?? ("reason" in account ? account.reason : "")}${version}`];
});

check("check-signature", "signature", async () => {
  const { address } = await connected(bySession);
  const sign = async () =>
    answer(await wallet?.SignArbitrary({ signer: address, data: rootText(location.origin) }), SignatureSchema).signature
      .signature;
  const [first, second] = [await sign(), await sign()];
  return [first === second, first === second ? `both signatures are ${first}` : `first ${first}\nsecond ${second}`];
});

// Posting asks Adena for the match's session; the mode stays "session" only if the
// Challenge was signed with it. An earlier run's fallback would skip the request.
check("check-session", "session", async () => {
  const { address } = await connected(bySession);
  await bySession.authorize();
  bySession.resumeSessions();
  const posted = await post(bySession);
  const account = await connected(bySession);
  if (account.mode !== "session")
    return [false, `no session: mode ${account.mode}, reason: ${account.fallback ?? "none"}`];
  return [posted?.Challenger === address, `match ${posted?.ID} posted by ${posted?.Challenger} through its session`];
});

// A withdrawn challenge leaves its session dead, so the next post's one approval revokes it
// beside the session it creates.
check("check-revoke", "revoke", async () => {
  const { address } = await connected(bySession);
  await bySession.authorize();
  bySession.resumeSessions();
  const withdrawn = await post(bySession);
  const [lock] = (await sessionLocks(read, realm, address)).filter((l) => l.Match === withdrawn?.ID);
  if (lock === undefined || withdrawn === undefined)
    return [false, `no session locked to match ${withdrawn?.ID}: mode ${bySession.account().mode}`];
  await bySession.resign(withdrawn.ID);
  const posted = await post(bySession);
  const account = bySession.account();
  if (account.mode !== "session")
    return [false, `no session: mode ${account.mode}, reason: ${account.fallback ?? "none"}`];
  const kept = (await chain.sessions(address)).some((s) => s.address === lock.Session && s.expiresAt === lock.Expires);
  return [
    !kept && posted?.Challenger === address,
    `match ${withdrawn.ID} withdrawn, its session ${lock.Session} ${kept ? "still on the chain" : "revoked"}; match ${posted?.ID} posted through a new session`,
  ];
});

check("check-contract", "contract", async () => {
  const { address } = await connected(byWallet);
  await byWallet.authorize(); // the root signature, whose box key seals the challenge
  const posted = await post(byWallet);
  return [posted?.Challenger === address, `match ${posted?.ID} posted by ${posted?.Challenger}`];
});

elementById("forget", HTMLButtonElement).onclick = () => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith(`gnomepit:${chainId}:`));
  for (const key of keys) localStorage.removeItem(key);
  elementById("forgotten", HTMLOutputElement).textContent =
    `Forgot ${keys.length} stored values; the next check asks Adena again.`;
};
