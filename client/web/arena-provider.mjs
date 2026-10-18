// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?indexer= name the network, defaulting to make dev's local chain; an empty
// ?indexer= polls the node instead. ?dev=alice or ?dev=bob plays with a dev wallet on a
// local chain instead of Adena.

import { createArena } from "./arena.mjs";
import { createChain } from "./chain.ts";
import { devWallet } from "./devwallet.mjs";
import { createIndexer } from "./indexer.ts";
import { networkFrom } from "./network.ts";
import * as signer from "./signer.ts";
import { waitForAdena } from "./wallet.mjs";

export async function loadArena(engine, built) {
  const params = new URLSearchParams(location.search);
  const { chainId, rpc, realm, indexer } = networkFrom(params, built);
  const devName = params.get("dev");
  const chain = createChain({ rpc });
  return createArena({
    chain,
    wallet: devName === null ? await waitForAdena() : devWallet({ name: devName, signer, chain, chainId }),
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
export function walletNetwork(params, built) {
  if (params.has("chain") || params.has("rpc")) return undefined;
  return { chainName: built.chainId, rpcUrl: built.rpc };
}
