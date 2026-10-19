import test from "node:test";
import assert from "node:assert/strict";

import { networkFor, networkFrom, networks } from "./network.ts";

test("networkFor gives the local and offline builds' networks and refuses any other name", () => {
  assert.deepEqual(networkFor("local"), {
    chainId: "gnomepit-dev",
    rpc: "http://127.0.0.1:36657",
    realm: "gno.land/r/gfanton/gnomepit/arena",
    indexer: "http://127.0.0.1:8546/graphql/query",
  });
  assert.equal(networkFor("offline"), null);
  assert.throws(() => networkFor("onyx"), /unknown network "onyx"; known: local, offline/);
});

test("a link's parameters override the build's network, and an empty indexer polls the node", () => {
  assert.deepEqual(networkFrom(new URLSearchParams(""), networks.local), networks.local);
  assert.deepEqual(
    networkFrom(new URLSearchParams("?rpc=http://n&chain=c-1&realm=gno.land/r/x&indexer="), networks.local),
    { chainId: "c-1", rpc: "http://n", realm: "gno.land/r/x", indexer: null },
  );
});
