import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  type AccountState,
  type ArenaChange,
  ArenaError,
  type Listed,
  type MatchDetail,
  type Mode,
  type OpenChallenge,
} from "./arena.ts";
import { known, unexpected, unexpectedAsync, unusedPage } from "./fixture.ts";
import { type Address, type MatchId, address, matchId } from "./ids.ts";
import { type Lobby, type LobbyArena, type LobbyOptions, createLobby, setupStep } from "./lobby.ts";
import { type View, viewOf } from "./online-model.ts";

const app = () => ({
  classList: { add() {}, remove() {}, toggle() {} },
  dataset: {},
  innerHTML: "",
  querySelector: () => null,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const alice = address("g1alice");
const bob = address("g1bob");

// unusedArena is an arena that expects no call, which a test gives the calls it expects.
const unusedArena = (): LobbyArena => ({
  canNotify: false,
  connect: unexpectedAsync("connect"),
  authorize: unexpectedAsync("authorize"),
  account: unexpected("account"),
  resumeSessions: unexpected("resumeSessions"),
  renew: unexpectedAsync("renew"),
  openChallenges: unexpectedAsync("openChallenges"),
  myMatches: unexpectedAsync("myMatches"),
  match: unexpectedAsync("match"),
  challenge: unexpectedAsync("challenge"),
  accept: unexpectedAsync("accept"),
  move: unexpectedAsync("move"),
  finish: unexpectedAsync("finish"),
  resign: unexpectedAsync("resign"),
  claimForfeit: unexpectedAsync("claimForfeit"),
  notify: unexpectedAsync("notify"),
});

type Followed = LobbyArena & {
  board: Listed<OpenChallenge>[];
  reads: number;
  onChange: ((change: ArenaChange) => void) | null;
};
// followedArena is an arena whose board the test sets, and whose subscribe hands the test
// the lobby's change handler.
function followedArena(): Followed {
  const arena: Followed = { ...unusedArena(), board: [], reads: 0, onChange: null, hasWallet: true };
  arena.openChallenges = async () => {
    arena.reads++;
    return arena.board;
  };
  arena.myMatches = async () => [];
  arena.subscribe = (fn) => {
    arena.onChange = fn;
    return () => {
      arena.onChange = null;
    };
  };
  return arena;
}

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, value) => items.set(k, String(value)) };
}

function stubPage(t: TestContext) {
  Object.defineProperty(globalThis, "history", { value: { replaceState() {} }, configurable: true });
  Object.defineProperty(globalThis, "location", {
    value: { pathname: "/", search: "", origin: "http://page.local" },
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "history");
    Reflect.deleteProperty(globalThis, "location");
  });
}

// account is the account the lobby shows, which the test changes.
function account(lobby: Lobby<unknown>): AccountState {
  const shown = lobby.model.account;
  assert.ok(shown !== null && "mode" in shown, "the lobby shows no connected account");
  return shown;
}

const fresh = () => ({ hp: 15, vulnerable: 0, strength: 0, spent: [] });
// detail is a match as the arena's match gives it, with the fields a test names.
const detail = (fields: Partial<MatchDetail & OpenChallenge>): MatchDetail => ({
  ID: matchId("4"),
  Phase: "open",
  Round: 1,
  Challenger: alice,
  Acceptor: "",
  ChallengerClan: "",
  AcceptorClan: "",
  ToMove: "",
  Deadline: 0,
  Result: "",
  Reason: "",
  Opponent: "",
  ChallengerDeck: "",
  AcceptorDeck: "",
  Plans: [],
  Box: "",
  HP: [],
  DeadlinePassed: false,
  rounds: [],
  state: { round: 1, gnomes: [fresh(), fresh()] },
  pending: undefined,
  planning: undefined,
  action: "done",
  session: "active",
  deadline: 0,
  ...fields,
});

