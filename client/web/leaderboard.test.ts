import test from "node:test";
import assert from "node:assert/strict";

import { address } from "./ids.ts";
import { type LeaderboardView, type PlayerRow, leaderboardHTML } from "./leaderboard.ts";
import { previewView } from "./leaderboard-preview.ts";

const row = (id: string, rank: number | null): PlayerRow => ({
  id,
  rank,
  address: null,
  name: id,
  mainClan: "Pickers",
  elo: 1000,
  wins: 1,
  losses: 2,
  draws: 3,
});

const ready = (parts: Partial<Extract<LeaderboardView, { status: "ready" }>>): LeaderboardView => ({
  status: "ready",
  preview: false,
  players: [],
  own: { kind: "unranked" },
  clans: [],
  updatedLabel: "",
  ...parts,
});

test("a ready board lists its rows in the given order, ranks and ties included", () => {
  const html = leaderboardHTML(ready({ players: [row("a", 1), row("b", 1), row("c", 3)] }));
  assert.deepEqual(
    [...html.matchAll(/Rank <\/span>(\d+)/g)].map((m) => m[1]),
    ["1", "1", "3"],
  );
});

test("a row without a name shows the shortened address", () => {
  const html = leaderboardHTML(
    ready({ players: [{ ...row("a", 1), name: null, address: address("g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w") }] }),
  );
  assert.match(html, /g1vzpn5t…uw09w/);
});

test("names and clans are escaped", () => {
  const html = leaderboardHTML(ready({ players: [{ ...row("a", 1), name: "<b>x</b>", mainClan: "<i>y</i>" }] }));
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.doesNotMatch(html, /<i>y<\/i>/);
});

test("the own row is marked, and an unranked own player reads Unranked", () => {
  assert.match(
    leaderboardHTML(ready({ players: [row("a", 1)], own: { kind: "player", player: row("a", 1) } })),
    /class="is-you"/,
  );
  assert.match(leaderboardHTML(ready({ own: { kind: "player", player: row("z", null) } })), /Unranked/);
});

test("a viewer whose wallet named no account is asked to connect, not called unranked", () => {
  const html = leaderboardHTML(ready({ own: { kind: "connect", error: "" } }));
  assert.match(
    html,
    /<button type="button" class="button button--secondary" data-action="connect">Connect wallet<\/button>/,
  );
  assert.doesNotMatch(html, /Unranked|after your first rated matches/);
  assert.match(
    leaderboardHTML(ready({})),
    /after your first rated matches/,
    "a viewer with no wallet is invited to play",
  );
});

test("a refused connection says why in an alert, escaped", () => {
  const html = leaderboardHTML(ready({ own: { kind: "connect", error: "Unlock <Adena>" } }));
  assert.match(html, /<p role="alert">Unlock &lt;Adena><\/p>/);
  assert.doesNotMatch(html, /<Adena>/);
});

test("a standing that could not be read says so, and calls no one unranked", () => {
  const html = leaderboardHTML(ready({ own: { kind: "unavailable" } }));
  assert.match(html, /Your standing is out of reach\./);
  assert.doesNotMatch(html, /Unranked|after your first rated matches/);
});

test("the own standing can take focus after the wallet answers", () => {
  assert.match(
    leaderboardHTML(ready({})),
    /<section class="own-standing" aria-labelledby="your-standing" tabindex="-1">/,
  );
});

test("null numbers read as a dash and zero as zero", () => {
  const html = leaderboardHTML(ready({ own: { kind: "player", player: { ...row("z", null), elo: null, wins: 0 } } }));
  assert.match(html, /<dd>—<\/dd>/);
  assert.match(html, /<b>0<\/b>/);
});

test("loading, error and empty views say so", () => {
  assert.match(leaderboardHTML({ status: "loading", preview: false }), /Reading the hall’s records/);
  assert.match(leaderboardHTML({ status: "error", preview: false }), /The records are out of reach/);
  assert.match(leaderboardHTML(ready({})), /A place waiting to be earned/);
});

test("standings that fail to load offer another try", () => {
  const html = leaderboardHTML({ status: "error", preview: false });
  assert.match(html, /Check your connection, then try again\./);
  assert.match(html, /<a class="button" href="">Try again<\/a>/);
  assert.doesNotMatch(html, /check again later/);
});

test("the masthead names Gnomepit and the seal carries its initials", () => {
  const html = leaderboardHTML(ready({}));
  assert.match(html, /class="wordmark"[^>]*>Gnomepit<span class="wordmark__beta">Beta</);
  assert.match(html, /class="ranking-seal" aria-hidden="true">GP</);
});

test("only a preview carries the preview notice", () => {
  assert.match(leaderboardHTML(previewView(null)), /DESIGN PREVIEW/);
  assert.doesNotMatch(leaderboardHTML(ready({})), /DESIGN PREVIEW/);
});

test("the preview's states", () => {
  assert.equal(previewView("loading").status, "loading");
  assert.equal(previewView("error").status, "error");
  const empty = previewView("empty");
  assert.ok(empty.status === "ready" && empty.players.length === 0 && empty.clans.length === 0);
  const full = previewView(null);
  assert.ok(full.status === "ready" && full.players.length === 10);
  assert.ok(full.own.kind === "player" && full.own.player.id === full.players[4]?.id);
  const connect = previewView("connect");
  assert.ok(connect.status === "ready" && connect.players.length === 10);
  assert.deepEqual(connect.own, { kind: "connect", error: "" });
});
