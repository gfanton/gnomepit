import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decode, structTypes, typeFields } from "./gnovalue.mjs";

const load = (name) => JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url)));
const result = (name) => load(name).results[0];
const fields = new Map([...typeFields(load("qtype-OpenChallenge")), ...typeFields(load("qtype-MatchView"))]);

const arena = "gno.land/r/gfanton/gnomehall/arena";
const player = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const int = (n) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(n), true);
  return { T: { "@type": "/gno.PrimitiveType", value: "32" }, N: btoa(String.fromCharCode(...bytes)) };
};

test("a type answer names the fields of every struct type it holds", () => {
  const types = typeFields(load("qtype-MatchView"));
  assert.equal(types.get(`${arena}.MatchView`)[0], "MatchSummary");
  assert.deepEqual(types.get(`${arena}.MatchSummary`).slice(0, 3), ["ID", "Phase", "Round"]);
});

test("a result lists the struct types its decoding needs", () => {
  assert.deepEqual([...structTypes(result("match-play"))].sort(), [`${arena}.MatchSummary`, `${arena}.MatchView`]);
  assert.deepEqual([...structTypes(result("open"))], [`${arena}.OpenChallenge`]);
});

test("open challenges decode to plain objects", () => {
  const [c] = decode(result("open"), fields);
  assert.equal(c.Clan, "Pickers");
  assert.equal(c.Challenger, player);
  assert.equal(c.Opponent, "");
  assert.equal(typeof c.Posted, "number");
  assert.equal(c.Expires - c.Posted, 604800);
});

test("a match view merges its summary and decodes nested slices", () => {
  const v = decode(result("match-play"), fields);
  assert.equal(v.Phase, "play");
  assert.equal(v.Round, 2);
  assert.equal(v.ToMove, player);
  assert.equal(v.Box, "box2");
  assert.deepEqual(v.Plans, [["Pick,Pick,Pick", "Brace,Brace,Brace"], ["", ""]]);
  assert.deepEqual(v.HP, [[15, 15]]);
  assert.equal(v.DeadlinePassed, false);
  assert.equal(v.MatchSummary, undefined);
});

test("an open match decodes its empty slices to []", () => {
  const v = decode(result("match-open"), fields);
  assert.deepEqual(v.Plans, []);
  assert.deepEqual(v.HP, []);
});

test("an ended match carries its result", () => {
  const v = decode(result("match-ended"), fields);
  assert.equal(v.Phase, "ended");
  assert.equal(v.Result, "draw");
  assert.equal(v.Reason, "hp");
  assert.equal(v.HP.length, 3);
});

test("negative ints and bools decode", () => {
  assert.equal(decode(int(-1), fields), -1);
  assert.equal(decode({ T: { "@type": "/gno.PrimitiveType", value: "4" }, N: "AQAAAAAAAAA=" }, fields), true);
  assert.equal(decode({ T: { "@type": "/gno.PrimitiveType", value: "4" } }, fields), false);
});

test("an object reference throws", () => {
  const ref = { T: { "@type": "/gno.RefType", ID: `${arena}.MatchView` }, V: { "@type": "/gno.RefValue", ObjectID: "abc:1" } };
  assert.throws(() => decode(ref, fields), /object reference in a query result/);
});

test("a struct of an unknown type throws", () => {
  assert.throws(() => decode(result("open"), new Map()), /no fields known for gno.land\/r\/gfanton\/gnomehall\/arena.OpenChallenge/);
});

test("integer kinds narrower than 8 bytes throw", () => {
  // gno fills only their low bytes of N, so reading all 8 would give a wrong value.
  for (const [kind, N] of [["64", "/gAAAAAAAAA="], ["512", "/////wAAAAA="], ["4096", "//////////8="]]) {
    assert.throws(() => decode({ T: { "@type": "/gno.PrimitiveType", value: kind }, N }, fields), /unsupported primitive type/);
  }
});

test("a byte slice throws", () => {
  const bytes = {
    T: { "@type": "/gno.SliceType", Elt: { "@type": "/gno.PrimitiveType", value: "4096" } },
    V: { "@type": "/gno.SliceValue", Base: { "@type": "/gno.ArrayValue", List: null, Data: "YWI=" }, Offset: "0", Length: "2", Maxcap: "2" },
  };
  assert.throws(() => decode(bytes, fields), /unsupported byte slice/);
});

test("a slice left in storage throws", () => {
  const stored = {
    T: { "@type": "/gno.SliceType", Elt: { "@type": "/gno.PrimitiveType", value: "16" } },
    V: { "@type": "/gno.SliceValue", Base: { "@type": "/gno.RefValue", ObjectID: "abc:2" }, Offset: "0", Length: "2", Maxcap: "2" },
  };
  assert.throws(() => decode(stored, fields), /object reference in a query result/);
});
