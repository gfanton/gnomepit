import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  type AccountState,
  type ArenaChange,
  ArenaError,
  type Connection,
  type Listed,
  type MatchDetail,
  type Mode,
  type OpenChallenge,
} from "./arena.ts";
import { known, unexpected, unexpectedAsync, unusedPage } from "./fixture.ts";
import { type Address, type MatchId, address, matchId } from "./ids.ts";
import { type Lobby, type LobbyArena, type LobbyOptions, createLobby, linkedMatch, setupStep } from "./lobby.ts";
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
function lobbyOf(
  arena: LobbyArena,
  player: Address | "",
  storage = memory(),
  portrait: LobbyOptions["portrait"] = () => "",
) {
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
    portrait,
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
  assert.match(shown(), /<small>Ready to play<\/small>/);
  account(lobby).state = "missing";
  assert.match(shown(), /<small>Needs approval<\/small>/);
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

test("while it runs, a withdrawal or a resignation is named as the button named it", async (t) => {
  stubPage(t);
  for (const [view, text] of [
    [detail({ Challenger: alice }), "Withdrawing the challenge…"],
    [bobsMove, "Resigning…"],
  ] as const) {
    const arena = endingArena(view);
    arena.resign = () => new Promise(() => {});
    const { lobby, shown } = lobbyOf(arena, view === bobsMove ? bob : alice);
    await lobby.action("Open", { id: "4" });
    void lobby.action("ResignConfirm");
    assert.match(shown(), new RegExp(`role="status">${text}<`));
  }
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

test("only the poster of a reserved challenge is told to share it", async (t) => {
  stubPage(t);
  const arena = endingArena(detail({ Opponent: bob }));
  const poster = lobbyOf(arena, alice);
  await poster.lobby.action("Open", { id: "4" });
  assert.match(poster.shown(), /Reserved for .*Share the link to invite them/s);
  const reserved = lobbyOf(arena, bob);
  await reserved.lobby.action("Open", { id: "4" });
  assert.match(reserved.shown(), /Reserved for you\./);
  assert.doesNotMatch(reserved.shown(), /Share the link/);
});

test("resigning replaces the move confirmation", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.move = async () => {};
  arena.resign = async () => {
    arena.view = { ...bobsMove, Phase: "ended", Result: "a", Reason: "resign", action: "done" };
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  assert.match(shown(), /Your move is confirmed\./);
  await lobby.action("ResignConfirm");
  assert.doesNotMatch(shown(), /Your move is confirmed\./);
});

test("the move confirmation goes once the watched match moves on", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.move = async () => {
    arena.view = { ...bobsMove, ToMove: alice, action: "wait" };
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  await known(arena.onView)(arena.view);
  assert.match(shown(), /Your move is confirmed\./);
  await known(arena.onView)({ ...bobsMove, Phase: "ended", Result: "b", Reason: "resign", action: "done" });
  assert.doesNotMatch(shown(), /Your move is confirmed\./);
});

test("an unsent plan stays while its match waits for it, and goes when the player resigns", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.resign = async () => {
    arena.view = { ...bobsMove, Phase: "ended", Result: "a", Reason: "resign", action: "done" };
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  const draft = { onlineContext: { intent: "move" as const, view: { id: matchId("4") } } };
  lobby.model.draft = draft;
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.equal(lobby.model.draft, draft);
  await lobby.action("ResignConfirm");
  await lobby.action("Board");
  assert.equal(lobby.model.draft, null);
  assert.doesNotMatch(shown(), /Resume draft/);
});

test("the board drops an unsent plan whose match ended while the player was away", async (t) => {
  stubPage(t);
  const arena = endingArena(ended);
  const { Plans: _plans, HP: _hp, ...summary } = ended;
  arena.myMatches = async () => [summary];
  const { lobby, shown } = lobbyOf(arena, bob);
  lobby.model.draft = { onlineContext: { intent: "move" as const, view: { id: matchId("4") } } };
  await lobby.enter();
  assert.equal(lobby.model.draft, null);
  assert.doesNotMatch(shown(), /Resume draft/);
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

test("My matches names the opponent a posted challenge is reserved for", async (t) => {
  stubPage(t);
  const arena = followedArena();
  arena.myMatches = async () => [detail({ ID: matchId("6"), Opponent: bob }), detail({ ID: matchId("7") })];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  const board = shown();
  assert.equal(board.match(/Reserved for/g)?.length, 1);
  assert.equal(board.match(/Anyone can accept/g)?.length, 1);
});

test("portraits and notices wear their own clan's colours, whichever side the clan plays", async (t) => {
  stubPage(t);
  const arena = followedArena();
  arena.myMatches = async () => [
    detail({ ID: matchId("6"), Phase: "play", Acceptor: bob, ChallengerClan: "Ironhide", AcceptorClan: "Pickers" }),
  ];
  arena.board = [
    {
      ID: matchId("7"),
      Challenger: bob,
      Clan: "Delvers",
      Opponent: "",
      Posted: 0,
      Expires: 9e9,
      action: "accept",
      deadline: 9e9,
    },
  ];
  const { lobby, shown } = lobbyOf(arena, alice, memory(), (clan, attributes) => `<img ${attributes} alt="${clan}">`);
  await lobby.enter();
  const board = shown();
  assert.match(board, /<img class="portrait portrait--ironhide" alt="Ironhide">/);
  assert.match(board, /<img class="portrait portrait--pickers" alt="Pickers">/);
  assert.match(board, /<article class="challenge challenge--delvers">/);
});

test("My matches keeps a ledger: a row a match, the player's move marked, ended grudges set back", async (t) => {
  stubPage(t);
  const arena = followedArena();
  const { Plans: _plans, HP: _hp, ...over } = ended;
  arena.myMatches = async () => [
    detail({
      ID: matchId("6"),
      Phase: "play",
      Round: 2,
      Acceptor: bob,
      ChallengerClan: "Pickers",
      AcceptorClan: "Ironhide",
      ToMove: alice,
      action: "move",
    }),
    detail({ ID: matchId("7"), Opponent: bob }),
    { ...over, ID: matchId("8"), Reason: "resign" },
  ];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  const ledger = /<ol class="ledger">(.*?)<\/ol>/s.exec(shown())?.[1] ?? "";
  assert.equal(ledger.match(/<li class="grudge[ "]/g)?.length, 3);
  assert.equal(ledger.match(/<li class="grudge grudge--turn"/g)?.length, 1);
  assert.equal(ledger.match(/<li class="grudge grudge--over"/g)?.length, 1);
  assert.match(ledger, /Round 2 of 3/);
  // An address in a row is for reading; the match page copies it.
  assert.doesNotMatch(ledger, /data-action="onlineCopy"/);
});

// brass lists the board's brass buttons by their words.
const brass = (html: string) =>
  Array.from(html.matchAll(/<button type="button" class="button"[^>]*>([^<]*)</g), ([, text]) => text);

const onMove = () =>
  detail({
    ID: matchId("6"),
    Phase: "play",
    Round: 2,
    Acceptor: bob,
    ChallengerClan: "Pickers",
    AcceptorClan: "Ironhide",
    ToMove: alice,
    action: "move",
  });
const bobsNotice = {
  ID: matchId("9"),
  Challenger: bob,
  Clan: "Ironhide",
  Opponent: "" as const,
  Posted: 0,
  Expires: 9e9,
  action: "accept" as const,
  deadline: 9e9,
};

test("the board's one brass button opens the match waiting on the player", async (t) => {
  stubPage(t);
  const arena = followedArena();
  arena.myMatches = async () => [onMove(), detail({ ID: matchId("7"), Opponent: bob })];
  arena.board = [bobsNotice];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  assert.deepEqual(brass(shown()), ["Open match"]);
});

test("with nothing waiting on the player, Post a challenge is the board's brass button", async (t) => {
  stubPage(t);
  const arena = followedArena();
  arena.myMatches = async () => [detail({ ID: matchId("7"), Opponent: bob })];
  arena.board = [bobsNotice];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  assert.deepEqual(brass(shown()), ["Post a challenge"]);
});

test("an unsent move waits in its match's row, not in a notice of its own", async (t) => {
  stubPage(t);
  const arena = followedArena();
  arena.myMatches = async () => [onMove()];
  const { lobby, shown } = lobbyOf(arena, alice);
  lobby.model.draft = { onlineContext: { intent: "move" as const, view: { id: matchId("6") } } };
  await lobby.enter();
  assert.doesNotMatch(shown(), /<section class="notice">/);
  const row = /<li class="grudge grudge--turn">(.*?)<\/li>/s.exec(shown())?.[1] ?? "";
  assert.match(row, /Your plan is saved/);
  assert.match(row, /data-action="onlineResumeDraft"/);
  assert.deepEqual(brass(shown()), ["Resume plan"]);
});

test("an unsent challenge or acceptance says which it is", async (t) => {
  stubPage(t);
  for (const [intent, words] of [
    ["challenge", "Your challenge is not posted yet"],
    ["accept", "Your acceptance is not sent yet"],
  ] as const) {
    const arena = followedArena();
    const { lobby, shown } = lobbyOf(arena, alice);
    lobby.model.draft = { onlineContext: { intent } };
    await lobby.enter();
    const notice = /<section class="notice">(.*?)<\/section>/s.exec(shown())?.[1] ?? "";
    assert.match(notice, new RegExp(words), intent);
    assert.deepEqual(brass(shown()), ["Resume plan"], intent);
  }
});

test("open challenges hang as notices on the board, each read without a copy button", async (t) => {
  stubPage(t);
  const arena = followedArena();
  const notice = (id: string, Challenger: Address, Opponent: Address | "" = "") => ({
    ID: matchId(id),
    Challenger,
    Clan: "Ironhide",
    Opponent,
    Posted: 0,
    Expires: 9e9,
    action: "accept" as const,
    deadline: 9e9,
  });
  arena.board = [notice("7", bob), notice("8", bob, alice)];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  const board = /<ul class="notice-board">(.*?)<\/ul>/s.exec(shown())?.[1] ?? "";
  assert.equal(board.match(/<li><article class="challenge challenge--ironhide">/g)?.length, 2);
  assert.match(board, /Reserved for you/);
  assert.doesNotMatch(board, /data-action="onlineCopy"/);
});

test("a match page stages both champions on the table, with their health and addresses", async (t) => {
  stubPage(t);
  const arena = endingArena(
    detail({
      Phase: "play",
      Round: 2,
      Acceptor: bob,
      ChallengerClan: "Pickers",
      AcceptorClan: "Ironhide",
      ToMove: alice,
      HP: [
        [15, 15],
        [12, 9],
      ],
      action: "move",
    }),
  );
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  const page = shown();
  assert.match(page, /<section class="duel-stage">/);
  assert.match(page, /<figure class="duel-champion duel-champion--near fighter--pickers">.*?>You<.*?>12 HP</s);
  assert.match(page, /<figure class="duel-champion duel-champion--far fighter--ironhide">.*?>Ironhide<.*?>9 HP</s);
  assert.match(page, /Round 2 of 3/);
  assert.match(page, /Posted by you/);
  assert.equal(page.match(/data-address="g1bob"/g)?.length, 1);
});

test("an ended match page lights the winner and greys the loser", async (t) => {
  stubPage(t);
  const won = detail({ ...ended, ChallengerClan: "Pickers", AcceptorClan: "Ironhide" });
  const { lobby, shown } = lobbyOf(endingArena(won), bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /class="duel-champion duel-champion--near fighter--ironhide duel-champion--winner"/);
  assert.match(shown(), /class="duel-champion duel-champion--far fighter--pickers duel-champion--loser"/);
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
  known(arena.onChange)({ match: matchId("7"), event: "Board", height: 1 });
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
  known(arena.onChange)({ match: matchId("9"), event: "Turn", height: 1 });
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

// A node behind the one that took the move still answers with the turn it was sent for.
test("a confirmed move stays sent while the chain still reads its turn", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.move = async () => {};
  const { Plans: _plans, HP: _hp, ...summary } = bobsMove;
  arena.myMatches = async () => [summary];
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  const move = () => lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  await move();
  assert.match(shown(), /<h1>Waiting for/);
  assert.doesNotMatch(shown(), /Watch clash &amp; plan/);
  await assert.rejects(move(), /moved on/);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /Your move/);
  arena.view = { ...bobsMove, Round: 3 };
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /Watch clash &amp; plan/);
});

test("an accepted challenge the chain still reads as open is neither listed nor offered again", async (t) => {
  stubPage(t);
  const arena = endingArena(detail({ action: "accept" }));
  arena.board = [
    {
      ID: matchId("4"),
      Challenger: alice,
      Clan: "",
      Opponent: "",
      Posted: 0,
      Expires: 9e9,
      action: "accept",
      deadline: 9e9,
    },
  ];
  arena.accept = async () => {};
  arena.account = () => ({ address: bob, state: "active", mode: "session", fallback: null });
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  assert.match(shown(), /View challenge/);
  await lobby.sendDraft({ intent: "accept", view: { id: matchId("4") } }, "Pickers", [0], [0, 0, 0]);
  assert.doesNotMatch(shown(), /Accept challenge/);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /View challenge/);
});

test("a confirmed move the page cannot read back says it was confirmed, not that it failed", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  let moved = false;
  arena.move = async () => {
    moved = true;
  };
  arena.match = async () => {
    if (moved) throw new ArenaError("network", "Failed to fetch");
    return bobsMove;
  };
  const { Plans: _plans, HP: _hp, ...summary } = bobsMove;
  arena.myMatches = async () => [summary];
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  assert.match(shown(), /Your move was confirmed\..*do not send it again/);
  assert.doesNotMatch(shown(), /didn’t go through/);
  assert.doesNotMatch(shown(), /Your move</);
});

// Each read can come from another node, so one without the move's block can answer after
// one with it.
test("a confirmed move stays sent through reads from nodes on either side of its block", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.move = async () => {
    arena.view = { ...bobsMove, Phase: "reveal", ToMove: alice, action: "wait" };
  };
  const { Plans: _plans, HP: _hp, ...summary } = bobsMove;
  arena.myMatches = async () => [summary];
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  await arena.onView?.({ ...bobsMove, Phase: "reveal", Round: 1, ToMove: alice, action: "wait" });
  await arena.onView?.(bobsMove);
  assert.match(shown(), /<h1>Waiting for/);
  assert.doesNotMatch(shown(), /Watch clash &amp; plan/);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /Your move/);
});

