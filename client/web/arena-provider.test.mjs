import test from "node:test";
import assert from "node:assert/strict";

import { lobbyAccount } from "./arena-provider.mjs";

test("the lobby reads a session's end as expires, and an expired session as sessionExpired", () => {
  const active = { state: "active", address: "g1alice", mode: "session", expiresAt: 1_900_000_000, fallback: null };
  assert.deepEqual(lobbyAccount(active), { ...active, expires: 1_900_000_000 });
  assert.equal(lobbyAccount({ ...active, state: "expired" }).state, "sessionExpired");
  assert.equal(lobbyAccount({ ...active, mode: "contract", expiresAt: 0 }).expires, undefined);
  assert.deepEqual(lobbyAccount({ state: "noWallet", reason: "No Adena wallet in this browser" }), { state: "noWallet", reason: "No Adena wallet in this browser", expires: undefined });
});
