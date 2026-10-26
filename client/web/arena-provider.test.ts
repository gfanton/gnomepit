import test from "node:test";
import assert from "node:assert/strict";

import * as v from "valibot";

import { offersPush, pageWallet, walletNetwork } from "./arena-provider.ts";
import { createChain } from "./chain.ts";
import { devAccounts } from "./devwallet.ts";
import { known } from "./fixture.ts";
import { networks } from "./network.ts";
import * as signer from "./signer.ts";
import { answer } from "./wallet.ts";

test("Adena is offered the page's own network, never one a link names", () => {
  assert.deepEqual(walletNetwork(new URLSearchParams(""), networks.local), {
    chainName: "gnomepit-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.deepEqual(walletNetwork(new URLSearchParams("?realm=gno.land/r/demo/other"), networks.local), {
    chainName: "gnomepit-dev",
    rpcUrl: "http://127.0.0.1:36657",
  });
  assert.equal(walletNetwork(new URLSearchParams("?rpc=https://rpc.example"), networks.local), undefined);
  assert.equal(walletNetwork(new URLSearchParams("?chain=other-1"), networks.local), undefined);
});

// A gnotif server holds the push subscription it registers, and a realm's triggers write
// the pushed text, so a link may name neither for push.
test("push is offered for the page's own realm and gnotif server, never one a link names", () => {
  assert.equal(offersPush(new URLSearchParams("")), true);
  assert.equal(offersPush(new URLSearchParams("?rpc=https://rpc.example&chain=other-1")), true);
  assert.equal(offersPush(new URLSearchParams("?gnotif=https://gnotif.example")), false);
  assert.equal(offersPush(new URLSearchParams("?realm=gno.land/r/demo/other")), false);
});

test("a ?dev= link plays with that dev account's wallet, and another name fails naming the dev accounts", async () => {
  const chain = createChain({ rpc: "http://node", fetch: () => Promise.reject(new Error("no node in this test")) });
  const options = { signer, chain, chainId: "gnomepit-dev", built: networks.local };
  const wallet = known(await pageWallet("bob", options));
  assert.equal(answer(await wallet.GetAccount(), v.object({ address: v.string() })).address, devAccounts.bob.address);
  await assert.rejects(pageWallet("erin", options), /unknown dev account "erin"; known: alice, bob, carol, dave/);
});

// The dev accounts' keys ship in the page, so on a public chain anyone could play as them.
test("a ?dev= link on a build for any chain but make dev's plays with Adena, whatever chain the link names", async (t) => {
  const adena = { AddEstablish: () => Promise.reject(new Error("not called in this test")) };
  Object.defineProperty(globalThis, "window", { value: { adena }, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  const chain = createChain({ rpc: "http://node", fetch: () => Promise.reject(new Error("no node in this test")) });
  for (const chainId of ["onyx-1", "gnomepit-dev"])
    assert.equal(await pageWallet("alice", { signer, chain, chainId, built: networks.onyx }), adena, chainId);
});
