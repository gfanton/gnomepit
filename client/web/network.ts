// The networks the page can be built for, and the query-string parameters that override
// one for a single visit.

export type Network = {
  readonly chainId: string;
  readonly rpc: string;
  readonly realm: string;
  // The realm that answers the leaderboard's standings queries.
  readonly standings: string;
  // The gnotif server the page follows the chain and turns on push through; null polls the
  // node instead.
  readonly gnotif: string | null;
};

// null is the offline build: no chain at all.
export const networks = {
  local: {
    chainId: "gnomepit-dev",
    rpc: "http://127.0.0.1:36657",
    realm: "gno.land/r/gfanton/gnomepit/arena/v0",
    standings: "gno.land/r/gfanton/gnomepit/standings/v0",
    gnotif: "http://127.0.0.1:8547",
  },
  // The realms deployed from scripts/onyx-copy.sh under the name nym-gfanton001.
  onyx: {
    chainId: "onyx-1",
    rpc: "https://rpc.onyx.testnets.gno.land",
    realm: "gno.land/r/nym-gfanton001/gnomepit/arena/v0",
    standings: "gno.land/r/nym-gfanton001/gnomepit/standings/v0",
    gnotif: "https://gnotif.xyz/onyx",
  },
  offline: null,
} as const satisfies Record<string, Network | null>;

const isNetworkName = (name: string): name is keyof typeof networks => Object.hasOwn(networks, name);

export function networkFor(name: string): Network | null {
  if (!isNetworkName(name)) throw new Error(`unknown network "${name}"; known: ${Object.keys(networks).join(", ")}`);
  return networks[name];
}

// networkFrom is base with the link's ?chain=, ?rpc=, ?realm=, ?standings= and ?gnotif=
// applied; an empty ?gnotif= clears the gnotif server.
export function networkFrom(params: URLSearchParams, base: Network): Network {
  const gnotif = params.get("gnotif");
  return {
    chainId: params.get("chain") ?? base.chainId,
    rpc: params.get("rpc") ?? base.rpc,
    realm: params.get("realm") ?? base.realm,
    standings: params.get("standings") ?? base.standings,
    gnotif: gnotif === null ? base.gnotif : gnotif === "" ? null : gnotif,
  };
}
