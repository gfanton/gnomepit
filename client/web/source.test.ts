import test from "node:test";
import assert from "node:assert/strict";

import { sourceLinksHTML } from "./source.ts";

test("the source links name the repository, and the realm when it has a page", () => {
  const both = sourceLinksHTML("Arena", "https://onyx.testnets.gno.land/r/x/arena/v0");
  assert.match(both, /<a href="https:\/\/github\.com\/gfanton\/gnomepit">Source on GitHub<\/a>/);
  assert.match(both, /<a href="https:\/\/onyx\.testnets\.gno\.land\/r\/x\/arena\/v0">Arena on gno\.land<\/a>/);
  const repositoryOnly = sourceLinksHTML("Arena", null);
  assert.match(repositoryOnly, /Source on GitHub/);
  assert.doesNotMatch(repositoryOnly, /gno\.land</);
});