test("an accepted challenge stays taken after the page reads it accepted", async (t) => {
  stubPage(t);
  const open = detail({ action: "accept" });
  const arena = endingArena(open);
  arena.board = [
    {
      ID: matchId("4"),
      Challenger: alice,
      Clan: "",
      Opponent: "",
      Posted: 0,
      Expires: 9e9,
      action: "accept",
      deadline: 9e9,
    },
  ];
  arena.accept = async () => {
    arena.view = detail({ Phase: "reveal", Acceptor: bob, ToMove: alice, action: "wait" });
  };
  arena.account = () => ({ address: bob, state: "active", mode: "session", fallback: null });
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "accept", view: { id: matchId("4") } }, "Pickers", [0], [0, 0, 0]);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /View challenge/);
  arena.view = open;
  await lobby.action("Open", { id: "4" });
  assert.doesNotMatch(shown(), /Accept challenge/);
});

test("a confirmed move whose board cannot be read stops following its match", async (t) => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  let moved = false;
  arena.move = async () => {
    moved = true;
    arena.view = { ...bobsMove, Phase: "reveal", ToMove: alice, action: "wait" };
  };
  arena.myMatches = async () => {
    if (moved) throw new ArenaError("network", "Failed to fetch");
    return [];
  };
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.sendDraft({ intent: "move", view: { id: matchId("4") } }, "Ironhide", [0], [0, 0, 0]);
  assert.equal(arena.onView, null);
  assert.match(shown(), /Your move was confirmed\./);
});

