// The arena the lobby plays through, built from the page's query string. ?rpc=, ?chain=,
// ?realm= and ?indexer= name the network, defaulting to make dev's local chain; an empty
// ?indexer= polls the node instead. ?dev=alice or ?dev=bob plays with a dev wallet on a
// local chain instead of Adena.

import { createArena } from "./arena.mjs";
import { createChain } from "./chain.mjs";
import { devWallet } from "./devwallet.mjs";
import { createIndexer } from "./indexer.mjs";
import { waitForAdena } from "./wallet.mjs";

// lobbyAccount is the arena's account state in the lobby's terms: the session's end as
// expires, and an expired session as sessionExpired.
export function lobbyAccount(account) {
  return { ...account, state: account.state === "expired" ? "sessionExpired" : account.state, expires: account.expiresAt || undefined };
}

export async function loadArena(engine) {
  const params = new URLSearchParams(location.search);
  const chainId = params.get("chain") ?? "gnomehall-dev";
  const indexerURL = params.get("indexer") ?? "http://127.0.0.1:8546/graphql/query";
  const devName = params.get("dev");
  const chain = createChain({ rpc: params.get("rpc") ?? "http://127.0.0.1:36657" });
  const arena = createArena({
    chain,
    wallet: devName === null ? await waitForAdena() : devWallet({ name: devName, signer: engine, chain, chainId }),
    engine,
    realm: params.get("realm") ?? "gno.land/r/gfanton/gnomehall/arena",
    chainId,
    origin: location.origin,
    storage: localStorage,
    indexer: indexerURL === "" ? undefined : createIndexer({ url: indexerURL }),
  });
  return {
    ...arena,
    connect: async () => lobbyAccount(await arena.connect()),
    authorize: async () => lobbyAccount(await arena.authorize()),
  };
}
