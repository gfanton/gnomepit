import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as v from "valibot";

import { ChainError } from "./chain.ts";
import { address } from "./ids.ts";
import { createStandings } from "./standings.ts";

const realm = "gno.land/r/gfanton/gnomehall/arena";
const alice = address("g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w");
const bob = address("g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw");
const unrated = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./testdata/qeval/${name}.json`, import.meta.url), "utf8"));
const RecordedSchema = v.object({ results: v.array(v.unknown()) });

// recordedChain answers the standings queries with the answers capture.sh recorded on a
// chain where alice beat bob twice, and lists every expression it was asked.
function recordedChain() {
  const asked: string[] = [];
  const answers: Record<string, string> = {
    [`${realm}.RatedPlayers()`]: "rated-players",
    [`${realm}.ClanStandings()`]: "clan-standings",
    [`${realm}.StandingOf("${alice}")`]: "standing-rated",
    [`${realm}.StandingOf("${unrated}")`]: "standing-unrated",
  };
  return {
    asked,
    evalJSON: async (expr: string) => {
      asked.push(expr);
      const name = expr.startsWith(`${realm}.Leaderboard(`) ? "leaderboard" : answers[expr];
      if (name === undefined) throw new Error(`the test chain does not answer ${expr}`);
      return v.parse(RecordedSchema, load(name)).results;
    },
    typeJSON: async (id: string) => load(`qtype-${id.split(".").at(-1) ?? ""}`),
  };
}

test("a leaderboard page asks for 50 rows at its offset and reads them", async () => {
  const chain = recordedChain();
  const standings = createStandings({ chain, realm });
  const rows = await standings.leaderboard(0);
  assert.equal(chain.asked[0], `${realm}.Leaderboard(0, 50)`);
  assert.deepEqual(
    rows.map((r) => [r.Rank, r.Player, r.Name, r.MainClan]),
    [
      [1, alice, "", "Pickers"],
      [2, bob, "", "Ironhide"],
    ],
  );
  assert.equal(rows[0]?.Wins, 2);
  assert.equal((rows[0]?.Rating ?? 0) + (rows[1]?.Rating ?? 0), 2000);
  await standings.leaderboard(1);
  assert.equal(chain.asked.at(-1), `${realm}.Leaderboard(50, 50)`);
});

test("a player's standing, rated or not", async () => {
  const standings = createStandings({ chain: recordedChain(), realm });
  const rated = await standings.standing(alice);
  assert.equal(rated.Rank, 1);
  assert.equal(rated.Player, alice);
  const none = await standings.standing(unrated);
  assert.equal(none.Rank, 0);
  assert.equal(none.Rating, 1000);
  assert.equal(none.MainClan, "");
});

test("the clan standings and the number of rated players", async () => {
  const standings = createStandings({ chain: recordedChain(), realm });
  const clans = await standings.clanStandings();
  assert.deepEqual(
    clans.map((c) => c.Clan),
    ["Pickers", "Delvers", "Ironhide"],
  );
  assert.equal(clans[0]?.Wins, 2);
  assert.equal(await standings.ratedPlayers(), 2);
});

test("a failed read rejects", async () => {
  const standings = createStandings({
    chain: {
      evalJSON: async () => {
        throw new ChainError("failed", "node down");
      },
      typeJSON: async () => ({}),
    },
    realm,
  });
  await assert.rejects(standings.leaderboard(0), /node down/);
});
