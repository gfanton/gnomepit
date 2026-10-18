// The spec's Adena checks, one button each, against a local gnodev: the root signature
// is stable, Adena creates a session the page then signs with, Adena revokes a dead
// session, and Adena signs a move itself. ?dev=alice runs the page with the dev wallet
// instead, to test the page.

import { createArena } from "./arena.mjs";
import { randomDeck, randomPlan } from "./bot.ts";
import { createChain } from "./chain.ts";
import { devWallet } from "./devwallet.mjs";
import { loadEngine } from "./engine.ts";
import { createReader } from "./gnovalue.ts";
import { networkFrom, networks } from "./network.ts";
import * as signer from "./signer.mjs";
import { answer, rootText, waitForAdena } from "./wallet.mjs";

const params = new URLSearchParams(location.search);
const { chainId, rpc, realm } = networkFrom(params, networks.local);
const devName = params.get("dev");

const $ = (id) => document.getElementById(id);
const engine = await loadEngine("engine.wasm", "cards.json");
const chain = createChain({ rpc });
const read = createReader(chain);
const wallet = devName === null ? await waitForAdena() : devWallet({ name: devName, signer, chain, chainId });
const options = { chain, wallet, engine, signer, realm, chainId, origin: location.origin, storage: localStorage };
const bySession = createArena(options);
const byWallet = createArena({ ...options, signEachMove: true });

// check runs a check and writes its outcome; a check returns [passed, text].
function check(button, output, run) {
  $(button).onclick = async () => {
    $(button).disabled = true;
    $(output).dataset.verdict = "";
    $(output).textContent = "Running…";
    try {
      const [passed, text] = await run();
      $(output).dataset.verdict = passed ? "pass" : "fail";
      $(output).textContent = `${passed ? "PASS" : "FAIL"}: ${text}`;
    } catch (err) {
      $(output).dataset.verdict = "fail";
      $(output).textContent = `FAIL: ${err.type ?? err.name}: ${err.reason ?? err.message}`;
    } finally {
      $(button).disabled = false;
    }
  };
}

// post posts a random challenge through arena and reads it back from the board.
async function post(arena) {
  const clan = engine.clans[0];
  const deck = randomDeck(clan, engine.cards, Math.random);
  const start = { round: 1, gnomes: [0, 1].map(() => ({ hp: engine.hp, vulnerable: 0, strength: 0, spent: [] })) };
  const plan = randomPlan(engine.legalPlans({ state: start, side: 0, deck }), Math.random);
  const id = await arena.challenge({ clan: clan.name, deck, plan });
  return (await arena.openChallenges()).find((c) => c.ID === id);
}

$("add-network").onclick = async () => {
  if (wallet === undefined) return void ($("connection").textContent = "No Adena in this browser.");
  const added = await wallet.AddNetwork?.({ chainId, chainName: "Gnomehall gnodev", rpcUrl: rpc });
  $("connection").textContent =
    `AddNetwork: ${added?.status ?? "not offered"} ${added?.type ?? ""} ${added?.message ?? ""}`;
};

check("connect", "connection", async () => {
  const account = await bySession.connect();
  const version = wallet?.version === undefined ? "" : `, Adena ${wallet.version}`;
  return [account.address !== undefined, `${account.state} ${account.address ?? account.reason ?? ""}${version}`];
});

check("check-signature", "signature", async () => {
  const { address } = await bySession.connect();
  const sign = async () =>
    answer(await wallet.SignArbitrary({ signer: address, data: rootText(location.origin) })).signature.signature;
  const [first, second] = [await sign(), await sign()];
  return [first === second, first === second ? `both signatures are ${first}` : `first ${first}\nsecond ${second}`];
});

// Posting asks Adena for the match's session; the mode stays "session" only if the
// Challenge was signed with it. An earlier run's fallback would skip the request.
check("check-session", "session", async () => {
  const { address } = await bySession.connect();
  await bySession.authorize();
  bySession.resumeSessions();
  const posted = await post(bySession);
  const account = await bySession.connect();
  if (account.mode !== "session")
    return [false, `no session: mode ${account.mode}, reason: ${account.fallback ?? "none"}`];
  return [posted?.Challenger === address, `match ${posted?.ID} posted by ${posted?.Challenger} through its session`];
});

// A withdrawn challenge leaves its session dead, so the next post's one approval revokes it
// beside the session it creates.
check("check-revoke", "revoke", async () => {
  const { address } = await bySession.connect();
  await bySession.authorize();
  bySession.resumeSessions();
  const withdrawn = await post(bySession);
  const [lock] = (await read(`${realm}.Locks("${address}")`)).filter((l) => l.Match === withdrawn?.ID);
  if (lock === undefined)
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
  const { address } = await byWallet.connect();
  await byWallet.authorize(); // the root signature, whose box key seals the challenge
  const posted = await post(byWallet);
  return [posted?.Challenger === address, `match ${posted?.ID} posted by ${posted?.Challenger}`];
});

$("forget").onclick = () => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith(`gnomehall:${chainId}:`));
  for (const key of keys) localStorage.removeItem(key);
  $("forgotten").textContent = `Forgot ${keys.length} stored values; the next check asks Adena again.`;
};
