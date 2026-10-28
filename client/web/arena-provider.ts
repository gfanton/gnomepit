// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?gnotif= name the network, defaulting to the build's network; an empty
// ?gnotif= polls the node instead. On a page built for make dev's chain, ?dev=alice or
// ?dev=bob plays with a dev wallet instead of Adena.

import { type Arena, type ArenaOptions, type Notifier, createArena } from "./arena.ts";
import { type Chain, createChain } from "./chain.ts";
import { devAccounts, devWallet } from "./devwallet.ts";
import type { Engine } from "./engine.ts";
import { Gnotif } from "./gnotif.js";
import { type Network, networkFrom, networks } from "./network.ts";
import * as signer from "./signer.ts";
import type { Signer } from "./signer.ts";
import { type Wallet, waitForAdena } from "./wallet.ts";

export function loadArena(engine: Engine, built: Network): Arena {
  const params = new URLSearchParams(location.search);
  const { chainId, rpc, realm, gnotif } = networkFrom(params, built);
  const chain = createChain({ rpc });
  return createArena({
    chain,
    wallet: pageWallet(params.get("dev"), { signer, chain, chainId, built }),
    engine,
    signer,
    realm,
    chainId,
    origin: location.origin,
    storage: localStorage,
    notifier: pageNotifier(gnotif),
    offerPush: offersPush(params),
    network: walletNetwork(params, built),
  });
}

// offersPush says whether the page may turn push on: only for the build's own realm and
// gnotif server, since the server holds the subscription it registers and the realm's
// triggers write what it pushes.
export function offersPush(params: URLSearchParams): boolean {
  return !params.has("realm") && !params.has("gnotif");
}

// pageNotifier is the gnotif client of the server at url, with the copy of sw.js served next
// to the page, or none without a server.
export function pageNotifier(url: string | null): Notifier | undefined {
  if (url === null) return undefined;
  return new Gnotif({ server: url, serviceWorker: new URL("sw.js", location.href).pathname });
}

const isDevName = (name: string): name is keyof typeof devAccounts => Object.hasOwn(devAccounts, name);

// pageWallet is the wallet a page plays with: Adena, or, for a ?dev= value on a page built
// for make dev's chain, that dev account's wallet on chain. A page built for another chain
// ignores ?dev=, since the dev keys ship in the page. A value that names no dev account fails.
export async function pageWallet(
  dev: string | null,
  { signer, chain, chainId, built }: { signer: Signer; chain: Chain; chainId: string; built: Network },
): Promise<Wallet | undefined> {
  if (dev === null || built.chainId !== networks.local.chainId) return waitForAdena();
  if (!isDevName(dev)) throw new Error(`unknown dev account "${dev}"; known: ${Object.keys(devAccounts).join(", ")}`);
  return devWallet({ name: dev, signer, chain, chainId });
}

// walletNetwork is the network the page may ask Adena to add: the build's own, and none
// when params name another, so an RPC address from a link never enters the wallet.
export function walletNetwork(params: URLSearchParams, built: Network): ArenaOptions["network"] {
  if (params.has("chain") || params.has("rpc")) return undefined;
  return { chainName: built.chainId, rpcUrl: built.rpc };
}