test("a confirmed send replaces an error left on screen before it", async (t) => {
  stubPage(t);
  const open = detail({ action: "accept" });
  const arena = endingArena(open);
  let down = false;
  arena.match = async () => {
    if (down) throw new ArenaError("network", "Failed to fetch");
    assert.ok(arena.view !== null, "the test serves no match");
    return arena.view;
  };
  arena.accept = async () => {
    arena.view = detail({ Phase: "reveal", Acceptor: bob, ToMove: alice, action: "wait" });
  };
  arena.account = () => ({ address: bob, state: "active", mode: "session", fallback: null });
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  down = true;
  await arena.onView?.(null);
  assert.match(shown(), /didn’t go through/);
  down = false;
  await lobby.sendDraft({ intent: "accept", view: { id: matchId("4") } }, "Pickers", [0], [0, 0, 0]);
  assert.match(shown(), /Challenge accepted\. Your plan is sealed\./);
  assert.doesNotMatch(shown(), /didn’t go through/);
});

// A node behind the one that took the last reveal still reads the match as waiting for it.
test("a confirmed finish is neither offered nor sent again while the chain still reads its last reveal", async (t) => {
  stubPage(t);
  const finishing: MatchDetail = { ...lastTurn, action: "finish" };
  const arena = endingArena(finishing);
  let finishes = 0;
  arena.finish = async () => {
    finishes++;
  };
  const { Plans: _plans, HP: _hp, ...summary } = finishing;
  arena.myMatches = async () => [summary];
  const { lobby, played, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.equal(finishes, 1);
  assert.doesNotMatch(shown(), /Finish match/);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /Ready to finish/);
  await lobby.action("Open", { id: "4" });
  assert.equal(finishes, 1);
  await known(arena.onView)(ended);
  assert.deepEqual(played, [{ phase: "ended", review: true }]);
});

