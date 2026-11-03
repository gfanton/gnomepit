// Illustrative standings for reviewing the screen's design, loaded only with ?preview=1.
// No rating is computed here, and none of it stands in for live standings.

import type { ClanRow, LeaderboardView, OwnStanding, PlayerRow } from "./leaderboard.ts";

const players: PlayerRow[] = (
  [
    ["1", "Mosswick", "Ironhide", 1842, 83, 24, 7],
    ["2", "Nettleknuckle", "Delvers", 1817, 76, 29, 5],
    ["3", "Coppercap", "Pickers", 1789, 71, 31, 8],
    ["4", "Grimble", "Ironhide", 1756, 69, 33, 6],
    ["5", "Wedge & Whisper", "Delvers", 1724, 64, 35, 9],
    ["6", "Flintfoot", "Pickers", 1703, 61, 38, 4],
    ["7", "Old Bracken", "Ironhide", 1681, 58, 40, 11],
    ["8", "Glimmerjack", "Delvers", 1664, 56, 42, 6],
    ["9", "g1k8d7…w9p2q", "Pickers", 1648, 54, 44, 7],
    ["10", "Soot & Cinders", "Ironhide", 1631, 51, 45, 8],
  ] as const
).map(([id, name, mainClan, elo, wins, losses, draws], i) => ({
  id,
  rank: i + 1,
  address: null,
  name,
  mainClan,
  elo,
  wins,
  losses,
  draws,
}));

const clans: ClanRow[] = [
  { rank: 1, clan: "Ironhide", rating: 1638, wins: 286, losses: 251, draws: 34 },
  { rank: 2, clan: "Delvers", rating: 1612, wins: 272, losses: 263, draws: 28 },
  { rank: 3, clan: "Pickers", rating: 1594, wins: 264, losses: 278, draws: 31 },
];

const own = (player: PlayerRow | undefined): OwnStanding =>
  player !== undefined ? { kind: "player", player } : { kind: "unranked" };

// previewView is the view for ?state=: "empty", "loading", "error", "connect", or the full board.
export function previewView(state: string | null): LeaderboardView {
  if (state === "loading" || state === "error") return { status: state, preview: true };
  if (state === "empty")
    return { status: "ready", preview: true, players: [], own: { kind: "unranked" }, clans: [], updatedLabel: "" };
  return {
    status: "ready",
    preview: true,
    players,
    own: state === "connect" ? { kind: "connect", error: "" } : own(players[4]),
    clans,
    updatedLabel: "Updated just now",
  };
}
