// The spec's Adena checks, one button each, against a local gnodev: the root signature
// is stable, Adena creates a session the page then signs with, and Adena signs a move
// itself. ?dev=alice runs the page with the dev wallet instead, to test the page.

import { createArena } from "./arena.mjs";
import { randomDeck, randomPlan } from "./bot.mjs";
import { createChain } from "./chain.mjs";
import { devWallet } from "./devwallet.mjs";
import { loadEngine } from "./engine.mjs";
import * as signer from "./signer.mjs";
import { answer, rootText, waitForAdena } from "./wallet.mjs";

const params = new URLSearchParams(location.search);
const rpc = params.get("rpc") ?? "http://127.0.0.1:36657";
const chainId = params.get("chain") ?? "gnomehall-dev";
const realm = params.get("realm") ?? "gno.land/r/gfanton/gnomehall/arena";
const devName = params.get("dev");

const $ = (id) => document.getElementById(id);
const engine = await loadEngine("engine.wasm", "cards.json");
const chain = createChain({ rpc });
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
  $("connection").textContent = `AddNetwork: ${added?.status ?? "not offered"} ${added?.type ?? ""} ${added?.message ?? ""}`;
};

check("connect", "connection", async () => {
  const account = await bySession.connect();
  const version = wallet?.version === undefined ? "" : `, Adena ${wallet.version}`;
  return [account.address !== undefined, `${account.state} ${account.address ?? account.reason ?? ""}${version}`];
});

check("check-signature", "signature", async () => {
  const { address } = await bySession.connect();
  const sign = async () => answer(await wallet.SignArbitrary({ signer: address, data: rootText(location.origin) })).signature.signature;
  const [first, second] = [await sign(), await sign()];
  return [first === second, first === second ? `both signatures are ${first}` : `first ${first}\nsecond ${second}`];
});

check("check-session", "session", async () => {
  const { address } = await bySession.connect();
  const account = await bySession.authorize();
  if (account.mode !== "session" || account.state !== "active") {
    return [false, `no session: state ${account.state}, mode ${account.mode}, reason: ${account.fallback ?? "none"}`];
  }
  const posted = await post(bySession);
  const until = new Date(account.expiresAt * 1000).toLocaleString();
  return [posted?.Challenger === address, `session active until ${until}; match ${posted?.ID} posted by ${posted?.Challenger}`];
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