// A notification's click opens another match while Adena's window holds the finish.
test("a finish confirmed after another match opened is not sent again", async (t) => {
  stubPage(t);
  const finishing: MatchDetail = { ...lastTurn, action: "finish" };
  const other = detail({ ID: matchId("9"), Phase: "reveal", Challenger: bob, Acceptor: alice, ToMove: bob });
  const arena = endingArena(finishing);
  arena.match = async (id) => (id === other.ID ? other : finishing);
  let finishes = 0;
  let approve = () => {};
  arena.finish = () => {
    finishes++;
    return finishes > 1
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          approve = () => resolve();
        });
  };
  const { lobby } = lobbyOf(arena, alice);
  await lobby.enter();
  const opening = lobby.action("Open", { id: "4" });
  await flush();
  await lobby.enter("9");
  approve();
  await opening;
  await lobby.action("Open", { id: "4" });
  assert.equal(finishes, 1);
});

// Bob may claim the match Alice let run past its deadline.
const missed = detail({
  Phase: "play",
  Round: 2,
  Challenger: alice,
  Acceptor: bob,
  ToMove: alice,
  DeadlinePassed: true,
  action: "claimForfeit",
});

test("a confirmed claim is not offered again while the chain still reads the missed deadline", async (t) => {
  stubPage(t);
  const arena = endingArena(missed);
  let claims = 0;
  arena.claimForfeit = async () => {
    claims++;
  };
  const { Plans: _plans, HP: _hp, ...summary } = missed;
  arena.myMatches = async () => [summary];
  const { lobby, shown } = lobbyOf(arena, bob);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.action("Claim");
  assert.equal(claims, 1);
  assert.doesNotMatch(shown(), /Claim win/);
  await lobby.action("Board");
  assert.doesNotMatch(shown(), /Claim your win/);
});

