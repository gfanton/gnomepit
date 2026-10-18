// The arena's standings as the leaderboard reads them: the ladder a page at a time, one
// player's standing, the clan standings and the number of rated players. Reading needs
// no wallet and no engine.

import * as v from "valibot";

import type { Chain } from "./chain.ts";
import { createReader } from "./gnovalue.ts";
import { type Address, address } from "./ids.ts";
import type { LeaderboardView, PlayerRow } from "./leaderboard.ts";

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

// playerRow is a standing as the screen shows it: no name, rank or main clan is null.
export function playerRow(s: Standing): PlayerRow {
  return {
    id: s.Player,
    rank: s.Rank === 0 ? null : s.Rank,
    address: s.Player,
    name: s.Name === "" ? null : s.Name,
    mainClan: s.MainClan === "" ? null : s.MainClan,
    elo: s.Rating,
    wins: s.Wins,
    losses: s.Losses,
    draws: s.Draws,
  };
}

// boardView is the ladder's first page and the clan standings, without the viewer's own
// standing; any failed query makes it an error view.
export async function boardView(standings: Standings): Promise<LeaderboardView> {
  try {
    const [players, clans] = await Promise.all([standings.leaderboard(0), standings.clanStandings()]);
    return {
      status: "ready",
      preview: false,
      players: players.map(playerRow),
      ownPlayer: null,
      clans: clans.map((c) => ({
        rank: c.Rank,
        clan: c.Clan,
        rating: c.Rating,
        wins: c.Wins,
        losses: c.Losses,
        draws: c.Draws,
      })),
      updatedLabel: "",
    };
  } catch {
    return { status: "error", preview: false };
  }
}

// withOwnStanding adds account's standing to a ready view when the account is ranked. It
// returns view unchanged otherwise, a failed read included: the board stands without it.
export async function withOwnStanding(
  view: LeaderboardView,
  standings: Standings,
  account: Address | null,
): Promise<LeaderboardView> {
  if (view.status !== "ready" || account === null) return view;
  try {
    const own = await standings.standing(account);
    return own.Rank === 0 ? view : { ...view, ownPlayer: playerRow(own) };
  } catch {
    return view;
  }
}
