// A tx-indexer client for following a realm. The node pushes nothing, and the indexer
// refuses websockets from a page on another origin, so the page polls the indexer's
// GraphQL API over HTTP: one small request per poll, and one more when blocks were
// added since the last.

const latestQuery = "{ latestBlockHeight }";
const callsQuery = `query Calls($where: FilterTransaction!) {
  getTransactions(where: $where, order: {heightAndIndex: ASC}) {
    block_height
    messages { value { ... on MsgCall { caller pkg_path func args } } }
  }
}`;

// createIndexer is a client of the indexer whose GraphQL endpoint is url, polled every
// interval ms while the page is visible.
export function createIndexer({ url, fetch = globalThis.fetch, interval = 3000 }) {
  async function ask(query, variables) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`indexer answered ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(body.errors[0].message);
    return body.data;
  }

  return {
    // watchCalls calls onCall({height, caller, func, args}) for each successful call to
    // realm in a block indexed after its first poll, and onState("up") or
    // onState("down") as the indexer starts or stops answering. A call indexed while the
    // indexer does not answer is read once it answers again. It returns a function that
    // stops it.
    watchCalls(realm, onCall, onState = () => {}) {
      const where = (from, to) => ({
        success: { eq: true },
        // The indexer's integer filters have gt and lt only: heights from+1 through to.
        block_height: { gt: from, lt: to + 1 },
        messages: { value: { MsgCall: { pkg_path: { eq: realm } } } },
      });
      let read = null; // the last height whose calls were read
      let state = null;
      let timer;
      let stopped = false;

      function report(next) {
        if (next !== state && !stopped) onState(next);
        state = next;
      }

      async function poll() {
        if (globalThis.document?.visibilityState !== "hidden") {
          try {
            const { latestBlockHeight: to } = await ask(latestQuery);
            if (read !== null && to > read) {
              const { getTransactions } = await ask(callsQuery, { where: where(read, to) });
              for (const tx of getTransactions ?? []) {
                for (const { value } of tx.messages ?? []) {
                  if (value?.pkg_path === realm && !stopped)
                    onCall({ height: tx.block_height, caller: value.caller, func: value.func, args: value.args ?? [] });
                }
              }
            }
            read = Math.max(read ?? to, to);
            report("up");
          } catch {
            report("down");
          }
        }
        if (!stopped) timer = setTimeout(poll, interval);
      }

      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