test("a confirmed claim or finish whose match cannot be read back is not offered again", async (t) => {
  stubPage(t);
  const cases: [MatchDetail, Address, string, RegExp][] = [
    [missed, bob, "Claim", /Claim win/],
    [{ ...lastTurn, action: "finish" }, alice, "Finish", /Finish match/],
  ];
  for (const [view, player, button, offered] of cases) {
    const arena = endingArena(view);
    let sent = false;
    arena.claimForfeit = arena.finish = async () => {
      sent = true;
    };
    arena.match = async () => {
      if (sent) throw new ArenaError("network", "Failed to fetch");
      return view;
    };
    const { lobby, shown } = lobbyOf(arena, player);
    account(lobby).state = "missing";
    await lobby.enter();
    await lobby.action("Open", { id: "4" });
    account(lobby).state = "active";
    await lobby.action(button);
    assert.ok(sent, button);
    assert.doesNotMatch(shown(), offered, button);
  }
});

// The arena names no match for a challenge an Adena answered before its block.
test("a rematch posted without its match's id returns to the board, not to the match it came from", async (t) => {
  stubPage(t);
  const arena = endingArena({ ...ended, Reason: "resign" });
  arena.challenge = async () => matchId("");
  arena.account = () => ({ address: alice, state: "active", mode: "contract", fallback: null });
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.sendDraft({ intent: "challenge", view: null, opponent: bob }, "Ironhide", [0], [0, 0, 0]);
  assert.equal(lobby.model.view, null);
  assert.equal(arena.onView, null);
  assert.match(shown(), /Your challenge is posted\./);
  assert.match(shown(), /<h1>A rival awaits\.<\/h1>/);
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
    validity: "",
    reported: 0,
    showModal() {},
    close() {},
    addEventListener() {},
    append() {},
    setCustomValidity(message: string) {
      dialog.validity = message;
    },
    reportValidity() {
      dialog.reported++;
      return dialog.validity === "";
    },
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
  assert.match(dialog.innerHTML, /<h2 id="online-dialog-title">Post a challenge<\/h2>/);
  await lobby.action("Compose");
  assert.equal(lobby.model.error, "");
  assert.deepEqual(
    composed.map((c) => c.intent),
    ["challenge"],
  );
});