const ended = detail({
  ID: matchId("4"),
  Phase: "ended",
  Round: 3,
  Challenger: alice,
  Acceptor: bob,
  Result: "b",
  Reason: "hp",
  Plans: [
    ["Stone Guard", "Undermine,Double Tap"],
    ["Pick,Pick,Pick", "Pick,Pick,Pick"],
    ["Bulwark,Avalanche", "Momentum,Pickaxe Flurry,Pick"],
  ],
  HP: [
    [15, 15],
    [14, 14],
    [13, 14],
  ],
  action: "done",
});
const lastTurn: MatchDetail = {
  ...ended,
  Phase: "reveal",
  ToMove: alice,
  Result: "",
  Reason: "",
  Plans: [...ended.Plans.slice(0, 2), ["", "Momentum,Pickaxe Flurry,Pick"]],
  HP: ended.HP.slice(0, 2),
};

type Ending = Followed & {
  view: MatchDetail | null;
  onView: ((view: MatchDetail | null) => void | Promise<void>) | null;
  finished?: MatchId;
  resigned?: MatchId;
  watchedThrough?: boolean;
};
// endingArena serves match 4 as arena.view says, and hands the test the lobby's watch.
function endingArena(view: MatchDetail | null): Ending {
  const watching: Pick<Ending, "view" | "onView"> = { view, onView: null };
  const arena: Ending = Object.assign(followedArena(), watching);
  arena.match = async () => {
    assert.ok(arena.view !== null, "the test serves no match");
    return arena.view;
  };
  arena.finish = async (id) => {
    arena.finished = id;
    arena.view = ended;
  };
  arena.watch = (_id, fn) => {
    arena.onView = fn;
    return () => {
      arena.onView = null;
    };
  };
  return arena;
}

// lobbyOf is a lobby for the player at address, which records each clash it plays;
// shown draws it and returns the page.
function lobbyOf(arena: LobbyArena, player: Address | "", storage = memory()) {
  const played: { phase: string; review: boolean }[] = [],
    page = app();
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena,
    storage,
    onRender() {},
    onPlay(raw, _who, review) {
      played.push({ phase: raw.Phase, review });
    },
    portrait: () => "",
    emblem: () => "",
  });
  if (player !== "") lobby.model.account = { address: player, state: "active", mode: "session", fallback: null };
  const shown = () => {
    lobby.render();
    return page.innerHTML;
  };
  return { lobby, played, shown };
}

