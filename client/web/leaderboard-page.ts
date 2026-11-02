// The leaderboard page. ?preview=1 shows illustrative standings, with ?state=empty,
// loading or error. Otherwise it reads the build's network, overridden by ?rpc=, ?chain=,
// ?realm= and ?standings=, shows the board, then adds the viewer's own standing once the
// wallet names an account; ?dev=alice or ?dev=bob names a dev account instead of Adena's.

import { pageWallet } from "./arena-provider.ts";
import { createChain } from "./chain.ts";
import { elementById } from "./dom.ts";
import { type LeaderboardView, leaderboardHTML } from "./leaderboard.ts";
import { networkFor, networkFrom } from "./network.ts";
import * as signer from "./signer.ts";
import { boardView, clanNamesOf, createStandings, withOwnStanding } from "./standings.ts";
import { currentAccount } from "./wallet.ts";

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
  const account = await currentAccount(await pageWallet(params.get("dev"), { signer, chain, chainId, built }));
  render(await withOwnStanding(board, standings, account));
}