test("a rematch posts a challenge reserved for the same opponent", async (t) => {
  const composed: Parameters<LobbyOptions["onCompose"]>[0][] = [];
  const reserved: (string | undefined)[] = [];
  // The realm reserves a challenge only for a real account address.
  const rival = address("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const ended = detail({ ID: matchId("5"), Phase: "ended", Challenger: alice, Acceptor: rival, Result: "challenger" });
  const arena = followedArena();
  arena.match = async (id) => (id === ended.ID ? ended : detail({ ID: id, Opponent: rival }));
  arena.challenge = async ({ opponent }) => {
    reserved.push(opponent);
    return matchId("6");
  };
  arena.account = () => ({ address: alice, state: "active", mode: "session", fallback: null });
  const { lobby, dialog } = dialogLobby(t, arena, { onCompose: (context) => composed.push(context) });
  lobby.model.account = arena.account();
  lobby.model.view = viewOf(ended, alice);
  await lobby.action("Rematch");
  assert.ok(dialog.innerHTML.includes(`value="${rival}"`));
  dialog.value = rival;
  await lobby.action("Compose");
  await lobby.sendDraft(known(composed[0]), "Ironhide", [0], [0, 0, 0]);
  assert.deepEqual(reserved, [rival]);
  assert.equal(lobby.model.view?.id, "6");
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

test("the pressed button and a status line show a request under way until it ends", async () => {
  const page = app();
  let connected = (_connection: Connection) => {};
  const arena = {
    ...followedArena(),
    connect: () =>
      new Promise<Connection>((resolve) => {
        connected = resolve;
      }),
  };
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  const pressing = lobby.action("Authorize", { action: "onlineAuthorize" });
  assert.match(page.innerHTML, /<button[^>]*data-action="onlineAuthorize"[^>]*aria-busy="true"/);
  assert.match(page.innerHTML, /role="status"[^>]*>Waiting for Adena\. Approve the request in its window\.</);
  assert.doesNotMatch(page.innerHTML, /data-action="onlineAccount"[^>]*aria-busy/);
  connected({ state: "noWallet", reason: "No Adena wallet in this browser" });
  await pressing;
  assert.doesNotMatch(page.innerHTML, /aria-busy/);
  assert.doesNotMatch(page.innerHTML, /Waiting for Adena/);
});

test("a board read spins its button and tells only screen readers it is loading", async () => {
  const page = app();
  const arena = followedArena();
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  arena.openChallenges = () => new Promise(() => {});
  void lobby.action("Refresh", { action: "onlineRefresh" });
  assert.match(page.innerHTML, /<button[^>]*data-action="onlineRefresh"[^>]*aria-busy="true"/);
  assert.match(page.innerHTML, /<p class="sr-only" role="status">Loading…<\/p>/);
  assert.doesNotMatch(page.innerHTML, /busy-note/);
});

test("a match's Open button shows its match opening, and no other", async (t) => {
  stubPage(t);
  const page = app();
  const arena = followedArena();
  const challenge = (id: string): Listed<OpenChallenge> => ({
    ID: matchId(id),
    Challenger: bob,
    Clan: "Pickers",
    Opponent: "",
    Posted: 0,
    Expires: 9e9,
    action: "accept",
    deadline: 9e9,
  });
  arena.board = [challenge("1"), challenge("2")];
  arena.match = () => new Promise(() => {});
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena,
    storage: memory(),
    onRender: () => lobby.render(),
    portrait: () => "",
    emblem: () => "",
  });
  await lobby.enter();
  void lobby.action("Open", { action: "onlineOpen", id: "2" });
  assert.match(page.innerHTML, /<button[^>]*aria-busy="true"[^>]*data-id="2"/);
  assert.doesNotMatch(page.innerHTML, /<button[^>]*aria-busy="true"[^>]*data-id="1"/);
  assert.match(page.innerHTML, /role="status"[^>]*>Opening the match…</);
});

test("while the page looks for Adena the board says so, and redraws when the search ends", async () => {
  const page = app();
  let ended = () => {};
  let found = true;
  const arena = {
    ...followedArena(),
    get hasWallet() {
      return found;
    },
    walletSearch: new Promise<void>((resolve) => {
      ended = resolve;
    }),
  };
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  assert.match(page.innerHTML, /Looking for Adena in this browser…/);
  found = false;
  ended();
  await flush();
  assert.match(page.innerHTML, /aria-current="step"><strong>1 · Install Adena/);
  assert.doesNotMatch(page.innerHTML, /Looking for Adena/);
});

test("Connect pressed while the page still looks for Adena says it is looking, not waiting on Adena", async () => {
  const page = app();
  const arena = {
    ...followedArena(),
    walletSearch: new Promise<void>(() => {}),
    connect: () => new Promise<Connection>(() => {}),
  };
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  void lobby.action("Authorize", { action: "onlineAuthorize" });
  assert.match(page.innerHTML, /role="status">Looking for Adena in this browser…</);
  assert.doesNotMatch(page.innerHTML, /Approve the request/);
});

test("a pager button spins while its page loads", async () => {
  const page = app();
  const arena = followedArena();
  arena.board = Array.from({ length: 50 }, (_, i) => ({
    ID: matchId(String(i + 1)),
    Challenger: bob,
    Clan: "Pickers",
    Opponent: "" as const,
    Posted: 0,
    Expires: 9e9,
    action: "accept" as const,
    deadline: 9e9,
  }));
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena,
    storage: memory(),
    onRender: () => lobby.render(),
    portrait: () => "",
    emblem: () => "",
  });
  await lobby.enter();
  arena.openChallenges = () => new Promise(() => {});
  void lobby.action("Page", { action: "onlinePage", kind: "Challenges", page: "1" });
  assert.match(page.innerHTML, /<button[^>]*aria-busy="true"[^>]*data-kind="Challenges" data-page="1"/);
});

test("the wallet search ending leaves an open dialog alone, and redraws once it closes", async () => {
  let ended = () => {};
  const closers: EventListener[] = [];
  const dialog = {
    innerHTML: "",
    value: "",
    open: true,
    showModal() {},
    close() {},
    addEventListener(type: string, listener: EventListener) {
      if (type === "close") closers.push(listener);
    },
    append() {},
    setCustomValidity() {},
    reportValidity: () => true,
  };
  const arena = {
    ...followedArena(),
    walletSearch: new Promise<void>((resolve) => {
      ended = resolve;
    }),
  };
  let draws = 0;
  const lobby = createLobby({
    ...unusedPage,
    app: { ...app(), querySelector: () => dialog },
    arena,
    storage: memory(),
    onRender: () => {
      draws++;
    },
  });
  await lobby.enter();
  const before = draws;
  ended();
  await flush();
  assert.equal(draws, before, "a redraw would replace the open dialog");
  for (const close of closers) close(new Event("close"));
  assert.equal(draws, before + 1);
});

