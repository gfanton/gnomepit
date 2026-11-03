import test from "node:test";
import assert from "node:assert/strict";

import { networkFor, networkFrom, networks } from "./network.ts";

test("networkFor gives the local, onyx and offline builds' networks and refuses any other name", () => {
  assert.deepEqual(networkFor("local"), {
    chainId: "gnomepit-dev",
    rpc: "http://127.0.0.1:36657",
    realm: "gno.land/r/gfanton/gnomepit/arena/v0",
    standings: "gno.land/r/gfanton/gnomepit/standings/v0",
    gnotif: "http://127.0.0.1:8547",
  });
  assert.deepEqual(networkFor("onyx"), {
    chainId: "onyx-1",
    rpc: "https://rpc.onyx.testnets.gno.land",
    realm: "gno.land/r/g188vafzutzvlfw6wt7u3s62xtuvm0epmu8ufmfz/gnomepit/arena",
    standings: "gno.land/r/g188vafzutzvlfw6wt7u3s62xtuvm0epmu8ufmfz/gnomepit/arena",
    gnotif: "https://gnotif.xyz/onyx",
  });
  assert.equal(networkFor("offline"), null);
  assert.throws(() => networkFor("mainnet"), /unknown network "mainnet"; known: local, onyx, offline/);
});

test("a link's parameters override the build's network, and an empty gnotif turns live updates off", () => {
  assert.deepEqual(networkFrom(new URLSearchParams(""), networks.local), networks.local);
  assert.deepEqual(
    networkFrom(
      new URLSearchParams("?rpc=http://n&chain=c-1&realm=gno.land/r/x&standings=gno.land/r/s&gnotif="),
      networks.local,
    ),
    { chainId: "c-1", rpc: "http://n", realm: "gno.land/r/x", standings: "gno.land/r/s", gnotif: null },
  );
});
