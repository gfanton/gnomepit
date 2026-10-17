import test from "node:test";
import assert from "node:assert/strict";

import { walletNetwork } from "./arena-provider.mjs";

test("Adena is offered the page's own network, never one a link names", () => {
  assert.deepEqual(walletNetwork(new URLSearchParams("")), {
    chainName: "gnomehall-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.deepEqual(walletNetwork(new URLSearchParams("?realm=gno.land/r/demo/other")), {
    chainName: "gnomehall-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.equal(walletNetwork(new URLSearchParams("?rpc=https://rpc.example")), undefined);
  assert.equal(walletNetwork(new URLSearchParams("?chain=other-1")), undefined);
});
