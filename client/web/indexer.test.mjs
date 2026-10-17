import test from "node:test";
import assert from "node:assert/strict";

import { createIndexer } from "./indexer.mjs";

const realm = "gno.land/r/gfanton/gnomehall/arena";
const alice = "g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w";
const url = "http://127.0.0.1:8546/graphql/query";

// fakeIndexer answers the page's GraphQL requests: answer(request) returns the response
// body, or throws for an unreachable indexer. requests keeps each parsed request.
function fakeIndexer(answer) {
  const requests = [];
  const fetch = async (to, init) => {
    assert.equal(to, url);
    assert.equal(init.method, "POST");
    const request = JSON.parse(init.body);
    requests.push(request);
    const body = answer(request);
    return { ok: true, json: async () => body };
  };
  return { fetch, requests };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latest = (height) => ({ data: { latestBlockHeight: height } });
const calls = (...txs) => ({
  data: { getTransactions: txs.map(([height, value]) => ({ block_height: height, messages: [{ value }] })) },
});
const isWindow = (request) => request.variables?.where !== undefined;

test("the first poll starts at the indexer's latest height, so no earlier call is reported", async () => {
  const indexer = fakeIndexer((r) =>
    isWindow(r) ? calls([3, { caller: alice, pkg_path: realm, func: "Play", args: ["1"] }]) : latest(10),
  );
  const reported = [];
  const states = [];
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(
    realm,
    (c) => reported.push(c),
    (s) => states.push(s),
  );
  await sleep(30);
  stop();
  assert.deepEqual(states, ["up"]);
  assert.deepEqual(reported, []);
  assert.equal(indexer.requests.some(isWindow), false);
});

test("when the latest height moves, the poll reads the realm's successful calls in the new blocks", async () => {
  const heights = [10, 12];
  const indexer = fakeIndexer((r) => {
    if (!isWindow(r)) return latest(heights.length > 1 ? heights.shift() : heights[0]);
    return calls(
      [11, { caller: alice, pkg_path: realm, func: "Accept", args: ["4", "Ironhide"] }],
      [12, { caller: alice, pkg_path: realm, func: "Play", args: ["4", "Pick,Pick,Pick"] }],
    );
  });
  const reported = [];
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(realm, (c) => reported.push(c));
  await sleep(40);
  stop();

  const windows = indexer.requests.filter(isWindow);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].variables.where, {
    success: { eq: true },
    block_height: { gt: 10, lt: 13 },
    messages: { value: { MsgCall: { pkg_path: { eq: realm } } } },
  });
  assert.deepEqual(reported, [
    { height: 11, caller: alice, func: "Accept", args: ["4", "Ironhide"] },
    { height: 12, caller: alice, func: "Play", args: ["4", "Pick,Pick,Pick"] },
  ]);
});

// The indexer lets through some transactions that hold no call to the realm, such as a
// session creation, with an empty message value.
test("a message that is not a call to the realm is not reported", async () => {
  const heights = [10, 11];
  const indexer = fakeIndexer((r) => {
    if (!isWindow(r)) return latest(heights.length > 1 ? heights.shift() : heights[0]);
    return calls([11, {}], [11, { caller: alice, pkg_path: "gno.land/r/other", func: "Play", args: ["1"] }]);
  });
  const reported = [];
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(realm, (c) => reported.push(c));
  await sleep(30);
  stop();
  assert.deepEqual(reported, []);
});

test("an indexer that stops answering reports down once, then up, and the calls in between are still read", async () => {
  let polls = 0;
  const indexer = fakeIndexer((r) => {
    if (isWindow(r)) return calls([14, { caller: alice, pkg_path: realm, func: "Resign", args: ["2"] }]);
    polls++;
    if (polls === 2 || polls === 3) throw new TypeError("fetch failed");
    return latest(polls === 1 ? 10 : 15);
  });
  const reported = [];
  const states = [];
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(
    realm,
    (c) => reported.push(c),
    (s) => states.push(s),
  );
  await sleep(60);
  stop();
  assert.deepEqual(states, ["up", "down", "up"]);
  assert.deepEqual(indexer.requests.find(isWindow).variables.where.block_height, { gt: 10, lt: 16 });
  assert.deepEqual(reported, [{ height: 14, caller: alice, func: "Resign", args: ["2"] }]);
});

test("a GraphQL error counts as the indexer not answering", async () => {
  const indexer = fakeIndexer(() => ({ errors: [{ message: "too many transactions" }] }));
  const states = [];
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(
    realm,
    () => {},
    (s) => states.push(s),
  );
  await sleep(30);
  stop();
  assert.deepEqual(states, ["down"]);
});

test("stop ends the polling", async () => {
  const indexer = fakeIndexer(() => latest(10));
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(realm, () => {});
  await sleep(20);
  stop();
  const polled = indexer.requests.length;
  await sleep(30);
  assert.equal(indexer.requests.length, polled);
});

test("a hidden page does not poll", async (t) => {
  globalThis.document = { visibilityState: "hidden" };
  t.after(() => delete globalThis.document);
  const indexer = fakeIndexer(() => latest(10));
  const stop = createIndexer({ url, fetch: indexer.fetch, interval: 5 }).watchCalls(realm, () => {});
  await sleep(30);
  stop();
  assert.equal(indexer.requests.length, 0);
});
