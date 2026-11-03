// The leaderboard page. ?preview=1 shows illustrative standings, with ?state=empty,
// loading or error. Otherwise it reads the build's network, overridden by ?rpc=, ?chain= and
// ?standings=, shows the board, then adds the viewer's own standing once the wallet names an
// account, or offers to connect a wallet that names none; ?dev=alice or ?dev=bob names a dev
// account instead of Adena's.

import { pageWallet, walletNetwork } from "./arena-provider.ts";
import { createChain } from "./chain.ts";
import { elementById } from "./dom.ts";
import { type LeaderboardView, leaderboardHTML } from "./leaderboard.ts";
import { networkFor, networkFrom } from "./network.ts";
import * as signer from "./signer.ts";
import { boardView, clanNamesOf, createStandings, offerConnect, withOwnStanding } from "./standings.ts";
import { WalletError, connect, currentAccount } from "./wallet.ts";

declare const GNOMEPIT_NETWORK: string;

const root = elementById("leaderboard", HTMLElement);
const render = (view: LeaderboardView): void => {
  root.innerHTML = leaderboardHTML(view);
};
const params = new URLSearchParams(location.search);

async function clanNames(): Promise<string[]> {
  const res = await fetch("cards.json");
  if (!res.ok) throw new Error(`cards.json answered ${res.status}`);
  return clanNamesOf(await res.json());
}

if (params.get("preview") === "1") {
  const { previewView } = await import("./leaderboard-preview.ts");
  render(previewView(params.get("state")));
} else {
  const built = networkFor(GNOMEPIT_NETWORK);
  if (built === null) throw new Error("This build has no network");
  const { chainId, rpc, standings: standingsRealm } = networkFrom(params, built);
  const chain = createChain({ rpc });
  const standings = createStandings({ chain, realm: standingsRealm });
  render({ status: "loading", preview: false });
  const board = await clanNames().then(
    (names) => boardView(standings, names),
    (): LeaderboardView => ({ status: "error", preview: false }),
  );
  render(board);
  const wallet = await pageWallet(params.get("dev"), { signer, chain, chainId, built });
  const account = await currentAccount(wallet);
  render(
    account === null && wallet !== undefined
      ? offerConnect(board, "")
      : await withOwnStanding(board, standings, account),
  );
  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-action="connect"]') : null;
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    void connect(wallet, chainId, walletNetwork(params, built)).then(
      async ({ address }) => render(await withOwnStanding(board, standings, address)),
      (err: unknown) =>
        render(offerConnect(board, err instanceof WalletError ? err.reason : "The wallet did not connect.")),
    );
  });
}
