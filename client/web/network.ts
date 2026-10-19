// The networks the page can be built for, and the query-string parameters that override
// one for a single visit.

export type Network = {
  readonly chainId: string;
  readonly rpc: string;
  readonly realm: string;
  // null polls the node instead of subscribing through an indexer.
  readonly indexer: string | null;
};

// null is the offline build: no chain at all.
export const networks = {
  local: {
    chainId: "gnomepit-dev",
    rpc: "http://127.0.0.1:36657",
    realm: "gno.land/r/gfanton/gnomepit/arena",
    indexer: "http://127.0.0.1:8546/graphql/query",
  },
  offline: null,
} as const satisfies Record<string, Network | null>;

const isNetworkName = (name: string): name is keyof typeof networks => Object.hasOwn(networks, name);

export function networkFor(name: string): Network | null {
  if (!isNetworkName(name)) throw new Error(`unknown network "${name}"; known: ${Object.keys(networks).join(", ")}`);
  return networks[name];
}

// networkFrom is base with the link's ?chain=, ?rpc=, ?realm= and ?indexer= applied; an
// empty ?indexer= clears the indexer.
export function networkFrom(params: URLSearchParams, base: Network): Network {
  const indexer = params.get("indexer");
  return {
    chainId: params.get("chain") ?? base.chainId,
    rpc: params.get("rpc") ?? base.rpc,
    realm: params.get("realm") ?? base.realm,
    indexer: indexer === null ? base.indexer : indexer === "" ? null : indexer,
  };
}