test("leaving the board mid-request frees it for the next visit", async (t) => {
  stubPage(t);
  const page = app();
  const arena = followedArena();
  let answer = () => {};
  arena.openChallenges = () =>
    new Promise((resolve) => {
      answer = () => resolve([]);
    });
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena,
    storage: memory(),
    onRender: () => lobby.render(),
    onExit() {},
  });
  const first = lobby.enter();
  await lobby.action("Exit");
  answer();
  await first;
  arena.openChallenges = async () => [];
  await lobby.enter();
  assert.equal(lobby.model.busy, false);
  assert.doesNotMatch(page.innerHTML, /aria-busy/);
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

test("the board's wordmark marks the game as in beta and leaves online play", async () => {
  const page = app();
  const lobby = createLobby({ ...unusedPage, app: page, arena: followedArena(), storage: memory(), onRender() {} });
  lobby.render();
  assert.match(
    page.innerHTML,
    /class="wordmark" href="\.\/" data-action="onlineExit">Gnomepit<span class="wordmark__beta">Beta</,
  );
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

test("a challenger's own open challenge says it is up, and its empty seat waits for any rival", async (t) => {
  stubPage(t);
  const { lobby, shown } = lobbyOf(
    endingArena(detail({ Phase: "open", ChallengerClan: "Pickers", action: "wait" })),
    alice,
  );
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /<h1>Your challenge is up<\/h1>/);
  assert.match(shown(), /Any rival/);
  assert.doesNotMatch(shown(), /Rival to come/);
  const other = lobbyOf(endingArena(detail({ Phase: "open", ChallengerClan: "Pickers", action: "accept" })), bob);
  await other.lobby.enter();
  await other.lobby.action("Open", { id: "4" });
  assert.match(other.shown(), /<h1>A challenge awaits<\/h1>/);
});

test("resigning asks with the loss named on its button, and keeping on is the first choice", async (t) => {
  const arena = endingArena(bobsMove);
  const { lobby, dialog } = dialogLobby(t, arena);
  lobby.model.view = viewOf(bobsMove, bob);
  await lobby.action("Resign");
  const keep = dialog.innerHTML.indexOf("Keep playing");
  const resign = dialog.innerHTML.search(/data-action="onlineResignConfirm"[^>]*>Resign match</);
  assert.ok(keep !== -1 && resign !== -1 && keep < resign, dialog.innerHTML);
  assert.match(dialog.innerHTML, /class="button" data-action="onlineClose"/);
  assert.doesNotMatch(dialog.innerHTML, />Confirm</);
});

test("an opponent address that is no account keeps the post dialog open and says so on the field", async (t) => {
  const composed: string[] = [];
  const { lobby, dialog } = dialogLobby(t, followedArena(), { onCompose: (c) => composed.push(c.opponent) });
  lobby.model.account = { address: alice, state: "active", mode: "session", fallback: null };
  await lobby.action("Post");
  dialog.value = "g1nope";
  await lobby.action("Compose");
  assert.deepEqual(composed, []);
  assert.match(dialog.validity, /gno\.land account address/);
  assert.equal(dialog.reported, 1);
  dialog.value = " g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5 ";
  await lobby.action("Compose");
  assert.deepEqual(composed, ["g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"]);
  assert.equal(dialog.validity, "");
});

test("a challenger's own challenge reads as theirs on its page and on the board", async (t) => {
  stubPage(t);
  const open = detail({ Phase: "open", ChallengerClan: "Pickers", action: "wait" });
  const arena = endingArena(open);
  arena.board = [
    {
      ID: matchId("4"),
      Challenger: alice,
      Clan: "Pickers",
      Opponent: "",
      Posted: 0,
      Expires: 9e9,
      action: "wait",
      deadline: 0,
    },
  ];
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  const board = shown();
  assert.match(board, /<span class="label">Your challenge<\/span>/);
  assert.match(board, /class="quiet" data-action="onlineOpen"\s+data-id="4">View challenge</);
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /Posted by you/);
  assert.doesNotMatch(shown(), /before accepting/);
});

test("withdrawing a challenge asks with Keep it open first", async (t) => {
  const open = detail({ Phase: "open", action: "wait" });
  const { lobby, dialog } = dialogLobby(t, endingArena(open));
  lobby.model.view = viewOf(open, alice);
  await lobby.action("Resign");
  assert.match(dialog.innerHTML, /data-action="onlineClose"[^>]*>Keep it open</);
  assert.match(dialog.innerHTML, /data-action="onlineResignConfirm"[^>]*>Withdraw challenge</);
});

test("an empty board offers to post the first challenge", async () => {
  const page = app();
  const lobby = createLobby({
    ...unusedPage,
    app: page,
    arena: followedArena(),
    storage: memory(),
    onRender: () => lobby.render(),
  });
  await lobby.enter();
  const empty = page.innerHTML.slice(page.innerHTML.indexOf("The board is quiet."));
  assert.match(empty, /^The board is quiet\.<\/h3><p>[^<]*<\/p><button[^>]*data-action="onlinePost"/);
});

