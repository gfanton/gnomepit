// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?indexer= name the network, defaulting to the build's network; an empty
// ?indexer= polls the node instead. ?dev=alice or ?dev=bob plays with a dev wallet on a
// local chain instead of Adena.

import { type Arena, createArena } from "./arena.ts";
import { type Chain, createChain } from "./chain.ts";
import { devAccounts, devWallet } from "./devwallet.ts";
import type { Engine } from "./engine.ts";
import { createIndexer } from "./indexer.ts";
import { type Network, networkFrom } from "./network.ts";
import * as signer from "./signer.ts";
import type { Signer } from "./signer.ts";
import { type Wallet, waitForAdena } from "./wallet.ts";

export async function loadArena(engine: Engine, built: Network): Promise<Arena> {
  const params = new URLSearchParams(location.search);
  const { chainId, rpc, realm, indexer } = networkFrom(params, built);
  const chain = createChain({ rpc });
  return createArena({
    chain,
    wallet: await pageWallet(params.get("dev"), { signer, chain, chainId }),
    engine,
    signer,
    realm,
    chainId,
    origin: location.origin,
    storage: localStorage,
    indexer: indexer === null ? undefined : createIndexer({ url: indexer }),
    network: walletNetwork(params, built),
  });
}

const isDevName = (name: string): name is keyof typeof devAccounts => Object.hasOwn(devAccounts, name);

// pageWallet is the wallet a page plays with: Adena, or, for a ?dev= value, that dev
// account's wallet on chain. A value that names no dev account fails.
export async function pageWallet(
  dev: string | null,
  { signer, chain, chainId }: { signer: Signer; chain: Chain; chainId: string },
): Promise<Wallet | undefined> {
  if (dev === null) return waitForAdena();
  if (!isDevName(dev)) throw new Error(`unknown dev account "${dev}"; known: ${Object.keys(devAccounts).join(", ")}`);
  return devWallet({ name: dev, signer, chain, chainId });
}

// walletNetwork is the network the page may ask Adena to add: the build's own, and none
// when params name another, so an RPC address from a link never enters the wallet.
export function walletNetwork(
  params: URLSearchParams,
  built: Network,
): { chainName: string; rpcUrl: string } | undefined {
  if (params.has("chain") || params.has("rpc")) return undefined;
  return { chainName: built.chainId, rpcUrl: built.rpc };
}
