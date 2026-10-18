import test from "node:test";
import assert from "node:assert/strict";

import * as v from "valibot";

import { pageWallet, walletNetwork } from "./arena-provider.ts";
import { createChain } from "./chain.ts";
import { devAccounts } from "./devwallet.ts";
import { known } from "./fixture.ts";
import { networks } from "./network.ts";
import * as signer from "./signer.ts";
import { answer } from "./wallet.ts";

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

test("a ?dev= link plays with that dev account's wallet, and another name fails naming the dev accounts", async () => {
  const chain = createChain({ rpc: "http://node", fetch: () => Promise.reject(new Error("no node in this test")) });
  const options = { signer, chain, chainId: "gnomehall-dev" };
  const wallet = known(await pageWallet("bob", options));
  assert.equal(answer(await wallet.GetAccount(), v.object({ address: v.string() })).address, devAccounts.bob.address);
  await assert.rejects(pageWallet("carol", options), /unknown dev account "carol"; known: alice, bob/);
});
