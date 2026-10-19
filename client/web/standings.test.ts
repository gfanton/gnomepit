import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as v from "valibot";

import { ChainError } from "./chain.ts";
import { type Address, address } from "./ids.ts";
import { type Standing, type Standings, boardView, createStandings, withOwnStanding } from "./standings.ts";

const realm = "gno.land/r/gfanton/gnomepit/arena";
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

const standingOf = (player: Address, rank: number, name = ""): Standing => ({
  Rank: rank,
  Player: player,
  Name: name,
  MainClan: rank === 0 ? "" : "Pickers",
  Rating: 1000,
  Wins: rank === 0 ? 0 : 1,
  Losses: 0,
  Draws: 0,
});

function stub(parts: Partial<Standings>): Standings {
  return {
    leaderboard: async () => [],
    standing: async (player) => standingOf(player, 0),
    ratedPlayers: async () => 0,
    clanStandings: async () => [],
    ...parts,
  };
}

const nodeDown = async (): Promise<never> => {
  throw new ChainError("failed", "node down");
};

test("the board maps names, and an empty name to none", async () => {
  const view = await boardView(stub({ leaderboard: async () => [standingOf(alice, 1, "alice"), standingOf(bob, 2)] }));
  assert.ok(view.status === "ready");
  assert.equal(view.preview, false);
  assert.equal(view.ownPlayer, null);
  assert.equal(view.updatedLabel, "");
  assert.equal(view.players[0]?.name, "alice");
  assert.equal(view.players[1]?.name, null);
  assert.equal(view.players[1]?.address, bob);
  assert.equal(view.players[1]?.id, bob);
  assert.equal(view.players[1]?.rank, 2);
});

test("a failed query makes the board an error", async () => {
  assert.deepEqual(await boardView(stub({ clanStandings: nodeDown })), { status: "error", preview: false });
});

test("the own standing joins a ready board only for a ranked account", async () => {
  const board = await boardView(stub({ leaderboard: async () => [standingOf(alice, 1)] }));
  const ranked = await withOwnStanding(board, stub({ standing: async (p) => standingOf(p, 1) }), alice);
  assert.ok(ranked.status === "ready");
  assert.equal(ranked.ownPlayer?.id, alice);

  const unranked = await withOwnStanding(board, stub({}), alice);
  const noAccount = await withOwnStanding(board, stub({ standing: async (p) => standingOf(p, 1) }), null);
  const failed = await withOwnStanding(board, stub({ standing: nodeDown }), alice);
  for (const view of [unranked, noAccount, failed]) {
    assert.ok(view.status === "ready");
    assert.equal(view.ownPlayer, null);
  }
  const error = { status: "error", preview: false } as const;
  assert.equal(await withOwnStanding(error, stub({}), alice), error);
});

test("an own standing below the first page still shows, with no row marked", async () => {
  const carol = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const others = Array.from({ length: 50 }, (_, i) => standingOf(i % 2 === 0 ? alice : bob, i + 1));
  const board = await boardView(stub({ leaderboard: async () => others }));
  const view = await withOwnStanding(board, stub({ standing: async (p) => standingOf(p, 75) }), carol);
  assert.ok(view.status === "ready");
  assert.equal(view.ownPlayer?.rank, 75);
  assert.ok(!view.players.some((p) => p.id === carol));
});
