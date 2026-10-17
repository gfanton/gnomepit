// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?indexer= name the network, defaulting to make dev's local chain; an empty
// ?indexer= polls the node instead. ?dev=alice or ?dev=bob plays with a dev wallet on a
// local chain instead of Adena.

import { createArena } from "./arena.mjs";
import { createChain } from "./chain.mjs";
import { devWallet } from "./devwallet.mjs";
import { createIndexer } from "./indexer.mjs";
import * as signer from "./signer.mjs";
import { waitForAdena } from "./wallet.mjs";

const defaultChainId = "gnomehall-dev";
const defaultRPC = "http://127.0.0.1:36657";

export async function loadArena(engine) {
  const params = new URLSearchParams(location.search);
  const chainId = params.get("chain") ?? defaultChainId;
  const indexerURL = params.get("indexer") ?? "http://127.0.0.1:8546/graphql/query";
  const devName = params.get("dev");
  const rpc = params.get("rpc") ?? defaultRPC;
  const chain = createChain({ rpc });
  return createArena({
    chain,
    wallet: devName === null ? await waitForAdena() : devWallet({ name: devName, signer, chain, chainId }),
    engine,
    signer,
    realm: params.get("realm") ?? "gno.land/r/gfanton/gnomehall/arena",
    chainId,
    origin: location.origin,
    storage: localStorage,
    indexer: indexerURL === "" ? undefined : createIndexer({ url: indexerURL }),
    network: walletNetwork(params),
  });
}

// walletNetwork is the network the page may ask Adena to add: the default one, and none
// when params name another, so an RPC address from a link never enters the wallet.
export function walletNetwork(params) {
  if (params.has("chain") || params.has("rpc")) return undefined;
  return { chainName: defaultChainId, rpcUrl: defaultRPC };
}
