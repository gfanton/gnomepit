// The leaderboard screen: the ladder, the viewer's own standing and the clan standings,
// drawn from a view model the page supplies already ranked. client/LEADERBOARD.md has
// the view model and the design.

import type { Address } from "./ids.ts";
import { escapeHTML as esc } from "./keywords.ts";
import { wordmarkHTML } from "./wordmark.ts";

// A null rank reads Unranked and a null number a dash; zero stays zero.
export type PlayerRow = {
  id: string;
  rank: number | null;
  address: Address | null;
  name: string | null;
  mainClan: string | null;
  elo: number | null;
  wins: number | null;
  losses: number | null;
  draws: number | null;
};
export type ClanRow = { rank: number; clan: string; rating: number; wins: number; losses: number; draws: number };
export type LeaderboardView =
  | { status: "loading" | "error"; preview: boolean }
  | {
      status: "ready";
      preview: boolean;
      players: PlayerRow[];
      ownPlayer: PlayerRow | null;
      clans: ClanRow[];
      updatedLabel: string;
    };

type Counts = { wins: number | null; losses: number | null; draws: number | null };

const clanArt = new Map([
  ["Pickers", { portrait: "pickers-portrait-v2.jpg", image: "pickers-selection-v1.jpg" }],
  ["Ironhide", { portrait: "ironhide-portrait-v2.jpg", image: "ironhide-selection-v1.jpg" }],
  ["Delvers", { portrait: "delvers-portrait-v1.jpg", image: "delvers-selection-v5.jpg" }],
]);

const number = (n: number | null): string => (n !== null && Number.isFinite(n) ? n.toLocaleString("en-US") : "—");
const artOf = (clan: string | null) => (clan === null ? undefined : clanArt.get(clan));
const clanClass = (clan: string | null): string =>
  clan !== null && clanArt.has(clan) ? clan.toLowerCase() : "unknown";

function portrait(clan: string | null): string {
  const art = artOf(clan);
  return art !== undefined
    ? `<img class="rank-portrait" src="art/${art.portrait}" alt="">`
    : '<span class="rank-portrait rank-portrait--empty" aria-hidden="true">?</span>';
}

function name(p: PlayerRow): string {
  if (p.name !== null && p.name !== "") return esc(p.name);
  return esc(p.address !== null ? `${p.address.slice(0, 8)}…${p.address.slice(-5)}` : "Unknown player");
}

const record = (p: Counts): string =>
  `<span class="record"><span><b>${number(p.wins)}</b> <abbr title="Wins">W</abbr></span><span><b>${number(p.losses)}</b> <abbr title="Losses">L</abbr></span><span><b>${number(p.draws)}</b> <abbr title="Draws">D</abbr></span></span>`;

const identity = (p: PlayerRow): string =>
  `<span class="player-identity ${clanClass(p.mainClan)}">${portrait(p.mainClan)}<span><strong>${name(p)}</strong><span class="player-clan">${esc(p.mainClan ?? "No main clan yet")}</span></span></span>`;

function ownStanding(p: PlayerRow | null): string {
  const rank = p !== null && p.rank !== null && p.rank > 0 ? `#${number(p.rank)}` : "Unranked";
  return `<section class="own-standing" aria-labelledby="your-standing"><div class="own-standing__intro"><span class="eyebrow" id="your-standing">YOUR STANDING</span>${p !== null ? identity(p) : "<h2>Your story starts here.</h2><p>Your rank will appear after your first rated matches.</p>"}</div><dl class="own-standing__numbers"><div><dt>Rank</dt><dd>${rank}</dd></div><div><dt>Elo</dt><dd>${number(p?.elo ?? null)}</dd></div></dl><div class="own-standing__record"><span class="stat-label">MATCH RECORD</span>${record(p ?? { wins: null, losses: null, draws: null })}</div></section>`;
}

