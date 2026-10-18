// The arena's standings as the leaderboard reads them: the ladder a page at a time, one
// player's standing, the clan standings and the number of rated players. Reading needs
// no wallet and no engine.

import * as v from "valibot";

import type { Chain } from "./chain.ts";
import { createReader } from "./gnovalue.ts";
import { type Address, address } from "./ids.ts";

export const pageSize = 50;

// The schemas follow r/arena's query.gno, as gnovalue decodes its answers.
const StandingSchema = v.object({
  Rank: v.number(),
  Player: v.pipe(v.string(), v.transform(address)),
  Name: v.string(),
  MainClan: v.string(),
  Rating: v.number(),
  Wins: v.number(),
  Losses: v.number(),
  Draws: v.number(),
});
const ClanStandingSchema = v.object({
  Rank: v.number(),
  Clan: v.string(),
  Rating: v.number(),
  Wins: v.number(),
  Losses: v.number(),
  Draws: v.number(),
});

export type Standing = v.InferOutput<typeof StandingSchema>;
export type ClanStanding = v.InferOutput<typeof ClanStandingSchema>;

export type Standings = {
  leaderboard(page: number): Promise<Standing[]>;
  standing(player: Address): Promise<Standing>;
  ratedPlayers(): Promise<number>;
  clanStandings(): Promise<ClanStanding[]>;
};

// createStandings reads realm's standings on chain; a failed read or an answer its schema
// refuses rejects.
export function createStandings({
  chain,
  realm,
}: {
  chain: Pick<Chain, "evalJSON" | "typeJSON">;
  realm: string;
}): Standings {
  const readValue = createReader(chain);
  const read = async <T>(expr: string, schema: v.GenericSchema<unknown, T>): Promise<T> =>
    v.parse(schema, await readValue(`${realm}.${expr}`));
  return {
    leaderboard: (page) => read(`Leaderboard(${page * pageSize}, ${pageSize})`, v.array(StandingSchema)),
    standing: (player) => read(`StandingOf("${player}")`, StandingSchema),
    ratedPlayers: () => read("RatedPlayers()", v.number()),
    clanStandings: () => read("ClanStandings()", v.array(ClanStandingSchema)),
  };
}
