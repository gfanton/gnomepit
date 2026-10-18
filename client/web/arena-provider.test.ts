import test from "node:test";
import assert from "node:assert/strict";

import { walletNetwork } from "./arena-provider.ts";
import { networks } from "./network.ts";

test("Adena is offered the page's own network, never one a link names", () => {
  assert.deepEqual(walletNetwork(new URLSearchParams(""), networks.local), {
    chainName: "gnomehall-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.deepEqual(walletNetwork(new URLSearchParams("?realm=gno.land/r/demo/other"), networks.local), {
    chainName: "gnomehall-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.equal(walletNetwork(new URLSearchParams("?rpc=https://rpc.example"), networks.local), undefined);
  assert.equal(walletNetwork(new URLSearchParams("?chain=other-1"), networks.local), undefined);
});