function rankingRows(players: PlayerRow[], ownId: string | undefined): string {
  return players
    .map(
      (p) =>
        `<tr class="${p.id === ownId ? "is-you" : ""}"><td class="rank-number ${p.rank !== null && p.rank <= 3 ? "rank-number--medal" : ""}"><span class="mobile-label">Rank </span>${number(p.rank)}</td><th scope="row">${identity(p)}${p.id === ownId ? '<span class="you-label">YOU</span>' : ""}</th><td class="main-clan ${clanClass(p.mainClan)}">${esc(p.mainClan ?? "—")}</td><td class="elo"><span class="mobile-label">Elo </span>${number(p.elo)}</td><td class="record-cell"><span class="desktop-record">${number(p.wins)}</span><span class="mobile-record">${record(p)}</span></td><td class="desktop-record">${number(p.losses)}</td><td class="desktop-record">${number(p.draws)}</td></tr>`,
    )
    .join("");
}

function clanStandings(items: ClanRow[]): string {
  const cards = items
    .map((c) => {
      const art = artOf(c.clan);
      return `<article class="clan-standing ${clanClass(c.clan)}"><div class="clan-standing__art">${art !== undefined ? `<img src="art/${art.image}" alt="">` : ""}<span class="clan-place">#${number(c.rank)}</span></div><div class="clan-standing__body"><div class="clan-standing__heading"><h3>${esc(c.clan)}</h3><span><strong>${number(c.rating)}</strong><span class="stat-label">CLAN RATING</span></span></div>${record(c)}</div></article>`;
    })
    .join("");
  return `<aside class="clan-standings" aria-labelledby="clan-title"><div class="standings-section-title"><div><h2 id="clan-title">Clan standings</h2></div></div>${items.length > 0 ? cards : '<div class="empty-panel"><h3>The clans await their challengers.</h3><p>Clan ratings and match records will appear here when standings are available.</p></div>'}</aside>`;
}

function rankings(view: LeaderboardView): string {
  switch (view.status) {
    case "loading":
      return '<div class="empty-panel" role="status"><span class="loading-rule"></span><h3>Reading the hall’s records…</h3></div>';
    case "error":
      return '<div class="empty-panel" role="status"><h3>The records are out of reach.</h3><p>Standings couldn’t be loaded. Check your connection, then try again.</p><a class="button" href="">Try again</a></div>';
    case "ready":
      return view.players.length > 0
        ? `<table class="ranking-table"><caption class="sr-only">Player leaderboard ranked by Elo, with main clan and win, loss and draw counts</caption><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Main clan</th><th scope="col">Elo</th><th scope="col"><abbr title="Wins">W</abbr></th><th scope="col"><abbr title="Losses">L</abbr></th><th scope="col"><abbr title="Draws">D</abbr></th></tr></thead><tbody>${rankingRows(view.players, view.ownPlayer?.id)}</tbody></table>`
        : '<div class="empty-panel"><span class="empty-mark" aria-hidden="true">Ⅰ</span><h3>A place waiting to be earned.</h3><p>No player standings are available yet. Rated match results will shape the hall.</p><a class="button button--secondary" href="index.html">Find your next duel</a></div>';
  }
}

export function leaderboardHTML(view: LeaderboardView): string {
  const ready = view.status === "ready" ? view : null;
  const updated = ready !== null && ready.updatedLabel !== "" ? `<span>${esc(ready.updatedLabel)}</span>` : "";
  return `<header class="masthead">${wordmarkHTML("index.html")}<nav class="home-nav" aria-label="Main navigation"><a href="index.html">Back to the hall</a><a href="leaderboard.html" aria-current="page">Leaderboard</a></nav></header>${view.preview ? '<p class="preview-notice">DESIGN PREVIEW · Illustrative players and scores. These are not live standings.</p>' : ""}<div class="standings-hero"><div><h1>The Hall of Rivals</h1><p>Every duel leaves a mark. See who holds their ground.</p></div><span class="ranking-seal" aria-hidden="true">GP<span>RANKED DUELS</span></span></div>${ownStanding(ready?.ownPlayer ?? null)}<div class="standings-layout"><section class="player-standings" aria-labelledby="players-title"><div class="standings-section-title"><div><h2 id="players-title">Player rankings</h2></div><span class="rating-label">RANKED BY ELO</span></div>${rankings(view)}<p class="rankings-note">Elo measures your standing. Your main clan appears beside your name.${updated}</p></section>${clanStandings(ready?.clans ?? [])}</div><footer class="standings-footer"><span>Forged below. Earned at the table.</span><a href="index.html">Back to the hall →</a></footer>`;
}
