// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?indexer= name the network, defaulting to the build's network; an empty
// ?indexer= polls the node instead. ?dev=alice or ?dev=bob plays with a dev wallet on a
// local chain instead of Adena.

import * as v from "valibot";

import { type Arena, createArena } from "./arena.ts";
import { createChain } from "./chain.ts";
import { devWallet } from "./devwallet.ts";
import type { Engine } from "./engine.ts";
import { createIndexer } from "./indexer.ts";
import { type Network, networkFrom } from "./network.ts";
import * as signer from "./signer.ts";
import { waitForAdena } from "./wallet.ts";

const DevNameSchema = v.picklist(["alice", "bob"]);

export async function loadArena(engine: Engine, built: Network): Promise<Arena> {
  const params = new URLSearchParams(location.search);
  const { chainId, rpc, realm, indexer } = networkFrom(params, built);
  const devName = params.get("dev");
  const chain = createChain({ rpc });
  return createArena({
    chain,
    wallet:
      devName === null
        ? await waitForAdena()
        : devWallet({ name: v.parse(DevNameSchema, devName), signer, chain, chainId }),
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

// walletNetwork is the network the page may ask Adena to add: the build's own, and none
// when params name another, so an RPC address from a link never enters the wallet.
export function walletNetwork(
  params: URLSearchParams,
  built: Network,
): { chainName: string; rpcUrl: string } | undefined {
  if (params.has("chain") || params.has("rpc")) return undefined;
  return { chainName: built.chainId, rpcUrl: built.rpc };
}