test("the challenger who finishes the match watches its last clash", async (t) => {
  stubPage(t);
  const arena = endingArena({ ...lastTurn, action: "finish" });
  const { lobby, played } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.equal(arena.finished, "4");
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

test("finishing from the button plays the last clash too", async (t) => {
  stubPage(t);
  const arena = endingArena({ ...lastTurn, action: "finish" });
  const { lobby, played } = lobbyOf(arena, alice);
  account(lobby).state = "missing";
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.equal(arena.finished, undefined);
  account(lobby).state = "active";
  await lobby.action("Finish");
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

test("a player watching the match sees its last clash when it ends", async (t) => {
  stubPage(t);
  const arena = endingArena({ ...lastTurn, action: "wait" });
  const { lobby, played } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.deepEqual(played, []);
  await known(arena.onView)(ended);
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

test("an ended match plays its last clash only the first time its player opens it", async (t) => {
  stubPage(t);
  const arena = endingArena(ended);
  const { lobby, played } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.returnToBoard();
  await lobby.action("Open", { id: "4" });
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

// A fresh chain numbers its matches from 1 again.
test("another match under a number already seen plays its last clash", async (t) => {
  stubPage(t);
  const arena = endingArena(ended);
  const { lobby, played } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  arena.view = { ...ended, Plans: [["Pick,Pick,Pick", "Pick,Pick,Pick"], ...ended.Plans.slice(1)] };
  await lobby.action("Open", { id: "4" });
  assert.equal(played.length, 2);
});

test("a match that ended without a clash, or that someone else played, opens on its result", async (t) => {
  stubPage(t);
  const cases: [MatchDetail, Address][] = [
    [{ ...ended, Reason: "resign" }, bob],
    [{ ...ended, Reason: "forfeit" }, bob],
    [ended, address("g1carol")],
  ];
  for (const [view, player] of cases) {
    const { lobby, played } = lobbyOf(endingArena(view), player);
    await lobby.enter();
    await lobby.action("Open", { id: "4" });
    assert.deepEqual(played, [], `${view.Reason} for ${player}`);
  }
});

// Before round 3, a finish instead of a move would tell the challenger the match is over.
test("a challenger whose clash ends the match early sees an ordinary move until it plays", async (t) => {
  stubPage(t);
  const early: MatchDetail = {
    ...lastTurn,
    Round: 2,
    Plans: [known(ended.Plans[0]), ["", "Pick,Pick,Pick"]],
    HP: ended.HP.slice(0, 1),
    action: "finish",
  };
  const { lobby, shown } = lobbyOf(endingArena(early), alice);
  account(lobby).state = "missing";
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /<h1>Your move<\/h1>/);
  assert.doesNotMatch(shown(), /finish/i);
  assert.match(shown(), /data-action="onlineAccount"[^>]*>Connect to play</);
  account(lobby).state = "active";
  assert.match(shown(), /data-action="onlineFinish"[^>]*>Watch clash &amp; plan</);
});

const bobsMove = detail({
  ID: matchId("4"),
  Phase: "play",
  Round: 2,
  Challenger: alice,
  Acceptor: bob,
  ToMove: bob,
  Plans: [known(ended.Plans[0]), ["", ""]],
  HP: ended.HP.slice(0, 1),
  action: "move",
});

// renewingArena is an endingArena for player whose renew records the match and makes its
// session active, or, with mode contract, leaves the wallet to sign each move.
function renewingArena(view: MatchDetail, player: Address, mode: Mode = "session") {
  const renewed: MatchId[] = [];
  const arena = Object.assign(endingArena(view), { renewed });
  arena.renew = async (id) => {
    arena.renewed.push(id);
    arena.view = { ...known(arena.view), session: "active" };
  };
  arena.account = () => ({
    address: player,
    state: "active",
    mode,
    fallback: mode === "contract" ? "User rejected" : null,
  });
  return arena;
}

test("an expired match session offers renewal", async (t) => {
  stubPage(t);
  const arena = renewingArena({ ...bobsMove, session: "expired" }, bob);
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /data-action="onlineRenew"[^>]*>Renew session to play</);
  await lobby.action("Renew");
  assert.deepEqual(arena.renewed, ["4"]);
  assert.match(shown(), /data-action="onlinePlay"[^>]*>Watch clash &amp; plan</);
});

test("a renewal the wallet refused shows the per-move mode", async (t) => {
  stubPage(t);
  const arena = renewingArena({ ...bobsMove, session: "expired" }, bob, "contract");
  const { lobby } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.action("Renew");
  assert.equal(account(lobby).mode, "contract");
});

// Finishing on an expired session would fail; the player renews first.
test("a finish whose session has expired waits for renewal", async (t) => {
  stubPage(t);
  const arena = renewingArena({ ...lastTurn, action: "finish", session: "expired" }, alice);
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.equal(arena.finished, undefined);
  assert.equal(lobby.model.error, "");
  assert.match(shown(), /data-action="onlineRenew"[^>]*>Renew session to play</);
  await lobby.action("Renew");
  assert.match(shown(), /data-action="onlineFinish"[^>]*>Finish match</);
});

test("the header says whether this device can play", () => {
  const { lobby, shown } = lobbyOf(followedArena(), alice);
  assert.match(shown(), /<small>Device ready<\/small>/);
  account(lobby).state = "missing";
  assert.match(shown(), /<small>Approval needed<\/small>/);
});

// The realm deletes a withdrawn challenge, so the match it was is gone.
test("withdrawing returns to the board", async (t) => {
  stubPage(t);
  const arena = endingArena(
    detail({
      ID: matchId("4"),
      Phase: "open",
      Challenger: alice,
      Clan: "Pickers",
      Expires: 9e9,
      action: "wait",
    }),
  );
  arena.match = async () => {
    if (arena.view === null) throw new Error("unknown match");
    return arena.view;
  };
  arena.resign = async (id) => {
    arena.resigned = id;
    arena.watchedThrough = arena.onView !== null;
    arena.view = null;
  };
  const { lobby } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  const reads = arena.reads;
  await lobby.action("ResignConfirm");
  assert.equal(arena.resigned, "4");
  assert.equal(arena.watchedThrough, false, "a watch read after the withdrawal would find no match");
  assert.equal(lobby.model.view, null);
  assert.equal(lobby.model.error, "");
  assert.equal(arena.reads, reads + 1, "the board is read again");
});

// The realm deletes a withdrawn challenge, and a later challenge clears an expired one.
test("a link to a removed challenge says so and stays on the board", async (t) => {
  stubPage(t);
  const arena: Followed & { watched?: boolean } = followedArena();
  arena.match = async () => {
    throw new ArenaError("wrongPhase", "unknown match");
  };
  arena.watch = () => {
    arena.watched = true;
    return () => {};
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter("4");
  assert.equal(lobby.model.view, null);
  assert.equal(lobby.model.error, "");
  assert.equal(arena.watched, undefined);
  const page = shown();
  assert.match(page, /This challenge was withdrawn or has expired\./);
  assert.match(page, /Open challenges/);
  assert.doesNotMatch(page, /didn’t go through/);
});

test("resigning a running match shows its result", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.resign = async () => {
    arena.view = { ...bobsMove, Phase: "ended", Result: "a", Reason: "resign", action: "done" };
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.action("ResignConfirm");
  assert.match(shown(), /<h1>You lost<\/h1>/);
});

test("the board hides an ended match's result until its last clash has played", async (t) => {
  stubPage(t);
  const arena = endingArena(ended);
  const { Plans: _plans, HP: _hp, ...summary } = ended;
  arena.myMatches = async () => [summary, { ...summary, ID: matchId("5"), Reason: "resign" }];
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  const before = shown();
  assert.match(before, /Match over.*Watch the last clash/s);
  assert.equal(before.match(/You won/g)?.length, 1, "only the resigned match shows its result");
  assert.doesNotMatch(before, /Decided by HP/);
  await lobby.action("Open", { id: "4" });
  await lobby.action("Board");
  assert.equal(shown().match(/You won/g)?.length, 2);
  assert.match(shown(), /Decided by HP/);
});

test("a match opened from its link is watched", async (t) => {
  stubPage(t);
  const arena = endingArena({ ...lastTurn, action: "wait" });
  const { lobby } = lobbyOf(arena, bob);
  await lobby.enter("4");
  assert.equal(typeof arena.onView, "function");
});

test("connecting on a match opened from its link plays its last clash", async (t) => {
  stubPage(t);
  const arena = endingArena(ended);
  arena.connect = async () => ({ address: bob, state: "active", mode: "session", fallback: null });
  const { lobby, played } = lobbyOf(arena, "");
  await lobby.enter("4");
  assert.deepEqual(played, []);
  await lobby.action("Authorize");
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

test("the board reads its lists again on each change the arena reports", async () => {
  const arena = followedArena();
  const lobby = createLobby({ ...unusedPage, app: app(), arena, onRender() {} });
  await lobby.enter();
  assert.deepEqual<View[]>(lobby.model.challenges, []);

  arena.board = [
    {
      ID: matchId("7"),
      Challenger: alice,
      Clan: "Ironhide",
      Opponent: "",
      Posted: 0,
      Expires: 9e9,
      action: "accept",
      deadline: 9e9,
    },
  ];
  known(arena.onChange)({ match: null, func: "Challenge", caller: alice, height: 1 });
  await flush();
  assert.equal(lobby.model.challenges[0]?.id, "7");
  assert.equal(lobby.model.busy, false);
});

// Each redraw replays the cards' entrance animation, and most calls on a busy arena
// touch nothing this board lists.
test("a change that leaves the lists as they were does not redraw the board", async () => {
  const arena = followedArena();
  let renders = 0;
  const lobby = createLobby({
    ...unusedPage,
    app: app(),
    arena,
    onRender() {
      renders++;
    },
  });
  await lobby.enter();
  const drawn = renders;
  known(arena.onChange)({ match: matchId("9"), func: "Play", caller: alice, height: 1 });
  await flush();
  assert.equal(renders, drawn);
});

test("a change while a match is open leaves the board alone", async () => {
  const arena = followedArena();
  const lobby = createLobby({ ...unusedPage, app: app(), arena, onRender() {} });
  await lobby.enter();
  lobby.model.view = viewOf({ ID: matchId("3") });
  const reads = arena.reads;
  known(arena.onChange)({});
  await flush();
  assert.equal(arena.reads, reads);
});

test("after a move is sent, the match it was sent in is watched", async () => {
  const arena: Followed & { watched?: MatchId } = followedArena();
  const view = detail({
    ID: matchId("5"),
    Phase: "play",
    Round: 2,
    Challenger: bob,
    Acceptor: alice,
    ToMove: alice,
    action: "move",
  });
  arena.match = async () => view;
  arena.move = async () => {};
  arena.watch = (id) => {
    arena.watched = id;
    return () => {};
  };
  const lobby = createLobby({ ...unusedPage, app: app(), arena, onRender() {} });
  await lobby.enter();
  lobby.model.account = { address: alice, state: "active", mode: "session", fallback: null };
  await lobby.sendDraft({ intent: "move", view: { id: matchId("5") } }, "Ironhide", [0], [0, 0, 0]);
  assert.equal(arena.watched, "5");
});

// dialogLobby is a lobby whose page answers every query with one dialog, which the test
// reads; the dialog doubles as the opponent field.
function dialogLobby(t: TestContext, arena: LobbyArena, options: Partial<LobbyOptions> = {}) {
  Object.defineProperty(globalThis, "document", { value: { activeElement: null }, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "document");
  });
  const dialog = {
    innerHTML: "",
    value: "",
    open: false,
    showModal() {},
    close() {},
    addEventListener() {},
    append() {},
  };
  const lobby = createLobby({
    ...unusedPage,
    app: { ...app(), querySelector: () => dialog },
    arena,
    onRender() {},
    ...options,
  });
  return { lobby, dialog };
}

const perMatch =
  "Each match you post or accept asks your wallet once, for a one-day session that only plays that match.";

test("the setup dialog says each match asks the wallet for its own session", async (t) => {
  const { lobby, dialog } = dialogLobby(t, followedArena());
  await lobby.action("Account");
  assert.match(dialog.innerHTML, /Approve a session for each match/);
  assert.ok(dialog.innerHTML.includes(perMatch));
  assert.doesNotMatch(dialog.innerHTML, /seven|10 GNOT/);
  lobby.model.account = { address: alice, state: "missing", mode: "session", fallback: null };
  await lobby.action("Account");
  assert.match(dialog.innerHTML, /data-action="onlineAuthorize"[^>]*>Sign on this device</);
});

test("a ready device's account dialog says what each match asks", async (t) => {
  const { lobby, dialog } = dialogLobby(t, followedArena());
  lobby.model.account = { address: alice, state: "active", mode: "session", fallback: null };
  await lobby.action("Account");
  assert.ok(dialog.innerHTML.includes(`<p>This device can play online. ${perMatch}</p>`));
  assert.doesNotMatch(dialog.innerHTML, /onlineAuthorize/);
});

test("a device whose wallet signs each move can use sessions again", async (t) => {
  const arena = followedArena();
  arena.connect = async () => ({ address: alice, state: "active", mode: "contract", fallback: "User rejected" });
  arena.authorize = async () => {
    throw new Error("connecting asked for the root signature again");
  };
  arena.resumeSessions = () => ({ address: alice, state: "active", mode: "session", fallback: null });
  const { lobby, dialog } = dialogLobby(t, arena);
  await lobby.action("Authorize");
  assert.equal(lobby.model.error, "");
  assert.equal(account(lobby).mode, "contract");
  await lobby.action("Account");
  assert.match(dialog.innerHTML, /User rejected/);
  assert.match(dialog.innerHTML, /data-action="onlineResumeSessions"[^>]*>Use sessions again</);
  await lobby.action("ResumeSessions");
  assert.equal(account(lobby).mode, "session");
});

test("posting needs no session beforehand", async (t) => {
  const composed: { intent: string }[] = [];
  const arena = followedArena();
  arena.connect = async () => ({ address: alice, state: "active", mode: "session", fallback: null });
  arena.authorize = async () => {
    throw new Error("posting asked the wallet for an approval");
  };
  const { lobby, dialog } = dialogLobby(t, arena, { onCompose: (context) => composed.push(context) });
  await lobby.action("Authorize");
  await lobby.action("Post");
  assert.match(dialog.innerHTML, /Leave a challenge/);
  await lobby.action("Compose");
  assert.equal(lobby.model.error, "");
  assert.deepEqual(
    composed.map((c) => c.intent),
    ["challenge"],
  );
});

test("leaving online play stops following the arena", async (t) => {
  Object.defineProperty(globalThis, "history", { value: { replaceState() {} }, configurable: true });
  Object.defineProperty(globalThis, "location", { value: { pathname: "/", search: "" }, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "history");
    Reflect.deleteProperty(globalThis, "location");
  });
  const arena = followedArena();
  const lobby = createLobby({ ...unusedPage, app: app(), arena, onRender() {}, onExit() {} });
  await lobby.enter();
  assert.equal(typeof arena.onChange, "function");
  await lobby.action("Exit");
  assert.equal(arena.onChange, null);
});

test("the setup step follows what the device still lacks", () => {
  assert.equal(setupStep({ hasWallet: false, address: "", ready: false }), 1);
  assert.equal(setupStep({ hasWallet: true, address: "", ready: false }), 2);
  assert.equal(setupStep({ hasWallet: true, address: "g1alice", ready: false }), 3);
  assert.equal(setupStep({ hasWallet: true, address: "g1alice", ready: true }), null);
});

test("without Adena the board leads with installing it", async () => {
  const page = app();
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena: { ...followedArena(), hasWallet: false, canNotify: false },
    storage: memory(),
    onRender: () => lobby.render(),
  });
  await lobby.enter();
  assert.match(page.innerHTML, /Get ready to play online/);
  assert.match(page.innerHTML, /href="https:\/\/adena\.app"/);
  assert.doesNotMatch(page.innerHTML, /Online play needs Adena/);
});

test("an arena that does not say it found a wallet starts the setup at installing Adena", async () => {
  const page = app();
  const { hasWallet: _hasWallet, ...arena } = followedArena();
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  assert.match(page.innerHTML, /aria-current="step"><strong>1 · Install Adena/);
});

test("Play offline leads home to the offline row, and the wordmark home", async () => {
  const exits: boolean[] = [];
  const lobby = createLobby({
    ...unusedPage,
    app: app(),
    arena: followedArena(),
    storage: memory(),
    onRender() {},
    onExit: (offline) => exits.push(offline),
  });
  Object.defineProperty(globalThis, "history", { value: { replaceState() {} }, configurable: true });
  Object.defineProperty(globalThis, "location", { value: { pathname: "/", search: "" }, configurable: true });
  try {
    await lobby.action("Offline");
    await lobby.action("Exit");
  } finally {
    Reflect.deleteProperty(globalThis, "history");
    Reflect.deleteProperty(globalThis, "location");
  }
  assert.deepEqual(exits, [true, false]);
});

test("a board that fits on one page shows no pager, and Notify me needs a notifier", async () => {
  const page = app();
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena: { ...followedArena(), hasWallet: true, canNotify: false },
    storage: memory(),
    onRender: () => lobby.render(),
  });
  await lobby.enter();
  assert.doesNotMatch(page.innerHTML, /Previous/);
  assert.doesNotMatch(page.innerHTML, /Notify me/);
});

test("a board the page cannot reach says so in plain words", async () => {
  const page = app();
  const arena = {
    ...followedArena(),
    hasWallet: true,
    canNotify: false,
    openChallenges: async () => {
      throw new ArenaError("network", "Failed to fetch");
    },
  };
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  assert.match(page.innerHTML, /Can't reach the hall right now\. Check your connection and try again\./);
  assert.doesNotMatch(page.innerHTML, /Failed to fetch/);
});
