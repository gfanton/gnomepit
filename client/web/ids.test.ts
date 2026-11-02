import test from "node:test";
import assert from "node:assert/strict";
import { isAccountAddress } from "./ids.ts";

// An account the local chain's gnotif registry declares its triggers with.
const real = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";

test("an account address is g1 and 38 lowercase bech32 characters with a matching checksum", () => {
  assert.equal(isAccountAddress(real), true);
});

test("a typo, a wrong length, capitals or another prefix is no account address", () => {
  assert.equal(isAccountAddress(real.slice(0, -1) + "6"), false, "one character changed");
  assert.equal(isAccountAddress(real.slice(0, -1)), false, "one character short");
  assert.equal(isAccountAddress(real.toUpperCase()), false, "capitals");
  assert.equal(isAccountAddress("cosmos1" + real.slice(2)), false, "another prefix");
  assert.equal(isAccountAddress("g1nope"), false);
  assert.equal(isAccountAddress(""), false);
});
