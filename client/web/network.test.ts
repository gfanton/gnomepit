import test from "node:test";
import assert from "node:assert/strict";

import { networkFor, networkFrom, networks, realmPage } from "./network.ts";

test("networkFor gives the local, onyx and offline builds' networks and refuses any other name", () => {
  assert.deepEqual(networkFor("local"), {
    chainId: "gnomepit-dev",
    rpc: "http://127.0.0.1:36657",
    realm: "gno.land/r/gfanton/gnomepit/arena/v0",
    standings: "gno.land/r/gfanton/gnomepit/standings/v0",
    gnotif: "http://127.0.0.1:8547",
    gnoweb: "http://127.0.0.1:8890",
  });
  assert.deepEqual(networkFor("onyx"), {
    chainId: "onyx-1",
    rpc: "https://rpc.onyx.testnets.gno.land",
    realm: "gno.land/r/nym-gfanton001/gnomepit/arena/v0",
    standings: "gno.land/r/nym-gfanton001/gnomepit/standings/v0",
    gnotif: "https://gnotif.xyz/onyx",
    gnoweb: "https://onyx.testnets.gno.land",
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
    { chainId: "c-1", rpc: "http://n", realm: "gno.land/r/x", standings: "gno.land/r/s", gnotif: null, gnoweb: null },
  );
});

test("a link that names another chain or node has no known gnoweb; one that names another realm keeps it", () => {
  assert.equal(networkFrom(new URLSearchParams("?chain=c-1"), networks.onyx).gnoweb, null);
  assert.equal(networkFrom(new URLSearchParams("?rpc=http://n"), networks.onyx).gnoweb, null);
  assert.equal(
    networkFrom(new URLSearchParams("?realm=gno.land/r/x/arena/v1"), networks.onyx).gnoweb,
    "https://onyx.testnets.gno.land",
  );
});

test("realmPage is a realm's page on gnoweb, and nothing for a path that is no realm's", () => {
  assert.equal(
    realmPage("https://onyx.testnets.gno.land", "gno.land/r/nym-gfanton001/gnomepit/arena/v0"),
    "https://onyx.testnets.gno.land/r/nym-gfanton001/gnomepit/arena/v0",
  );
  assert.equal(realmPage(null, "gno.land/r/x"), null);
  assert.equal(realmPage("https://onyx.testnets.gno.land", 'gno.land/r/x"><script>'), null);
  assert.equal(realmPage("https://onyx.testnets.gno.land", "gno.land/p/x/engine/v0"), null);
});