// waiting is match 4 after alice's plan for round 2, with bob to move.
const waiting = detail({ Phase: "play", Round: 2, Acceptor: bob, ToMove: bob, action: "wait" });

// notifyingArena serves view as match 4 and can turn notifications on, which on says they are.
function notifyingArena(view: MatchDetail, on = false) {
  const arena = Object.assign(endingArena(view), { canNotify: true, notified: 0 });
  arena.notifying = async () => on;
  arena.notify = async () => {
    arena.notified++;
    on = true;
    return 2;
  };
  return arena;
}

test("a player waiting on their opponent is offered notifications, and Not now keeps it away from that match", async (t) => {
  stubPage(t);
  const storage = memory();
  const { lobby, shown } = lobbyOf(notifyingArena(waiting), alice, storage);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /Hear when it’s your move/);
  assert.match(shown(), /data-action="onlineNotifyLater"\s+data-id="4"/);
  await lobby.action("NotifyLater", { id: "4" });
  assert.doesNotMatch(shown(), /Hear when it’s your move/);

  const again = lobbyOf(notifyingArena(waiting), alice, storage);
  await again.lobby.enter();
  await again.lobby.action("Open", { id: "4" });
  assert.doesNotMatch(again.shown(), /Hear when it’s your move/);
});

test("a challenger's own open challenge offers to hear when a rival accepts", async (t) => {
  stubPage(t);
  const { lobby, shown } = lobbyOf(notifyingArena(detail({ Phase: "open", action: "wait" })), alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  assert.match(shown(), /Hear when a rival accepts/);
});

test("Notify me on the offer turns notifications on and the offer goes", async (t) => {
  stubPage(t);
  const arena = notifyingArena(waiting);
  const { lobby, shown } = lobbyOf(arena, alice);
  await lobby.enter();
  await lobby.action("Open", { id: "4" });
  await lobby.action("Notify");
  assert.equal(arena.notified, 1);
  assert.equal(lobby.model.notifications, "on");
  assert.doesNotMatch(shown(), /Hear when it’s your move/);
});

test("notifications already on show as on, with no offer", async (t) => {
  stubPage(t);
  const { lobby, shown } = lobbyOf(notifyingArena(waiting, true), alice);
  await lobby.enter();
  assert.equal(lobby.model.notifications, "on");
  assert.match(shown(), /Notifications on/);
  await lobby.action("Open", { id: "4" });
  assert.doesNotMatch(shown(), /Hear when it’s your move/);
});

test("notifications the browser blocks are never offered", async (t) => {
  stubPage(t);
  Object.defineProperty(globalThis, "Notification", { value: { permission: "denied" }, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, "Notification"));
  const { lobby, shown } = lobbyOf(notifyingArena(waiting), alice);
  await lobby.enter();
  assert.equal(lobby.model.notifications, "blocked");
  await lobby.action("Open", { id: "4" });
  assert.doesNotMatch(shown(), /Hear when it’s your move/);
});

test("a match the player only watches, or one that is theirs to play, offers no notifications", async (t) => {
  stubPage(t);
  const watched = lobbyOf(notifyingArena(waiting), address("g1carol"));
  await watched.lobby.enter();
  await watched.lobby.action("Open", { id: "4" });
  assert.doesNotMatch(watched.shown(), /Hear when/);
  const toPlay = lobbyOf(notifyingArena({ ...waiting, ToMove: alice, action: "move" }), alice);
  await toPlay.lobby.enter();
  await toPlay.lobby.action("Open", { id: "4" });
  assert.doesNotMatch(toPlay.shown(), /Hear when/);
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

// The banner fills a laptop screen, so a message below it goes unseen.
// On a phone the setup steps fill the first screen.
test("the board says what went wrong above its setup steps and its banner", async () => {
  const page = app();
  const arena = {
    ...followedArena(),
    connect: async () => {
      throw new ArenaError("refused", "Switch Adena to onyx-1, then connect again.");
    },
  };
  const lobby = createLobby({ ...unusedPage, app: page, arena, storage: memory(), onRender: () => lobby.render() });
  await lobby.enter();
  await lobby.action("Authorize");
  const said = page.innerHTML.indexOf("Switch Adena to onyx-1");
  assert.ok(said !== -1 && said < page.innerHTML.indexOf("hall-banner"), "the reason shows before the banner");
  assert.ok(said < page.innerHTML.indexOf("wallet-setup"), "the reason shows before the setup steps");
});

test("a #match= fragment names its match, decoded, and any other fragment names none", () => {
  assert.equal(linkedMatch("#match=12"), "12");
  assert.equal(linkedMatch("#match=a%2Fb"), "a/b");
  for (const hash of ["", "#", "#match=", "#other=1", "#match=%E0"]) assert.equal(linkedMatch(hash), undefined, hash);
});
