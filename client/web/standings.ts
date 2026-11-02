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

// What the page reads of cards.json: its clans, keyed by name.
const CardsSchema = v.object({ Clans: v.record(v.string(), v.unknown()) });

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

// clanNamesOf is the names of the clans of cards, a parsed cards.json, in file order.
export function clanNamesOf(cards: unknown): string[] {
  return Object.keys(v.parse(CardsSchema, cards).Clans);
}

// withMissingClans is clans plus every clan of names it lacks, at 1000 and 0-0-0, highest
// rating first; equal ratings keep their order and share a rank. The store lists only
// clans with a rated cross-clan match.
export function withMissingClans(clans: readonly ClanStanding[], names: readonly string[]): ClanStanding[] {
  const listed = new Set(clans.map((c) => c.Clan));
  const missing = names
    .filter((name) => !listed.has(name))
    .map((Clan) => ({ Rank: 0, Clan, Rating: 1000, Wins: 0, Losses: 0, Draws: 0 }));
  const sorted = [...clans, ...missing].sort((a, b) => b.Rating - a.Rating);
  const ranked: ClanStanding[] = [];
  for (const [i, c] of sorted.entries()) {
    const above = ranked[i - 1];
    ranked.push({ ...c, Rank: above !== undefined && above.Rating === c.Rating ? above.Rank : i + 1 });
  }
  return ranked;
}

// boardView is the ladder's first page and the clan standings, every clan of clanNames
// among them, without the viewer's own standing; any failed query makes it an error view.
export async function boardView(standings: Standings, clanNames: readonly string[]): Promise<LeaderboardView> {
  try {
    const [players, clans] = await Promise.all([standings.leaderboard(0), standings.clanStandings()]);
    return {
      status: "ready",
      preview: false,
      players: players.map(playerRow),
      ownPlayer: null,
      clans: withMissingClans(clans, clanNames).map((c) => ({
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
