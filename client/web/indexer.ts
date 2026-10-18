// A tx-indexer client for following a realm. The node pushes nothing, and the indexer
// refuses websockets from a page on another origin, so the page polls the indexer's
// GraphQL API over HTTP: one small request per poll, and one more when blocks were
// added since the last.

import * as v from "valibot";

import type { Fetch } from "./chain.ts";
import { type Address, address } from "./ids.ts";

const latestQuery = "{ latestBlockHeight }";
const callsQuery = `query Calls($where: FilterTransaction!) {
  getTransactions(where: $where, order: {heightAndIndex: ASC}) {
    block_height
    messages { value { ... on MsgCall { caller pkg_path func args } } }
  }
}`;

const BodySchema = v.object({
  data: v.optional(v.unknown()),
  errors: v.nullish(v.array(v.object({ message: v.string() }))),
});

const LatestSchema = v.object({ latestBlockHeight: v.number() });

const CallsSchema = v.object({
  getTransactions: v.nullish(
    v.array(
      v.object({
        block_height: v.number(),
        messages: v.nullish(v.array(v.object({ value: v.optional(v.unknown()) }))),
      }),
    ),
  ),
});

// A message value the calls query returns is a MsgCall, or empty for a message of
// another type.
const CallSchema = v.object({
  caller: v.pipe(v.string(), v.transform(address)),
  pkg_path: v.string(),
  func: v.string(),
  args: v.nullish(v.array(v.string())),
});

export type IndexedCall = { height: number; caller: Address; func: string; args: string[] };

export type Indexer = {
  // watchCalls calls onCall for each successful call to realm in a block indexed after
  // its first poll, and onState("up") or onState("down") as the indexer starts or stops
  // answering. A call indexed while the indexer does not answer is read once it answers
  // again. It returns a function that stops it.
  watchCalls(realm: string, onCall: (call: IndexedCall) => void, onState?: (state: "up" | "down") => void): () => void;
};

// createIndexer is a client of the indexer whose GraphQL endpoint is url, polled every
// interval ms while the page is visible.
export function createIndexer({
  url,
  fetch = globalThis.fetch,
  interval = 3000,
}: {
  url: string;
  fetch?: Fetch;
  interval?: number;
}): Indexer {
  async function ask<T>(schema: v.GenericSchema<unknown, T>, query: string, variables?: object): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`indexer answered ${res.status}`);
    const body = v.parse(BodySchema, await res.json());
    const [error] = body.errors ?? [];
    if (error !== undefined) throw new Error(error.message);
    return v.parse(schema, body.data);
  }

  return {
    watchCalls(realm, onCall, onState = () => {}) {
      const where = (from: number, to: number) => ({
        success: { eq: true },
        // The indexer's integer filters have gt and lt only: heights from+1 through to.
        block_height: { gt: from, lt: to + 1 },
        messages: { value: { MsgCall: { pkg_path: { eq: realm } } } },
      });
      let read: number | null = null; // the last height whose calls were read
      let state: "up" | "down" | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;

      function report(next: "up" | "down"): void {
        if (next !== state && !stopped) onState(next);
        state = next;
      }

      async function poll(): Promise<void> {
        if (globalThis.document?.visibilityState !== "hidden") {
          try {
            const { latestBlockHeight: to } = await ask(LatestSchema, latestQuery);
            if (read !== null && to > read) {
              const { getTransactions } = await ask(CallsSchema, callsQuery, { where: where(read, to) });
              for (const tx of getTransactions ?? []) {
                for (const { value } of tx.messages ?? []) {
                  const call = v.safeParse(CallSchema, value);
                  if (call.success && call.output.pkg_path === realm && !stopped) {
                    const { caller, func, args } = call.output;
                    onCall({ height: tx.block_height, caller, func, args: args ?? [] });
                  }
                }
              }
            }
            read = Math.max(read ?? to, to);
            report("up");
          } catch {
            report("down");
          }
        }
        if (!stopped) timer = setTimeout(() => void poll(), interval);
      }

      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
