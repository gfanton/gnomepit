// Everything the lobby and the match screens need from the arena realm: the account's
// state, the board, a player's matches, one match with what this player can do now, and
// every move. Seals, salts, boxes and reveals stay inside: a challenger's move opens the
// sealed plan, reveals it and seals the next one in one call.

import * as v from "valibot";

import { type Chain, ChainError, feeFor, type GasPrice, messageOf, payFor, type Session } from "./chain.ts";
import { fromBase64 } from "./encoding.ts";
import {
  type BattleEvent,
  type Card,
  cardOf,
  type Engine,
  type GameState,
  type LegalPlansRequest,
  type Resolution,
  type Side,
  startState,
} from "./engine.ts";
import { createReader } from "./gnovalue.ts";
import { type Address, type MatchId, address, matchId } from "./ids.ts";
import type { Message, Signer } from "./signer.ts";
import {
  type BoxContents,
  CommittedSchema,
  type LockedMatch,
  type Role,
  type SessionEntry,
  type SessionKeys,
  type SortedSessions,
  type Wallet,
  WalletError,
  classifySessions,
  connect as connectWallet,
  deriveKeys,
  generations,
  lockedMatches,
  newSalt,
  nonEmpty,
  openBox,
  replyOf,
  revokeMessage,
  rootSignature,
  sealBox,
  sealOf,
  sessionBudget,
  sessionGas,
  sessionLifetime as defaultLifetime,
  sessionMessage,
  sessionReserve,
} from "./wallet.ts";

const pageSize = 50; // the realm's maxPage
// ms; setTimeout runs a longer delay at once.
const longestTimer = 2 ** 31 - 1;

// reason is readable text.
export class ArenaError extends Error {
  type:
    | "noWallet"
    | "wrongNetwork"
    | "refused"
    | "unauthorized"
    | "wrongPhase"
    | "sealMismatch"
    | "illegalPlan"
    | "deadlinePassed"
    | "sessionExpired"
    | "insufficientFunds"
    | "outOfStep"
    | "network"
    | "failed";
  reason: string;

  constructor(type: ArenaError["type"], reason: string) {
    super(reason);
    this.name = "ArenaError";
    this.type = type;
    this.reason = reason;
  }
}

// The schemas follow r/arena's query.gno and arena.gno, as gnovalue decodes their views.

const AddressSchema = v.pipe(v.string(), v.transform(address));
// "" where the realm names nobody.
const AddressOrNoneSchema = v.union([v.literal(""), AddressSchema]);
const MatchIdSchema = v.pipe(v.string(), v.transform(matchId));

const MatchSummarySchema = v.object({
  ID: MatchIdSchema,
  Phase: v.picklist(["open", "expired", "reveal", "play", "ended"]),
  Round: v.number(),
  Challenger: AddressSchema,
  Acceptor: AddressOrNoneSchema,
  ChallengerClan: v.string(),
  AcceptorClan: v.string(),
  ToMove: AddressOrNoneSchema,
  // Unix seconds.
  Deadline: v.number(),
  Result: v.string(),
  Reason: v.string(),
  Opponent: AddressOrNoneSchema,
});

const MatchViewSchema = v.object({
  ...MatchSummarySchema.entries,
  ChallengerDeck: v.string(),
  AcceptorDeck: v.string(),
  Plans: v.array(v.array(v.string())),
  Box: v.string(),
  HP: v.array(v.array(v.number())),
  DeadlinePassed: v.boolean(),
});

const OpenChallengeSchema = v.object({
  ID: MatchIdSchema,
  Challenger: AddressSchema,
  Clan: v.string(),
  Opponent: AddressOrNoneSchema,
  Posted: v.number(),
  Expires: v.number(),
});

const SessionLockSchema = v.object({ Session: AddressSchema, Match: MatchIdSchema, Expires: v.number() });

const ModeSchema = v.picklist(["session", "contract"]);

// returned is what a call returned, from its deliver_tx data, as the VM prints values.
const returned = (data: string | null) => (data === null ? "" : new TextDecoder().decode(fromBase64(data)));

export type MatchSummary = v.InferOutput<typeof MatchSummarySchema>;
export type MatchView = v.InferOutput<typeof MatchViewSchema>;
export type OpenChallenge = v.InferOutput<typeof OpenChallengeSchema>;
export type SessionLock = v.InferOutput<typeof SessionLockSchema>;
export type Phase = MatchSummary["Phase"];
// contract: the wallet signs each call that no live session locked to its match can sign.
export type Mode = v.InferOutput<typeof ModeSchema>;

export type Action = "accept" | "move" | "finish" | "claimForfeit" | "wait" | "done";

type Pair<T> = [T, T];

// A round resolved with the page's engine: both plans as card ids, challenger's first.
export type ResolvedRound = {
  plans: Pair<number[]>;
  events: BattleEvent[];
  state: GameState;
  result: Resolution["result"];
};
// The challenger's clash in the round being played, resolved from their opened box.
export type PendingClash = ResolvedRound & { round: number };

// A board challenge or a match summary, with what this player can do and its deadline.
export type Listed<T> = T & { action: Action; deadline: number };

// A match as its screen shows it. session is "expired" when this player must renew before
// acting; sessionExpires, in Unix seconds, is set when a session of theirs signs their next
// call. planning, set when the action is move, is what the plan is made from.
export type MatchDetail = Listed<MatchView> & {
  rounds: ResolvedRound[];
  state: GameState;
  pending: PendingClash | undefined;
  planning: LegalPlansRequest | undefined;
  session: "active" | "expired";
  sessionExpires?: number;
};

// state missing means this device is not authorized.
export type AccountState = {
  address: Address | null;
  state: "missing" | "active";
  mode: Mode;
  fallback: string | null;
};
export type Connection = AccountState | { state: "noWallet" | "wrongNetwork"; reason: string };

// The arena's notifications the page follows.
type FollowedEvent = "Turn" | "Ended" | "Board";

// A change subscribe reports: a notification at height about match, or none, when the
// arena may have changed in any way.
export type ArenaChange = { match?: undefined } | { match: MatchId; event: FollowedEvent; height: number };

// What the gnotif client hands the arena's handlers, by event.
export type NotifierEvents = {
  notification: { trigger: string; height: number; attrs: readonly { key: string; value: string }[] };
  reconnecting: undefined;
  reconnect: undefined;
  error: unknown;
};

// The gnotif client calls the arena makes.
export type Notifier = {
  enable(): Promise<unknown>;
  triggers(target: string): Promise<readonly { id: string; event: string; filter: string; param: string }[]>;
  setOptins(optins: { trigger: string; value: string; push?: false }[]): Promise<unknown>;
  on<K extends keyof NotifierEvents>(event: K, handler: (arg: NotifierEvents[K]) => void): () => void;
  connect(): Promise<unknown>;
  disconnect(): void;
  // enabled holds while this browser has a push subscription and notification permission.
  enabled(): Promise<boolean>;
};

export type Opening = { clan: string; deck: number[]; plan: number[] };

// ---- Turn logic, over views as gnovalue decodes them

// cardIDs maps comma-separated card names to the engine's card ids. A name the page's
// card file lacks means the page is out of step with the deployed engine.
export function cardIDs(text: string, cards: Card[]): number[] {
  return text.split(",").map((name) => {
    const card = cards.find((c) => c.name === name);
    if (card === undefined) throw new ArenaError("outOfStep", `This page does not know the card ${name}; reload it`);
    return card.id;
  });
}

export function cardNames(ids: number[], cards: Card[]): string {
  return ids.map((id) => cardOf(cards, id).name).join(",");
}

// A summary carries no DeadlinePassed; a board challenge is always open.
type Turn = (MatchSummary & { DeadlinePassed?: boolean | undefined }) | (OpenChallenge & { Phase: "open" });

// actionFor says what player me can do in a match. Without DeadlinePassed, the deadline is
// read against now, in Unix seconds. pending is the challenger's next clash, when known.
export function actionFor(view: Turn, me: Address | null, now: number, pending?: Pick<PendingClash, "result">): Action {
  switch (view.Phase) {
    case "open":
      if (me === view.Challenger) return "wait";
      return view.Opponent === "" || view.Opponent === me ? "accept" : "done";
    case "reveal":
    case "play": {
      const player = me === view.Challenger || me === view.Acceptor;
      if (view.DeadlinePassed ?? now > view.Deadline) return player && me !== view.ToMove ? "claimForfeit" : "done";
      if (me !== view.ToMove) return player ? "wait" : "done";
      if (view.Phase === "play") return "move";
      return view.Round === 3 || (pending !== undefined && pending.result !== "ongoing") ? "finish" : "move";
    }
    case "expired":
    case "ended":
      return "done";
  }
}

// replay plays every resolved round of view with the page's engine. HP that differ from
// the realm's mean the page's card file is out of step with the deployed engine.
export function replay(view: MatchView, engine: Engine): { rounds: ResolvedRound[]; state: GameState } {
  let state = startState(engine.hp);
  const rounds: ResolvedRound[] = [];
  view.HP.forEach((hp, r) => {
    const [a, b] = plansAt(view, r);
    const plans: Pair<number[]> = [cardIDs(a, engine.cards), cardIDs(b, engine.cards)];
    const outcome = resolve(engine, state, [view.ChallengerDeck, view.AcceptorDeck], plans);
    if (outcome.state.gnomes.some((g, side) => g.hp !== hp[side])) {
      throw new ArenaError("outOfStep", "This page's rules differ from the arena's; reload it");
    }
    rounds.push({ plans, events: outcome.events, state: outcome.state, result: outcome.result });
    state = outcome.state;
  });
  return { rounds, state };
}

// pendingClash resolves the round being played from the challenger's opened box and the
// acceptor's public plan, so the challenger watches it before planning the next round.
export function pendingClash(view: MatchView, opened: BoxContents, state: GameState, engine: Engine): PendingClash {
  const [, acceptorPlan] = plansAt(view, view.Round - 1);
  const plans: Pair<number[]> = [opened.plan, cardIDs(acceptorPlan, engine.cards)];
  const outcome = resolve(engine, state, [challengerDeck(view, opened, engine.cards), view.AcceptorDeck], plans);
  return { round: view.Round, plans, events: outcome.events, state: outcome.state, result: outcome.result };
}

// plansAt gives the two plan texts of the round at index r.
function plansAt(view: MatchView, r: number): Pair<string> {
  const [a, b] = view.Plans[r] ?? [];
  if (a === undefined || b === undefined) throw new ArenaError("failed", `The arena holds no plans for round ${r + 1}`);
  return [a, b];
}

// challengerDeck names the challenger's deck: from their round-1 box until its reveal.
function challengerDeck(view: MatchView, opened: BoxContents | undefined, cards: Card[]): string {
  return opened?.deck === undefined ? view.ChallengerDeck : cardNames(opened.deck, cards);
}

// planFrom says what the player who moves next plans from: the engine state their round
// starts in, their side and their deck, as card ids. The acceptor plans the round being
// played; the challenger plans the one after the pending clash, from the deck their box
// holds until its first reveal. Without the pending clash, which needs the box opened,
// there is nothing to plan from: undefined.
export function planFrom(
  view: MatchView,
  state: GameState,
  pending: Pick<PendingClash, "state"> | undefined,
  challengerDeck: string,
  cards: Card[],
): LegalPlansRequest | undefined {
  if (view.Phase === "play") return { state, side: 1, deck: cardIDs(view.AcceptorDeck, cards) };
  if (pending === undefined) return undefined;
  return { state: pending.state, side: 0, deck: cardIDs(challengerDeck, cards) };
}

// checkPlan throws illegalPlan unless the engine lists plan among the legal plans of
// planning, as planFrom gives it. A sealed plan the realm refuses at its reveal would
// lose the match, so nothing is sealed or sent before this check.
export function checkPlan(engine: Engine, planning: LegalPlansRequest, plan: number[]): void {
  const legal = engine.legalPlans(planning).some((p) => p.length === plan.length && p.every((id, i) => id === plan[i]));
  if (!legal) throw new ArenaError("illegalPlan", "That plan is not legal this round");
}

// checkOpening throws illegalPlan unless deck is legal for clan and plan legal for side
// in round 1.
export function checkOpening(engine: Engine, clan: string, deck: number[], plan: number[], side: Side): void {
  if (!engine.legalDeck({ clan, deck })) throw new ArenaError("illegalPlan", `That deck is not legal for ${clan}`);
  checkPlan(engine, { state: startState(engine.hp), side, deck }, plan);
}

// walletFailure turns a wallet's failed answer to a move into an ArenaError: the chain's
// reason when the transaction ran and failed, refused otherwise.
export function walletFailure(response: unknown): ArenaError {
  const reply = replyOf(response);
  const reason = nonEmpty(reply?.message) ?? nonEmpty(reply?.type) ?? "The wallet sent nothing";
  if (reply?.type === "TRANSACTION_FAILED") return errorFrom(new ChainError("failed", reason));
  return new ArenaError("refused", reason);
}

type Call = { func: string; args: string[] };
// The challenger's next plan: its text, and its seal and box.
type SealedPlan = { plan: string; seal: string; box: string };

// moveCall is the realm call for the move in view: Play for the acceptor; Reveal for the
// challenger, naming the opened box's cards, with the deck on the first reveal only, and
// the next plan's seal and box, or none when the match ends.
export function moveCall(view: MatchView, opened: null, next: { plan: string }, cards: Card[]): Call;
export function moveCall(view: MatchView, opened: BoxContents, next: SealedPlan | null, cards: Card[]): Call;
export function moveCall(
  view: MatchView,
  opened: BoxContents | null,
  next: { plan: string; seal?: string; box?: string } | null,
  cards: Card[],
): Call {
  if (view.Phase === "play") {
    if (next === null) throw new ArenaError("failed", `There is no plan to play in match ${view.ID}`);
    return { func: "Play", args: [view.ID, next.plan] };
  }
  if (opened === null) throw new ArenaError("failed", `There is no sealed plan to reveal in match ${view.ID}`);
  let deck = "";
  let deckSalt = "";
  if (view.ChallengerDeck === "") {
    if (opened.deck === undefined) throw new ArenaError("failed", "Your sealed box holds no deck to reveal");
    deck = cardNames(opened.deck, cards);
    deckSalt = opened.deckSalt;
  }
  return {
    func: "Reveal",
    args: [view.ID, deck, deckSalt, cardNames(opened.plan, cards), opened.planSalt, next?.seal ?? "", next?.box ?? ""],
  };
}

const realmErrors: [RegExp, ArenaError["type"]][] = [
  [/^(wrong phase|not your move|not a player|not your challenge|not the named opponent|unknown match)/, "wrongPhase"],
  [/^seal mismatch/, "sealMismatch"],
  [/^(illegal plan|illegal deck|unknown card|unknown clan)/, "illegalPlan"],
  [/^(deadline passed|challenge expired)/, "deadlinePassed"],
  [
    /^(unknown session|session expired|session spend limit|session has no spend limit|session locked)/,
    "sessionExpired",
  ],
  [/^insufficient (funds|fees)/, "insufficientFunds"],
];

// errorFrom turns a chain, wallet or other error into an ArenaError.
export function errorFrom(err: unknown): ArenaError {
  if (err instanceof ArenaError) return err;
  if (err instanceof WalletError) return new ArenaError(err.type === "box" ? "unauthorized" : err.type, err.reason);
  if (err instanceof ChainError) {
    if (err.type === "network") return new ArenaError("network", err.reason);
    const known = realmErrors.find(([pattern]) => pattern.test(err.reason));
    return new ArenaError(known === undefined ? "failed" : known[1], err.reason);
  }
  return new ArenaError("failed", messageOf(err));
}

// readParsed evaluates expr with readValue, a gnovalue reader, and parses its value; a value
// the reader cannot decode or its schema refuses fails, naming expr.
async function readParsed<T>(
  readValue: (expr: string) => Promise<unknown>,
  expr: string,
  schema: v.GenericSchema<unknown, T>,
): Promise<T> {
  let value: unknown;
  try {
    value = await readValue(expr);
  } catch (err) {
    if (err instanceof ChainError) throw errorFrom(err);
    throw new ArenaError("failed", `unexpected answer to ${expr}: ${messageOf(err)}`);
  }
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) throw new ArenaError("failed", `unexpected answer to ${expr}: ${v.summarize(parsed.issues)}`);
  return parsed.output;
}

// sessionLocks reads, with a gnovalue reader, the realm's locks on player's sessions: each
// names the one match its session may sign in.
export function sessionLocks(
  readValue: (expr: string) => Promise<unknown>,
  realm: string,
  player: Address,
): Promise<SessionLock[]> {
  return readParsed(readValue, `${realm}.Locks("${player}")`, v.array(SessionLockSchema));
}

function resolve(engine: Engine, state: GameState, decks: Pair<string>, [a, b]: Pair<number[]>): Resolution {
  try {
    return engine.resolve({ state, decks: [cardIDs(decks[0], engine.cards), cardIDs(decks[1], engine.cards)], a, b });
  } catch (err) {
    if (err instanceof ArenaError) throw err;
    throw new ArenaError("outOfStep", `This page's rules refuse a played round (${messageOf(err)}); reload it`);
  }
}

// ---- Live updates

type Optin = Parameters<Notifier["setOptins"]>[0][number];

// The param each followed event notifies by; none of the arena's triggers has a filter.
const followedParams: Record<FollowedEvent, string> = { Turn: "to", Ended: "to", Board: "" };
const followedEvents: readonly FollowedEvent[] = ["Turn", "Ended", "Board"];

// followedTriggers maps the id of each listed trigger the page follows to its event. A
// trigger is picked by event, filter and param, never by its place in the list.
function followedTriggers(
  triggers: readonly { id: string; event: string; filter: string; param: string }[],
): Map<string, FollowedEvent> {
  const picked = new Map<string, FollowedEvent>();
  for (const t of triggers) {
    const event = followedEvents.find((e) => e === t.event);
    if (event !== undefined && t.filter === "" && t.param === followedParams[event]) picked.set(t.id, event);
  }
  return picked;
}

// optinsFor is the set the page opts in to: the board, which only the open page hears; the
// turns and endings of pushed, whose player turned push on, which push carries too; and
// those of player, the connected wallet, which only the open page hears. gnotif keeps one
// set for both channels, so every set keeps pushed's items, or would turn its push off.
function optinsFor(picked: Map<string, FollowedEvent>, player: Address | null, pushed: Address | null): Optin[] {
  const board: Optin[] = [];
  const own: Optin[] = [];
  for (const [trigger, event] of picked) {
    if (event === "Board") {
      board.push({ trigger, value: "", push: false });
      continue;
    }
    if (pushed !== null) own.push({ trigger, value: pushed });
    if (player !== null && player !== pushed) own.push({ trigger, value: player, push: false });
  }
  return [...board, ...own];
}

// changeFrom is the change notification n reports, or null when picked holds none of its
// trigger or it names no match.
function changeFrom(picked: Map<string, FollowedEvent>, n: NotifierEvents["notification"]): ArenaChange | null {
  const event = picked.get(n.trigger);
  const match = n.attrs.find((a) => a.key === "match");
  if (event === undefined || match === undefined) return null;
  return { match: matchId(match.value), event, height: n.height };
}

// ---- The arena client

// The wallet calls the arena makes.
type ArenaWallet = Pick<
  Wallet,
  "AddEstablish" | "GetNetwork" | "SwitchNetwork" | "AddNetwork" | "GetAccount" | "SignArbitrary" | "DoContract"
>;

export type ArenaOptions = {
  chain: Pick<Chain, "evalJSON" | "typeJSON" | "sessions" | "gasPrice" | "simulate" | "broadcast">;
  // Adena itself, devWallet, or nothing when the browser has no wallet; a promise of one
  // while the page is still looking for it.
  wallet: ArenaWallet | null | undefined | Promise<ArenaWallet | null | undefined>;
  engine: Engine;
  signer: Pick<Signer, "keyInfo" | "signTx">;
  realm: string;
  chainId: string;
  // The site the root signature's text names.
  origin: string;
  // Keeps the root signature and the signing mode per wallet, and the address push is on for
  // per chain, like localStorage.
  storage: Pick<Storage, "getItem" | "setItem">;
  // The gnotif client: subscribe follows the chain through its live connection, and notify
  // turns on its push.
  notifier?: Notifier | undefined;
  // false keeps push off for a notifier the build did not choose: notify fails, and the
  // feed's opt-ins turn no push on.
  offerPush?: boolean;
  // Lets connect add chainId to a wallet that does not know it.
  network?: { chainName: string; rpcUrl: string } | undefined;
  // Skips sessions: the wallet signs every move.
  signEachMove?: boolean;
  // How long each new session lasts, in seconds.
  sessionLifetime?: number;
  // Unix seconds.
  now?: () => number;
};

export type Arena = {
  // true while the page is still looking for a wallet, since connect waits for it.
  hasWallet: boolean;
  // Settles when the page's search for a wallet ends, whatever it found.
  walletSearch: Promise<void>;
  // false without a notifier or with offerPush false, so notify can only fail.
  canNotify: boolean;
  // connect returns the account's state, or the reason no wallet connected on the network.
  connect(): Promise<Connection>;
  // authorize gets the root signature, once per device, and returns the account's state.
  authorize(): Promise<AccountState>;
  // account returns the account's state as connect gives it, without asking the wallet; in
  // the contract mode, fallback holds the reason.
  account(): AccountState;
  // resumeSessions leaves the per-move mode, so the next challenge, acceptance or renewal
  // asks the wallet for a session again, and returns the account's state.
  resumeSessions(): AccountState;
  // renew asks the wallet for a session for this player's side of match id, revoking
  // the dead ones, unless a live unlocked one has the budget. It sends no move: the next
  // one locks the session to the match.
  renew(id: MatchId): Promise<void>;
  openChallenges(page?: number): Promise<Listed<OpenChallenge>[]>;
  myMatches(page?: number): Promise<Listed<MatchSummary>[]>;
  match(id: MatchId): Promise<MatchDetail>;
  // challenge posts a challenge with card ids for the deck and round-1 plan, open to
  // anyone or reserved for opponent's address, and returns the new match's id, or "" from
  // an Adena that answers before the call's block. Like accept, it signs with a session
  // prepareSession gives, which the call locks.
  challenge(opening: Opening & { opponent?: string }): Promise<MatchId>;
  accept(id: MatchId, opening: Opening): Promise<void>;
  // move sends this player's plan, as card ids, for the round being played.
  move(id: MatchId, plan: number[]): Promise<void>;
  // finish sends the challenger's last reveal, after round 3 or a knockout.
  finish(id: MatchId): Promise<void>;
  // These end the match, so with no live session for it, or no root signature to derive
  // one, the wallet signs them. A claimer's session always ends before the deadline it claims.
  resign(id: MatchId): Promise<void>;
  claimForfeit(id: MatchId): Promise<void>;
  // subscribe calls onChange when the arena may have changed, and returns a function that
  // stops it. Through the notifier, each notification the page follows is a change, and so
  // is each time the live connection opens, since the stream replays nothing it sent while
  // none was open. While the arena's triggers cannot be followed, or the connection is
  // down, a change comes every interval ms the page is visible.
  subscribe(onChange: (change: ArenaChange) => void, options?: { interval?: number }): () => void;
  // watch calls onChange(view) whenever match id changes, or onChange(null, error) when
  // a read fails; subscribe says when to read it again, and so does the expiry of the
  // session that signs this player's next call there. It returns a function that stops it.
  watch(
    id: MatchId,
    onChange: (view: MatchDetail | null, error?: ArenaError) => void | Promise<void>,
    options?: { interval?: number },
  ): () => void;
  // notify asks the browser for permission and opts it in to the arena's Turn and Ended
  // notifications for this wallet by push, and returns how many it opted in to. Call it
  // from a click.
  notify(): Promise<number>;
  // notifying holds when push is on for the connected wallet and this browser still has its
  // subscription; false before a wallet connects.
  notifying(): Promise<boolean>;
};

// What this page keeps per wallet: the root signature, the signing mode and its fallback's reason.
type Stored = "root" | "mode" | "fallback";

// What prepareSession and sessionIn read: this player's sessions on the chain and their
// locks in the realm, every generation's keys, and the gas price, which sets what a move costs.
type Owned = { onChain: Session[]; keys: Map<number, SessionKeys>; locks: SessionLock[]; price: GasPrice };

// createArena reads and plays the arena at realm on chainId.
export function createArena({
  chain,
  wallet,
  engine,
  signer,
  realm,
  chainId,
  origin,
  storage,
  notifier,
  offerPush = true,
  network,
  signEachMove = false,
  sessionLifetime = defaultLifetime,
  now = () => Math.floor(Date.now() / 1000),
}: ArenaOptions): Arena {
  let address: Address | null = null;
  let current = wallet;
  if (current instanceof Promise)
    void current.then((found) => {
      current = found;
    });
  const readValue = createReader(chain);
  const keyCache = new Map<string, Promise<SessionKeys>>();

  const storageKey = (name: Stored) => `gnomepit:${chainId}:${address}:${name}`;
  const stored = (name: Stored) => storage.getItem(storageKey(name));
  const store = (name: Stored, value: string) => storage.setItem(storageKey(name), value);
  // The address whose player last turned push on in this browser, whatever wallet is connected.
  const pushKey = `gnomepit:${chainId}:push`;
  function pushed(): Address | null {
    if (!offerPush) return null;
    const stored = storage.getItem(pushKey);
    return stored === null ? null : v.parse(AddressSchema, stored);
  }
  // A stored mode this page does not know reads as session.
  function mode(): Mode {
    if (signEachMove) return "contract";
    const parsed = v.safeParse(ModeSchema, stored("mode"));
    return parsed.success ? parsed.output : "session";
  }

  function requireAddress(): Address {
    if (address === null) throw new ArenaError("noWallet", "Connect a wallet first");
    return address;
  }

  function signingWallet(): ArenaWallet {
    if (current === null || current === undefined || current instanceof Promise)
      throw new ArenaError("noWallet", "Connect a wallet first");
    return current;
  }

  function keysFor(generation: number): Promise<SessionKeys> {
    const root = stored("root");
    if (root === null) throw new ArenaError("unauthorized", "Authorize this device first");
    const cacheKey = `${root}/${generation}`;
    let keys = keyCache.get(cacheKey);
    if (keys === undefined) {
      keys = deriveKeys(root, generation, signer);
      keyCache.set(cacheKey, keys);
    }
    return keys;
  }
  const boxKey = async () => (await keysFor(0)).boxKey;

  const read = <T>(expr: string, schema: v.GenericSchema<unknown, T>) => readParsed(readValue, expr, schema);

  const readMatch = (id: MatchId) => read(`${realm}.Match("${id}")`, MatchViewSchema);
  const roleOf = (view: MatchSummary): Role | undefined =>
    view.Challenger === address ? "challenger" : view.Acceptor === address ? "acceptor" : undefined;
  const left = (session: Session) => session.spendLimit - session.spendUsed;

  function status(): AccountState {
    const fallback = stored("fallback");
    return {
      address,
      state: stored("root") === null ? "missing" : "active",
      mode: mode(),
      fallback: fallback === "" ? null : fallback,
    };
  }

  // fallBack switches to the per-move mode for reason, and returns null: no session.
  function fallBack(reason: string): null {
    store("mode", "contract");
    store("fallback", reason);
    return null;
  }

  async function ownSessions(): Promise<Owned> {
    const me = requireAddress();
    const keys = new Map<number, SessionKeys>();
    for (let generation = 0; generation < generations; generation++) keys.set(generation, await keysFor(generation));
    return {
      onChain: await chain.sessions(me),
      keys,
      locks: await sessionLocks(readValue, realm, me),
      price: await chain.gasPrice(),
    };
  }
  const classify = ({ price, ...found }: Owned, matches: Map<MatchId, LockedMatch>): SortedSessions =>
    classifySessions({ ...found, matches, now: now(), realm, reserve: sessionReserve(price) });

  // prepareSession returns a live unlocked session with role's budget, else has the wallet
  // revoke the dead ones and create one, and throws refused when the player rejects that.
  // It returns null in the per-move mode, its fallback.
  async function prepareSession(role: Role): Promise<SessionEntry | null> {
    if (mode() === "contract") return null;
    const me = requireAddress();
    const found = await ownSessions();
    const matches = new Map<MatchId, LockedMatch>();
    for (const id of lockedMatches({ ...found, now: now() })) {
      try {
        const view = await readMatch(id);
        const side = roleOf(view);
        if (side !== undefined) matches.set(id, { phase: view.Phase, role: side });
      } catch (err) {
        if (!(err instanceof ArenaError) || err.reason !== "unknown match") throw err;
      }
    }
    const { unlocked, dead, free } = classify(found, matches);
    const budget = sessionBudget(role, found.price);
    const reusable = unlocked.find(({ session }) => left(session) >= budget);
    if (reusable !== undefined) return reusable;
    const target = free[0] ?? dead[0];
    if (target === undefined) return fallBack("Every session this account can hold is used");
    const start = now();
    const messages: Message[] = [
      ...dead.map(({ keys }) => revokeMessage(me, keys.sessionPubKey)),
      sessionMessage(me, target.keys.sessionPubKey, start, realm, budget, sessionLifetime),
    ];
    const gasWanted = sessionGas * messages.length;
    const reply = replyOf(
      await signingWallet().DoContract({
        messages,
        memo: "Gnomepit session",
        gasWanted,
        gasFee: feeFor(gasWanted, found.price),
        commit: true,
      }),
    );
    // Adena's answer when the player rejects the approval or closes its window.
    if (reply?.type === "TRANSACTION_REJECTED")
      throw new ArenaError("refused", nonEmpty(reply.message) ?? "The session was not approved");
    if (reply?.status !== "success")
      return fallBack(nonEmpty(reply?.message) ?? nonEmpty(reply?.type) ?? "The wallet created no session");
    // A read served before the approval's block applies may still show the revoked session.
    const created = (s: Session) => s.address === target.keys.sessionAddress && s.expiresAt === start + sessionLifetime;
    const session = (await chain.sessions(me)).find(created);
    if (session === undefined) throw new ArenaError("failed", "The new session is not on the chain yet; try again");
    return { ...target, session };
  }

  // sessionIn returns the session that signs this player's next call in match id, which
  // view shows: the live session locked to it, else, outside the per-move mode, a live
  // unlocked one, such as a renewal leaves, which that call locks. It returns null when
  // there is none.
  async function sessionIn(id: MatchId, view: MatchView): Promise<SessionEntry | null> {
    const role = roleOf(view);
    if (role === undefined) return null;
    const found = await ownSessions();
    // Only this match is read: sessions locked elsewhere then count as dead, unused here.
    const { byMatch, unlocked } = classify(found, new Map([[id, { phase: view.Phase, role }]]));
    if (byMatch.has(id) || mode() === "contract") return byMatch.get(id) ?? null;
    return unlocked.find(({ session }) => left(session) >= sessionReserve(found.price).opening[role]) ?? null;
  }

  // signingIn is sessionIn for a move, which without a session needs a renewal, or the
  // wallet in the per-move mode.
  async function signingIn(id: MatchId, view: MatchView): Promise<SessionEntry | null> {
    const found = await sessionIn(id, view);
    if (found === null && mode() !== "contract")
      throw new ArenaError("sessionExpired", `The session for match ${id} has expired or run out; renew it`);
    return found;
  }

  const endingSession = async (id: MatchId) => (stored("root") === null ? null : sessionIn(id, await readMatch(id)));

  // sessionState gives session, "expired" when this player must renew before acting in match
  // id and "active" otherwise, always in the per-move mode, and sessionExpires, the expiry of
  // the session that signs their next call there, when there is one.
  async function sessionState(
    id: MatchId,
    view: MatchView,
  ): Promise<{ session: "active" | "expired"; sessionExpires?: number }> {
    if (mode() === "contract" || stored("root") === null || roleOf(view) === undefined || view.Phase === "ended")
      return { session: "active" };
    const found = await sessionIn(id, view);
    return found === null ? { session: "expired" } : { session: "active", sessionExpires: found.session.expiresAt };
  }

  // serial runs task once every task before it has settled. Calls go out one at a time,
  // so each signs with the sequence the previous one's block left, and no call takes the
  // session prepared for another.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const done = queue.then(task);
    queue = done.catch(() => {});
    return done;
  }

  // send makes one arena call, signed by the session signing resolves to, or by the
  // wallet itself when it resolves to null or the arena signs each move. It returns what
  // the call returned, or "" from an Adena that answers before the call's block.
  const send = (func: string, args: string[], signing: () => Promise<SessionEntry | null>) =>
    serial(() => sendNow(func, args, signing));

  async function sendNow(func: string, args: string[], signing: () => Promise<SessionEntry | null>): Promise<string> {
    const me = requireAddress();
    const msg = {
      type: "/vm.m_call",
      value: { caller: me, send: "", max_deposit: "", pkg_path: realm, func, args },
    };
    try {
      const signedBy = signEachMove ? null : await signing();
      if (signedBy === null) {
        const response = await signingWallet().DoContract({ messages: [msg], memo: "", commit: true });
        const reply = replyOf(response);
        if (reply?.status !== "success") throw walletFailure(response);
        const landed = v.safeParse(CommittedSchema, reply.data);
        return landed.success ? returned(landed.output.deliver_tx.ResponseBase.Data) : "";
      }
      const { keys, session } = signedBy;
      const request = {
        chainId,
        accountNumber: session.accountNumber,
        sequence: session.sequence,
        privKey: keys.sessionKey,
        sessionAddr: keys.sessionAddress,
        memo: "",
        msgs: [msg],
      };
      return returned((await chain.broadcast(await payFor(chain, (fee) => signer.signTx({ ...request, fee })))).data);
    } catch (err) {
      throw errorFrom(err);
    }
  }

  function checkID(id: MatchId): void {
    if (!/^\d{1,10}$/.test(id)) throw new ArenaError("wrongPhase", `No match ${id}`);
  }

  // A subscriber of the live feed; poll(true) has it poll the node until poll(false).
  type Listener = { onChange: (change: ArenaChange) => void; poll(on: boolean): void };
  // The live feed, one connection that every subscriber shares while any is subscribed. It
  // is opening until the server accepts its opt-ins, live after, and down while it polls.
  type Feed = {
    listeners: Set<Listener>;
    picked: Map<string, FollowedEvent>;
    state: "opening" | "live" | "down";
    down(): void;
    stop(): void;
  };
  let feed: Feed | null = null;

  function startFeed(n: Notifier): Feed {
    let stopped = false;
    const f: Feed = {
      listeners: new Set(),
      picked: new Map(),
      state: "opening",
      down() {
        f.state = "down";
        for (const l of f.listeners) l.poll(true);
      },
      stop() {
        stopped = true;
        for (const off of offs) off();
        n.disconnect();
      },
    };
    const up = () => {
      f.state = "live";
      for (const l of f.listeners) {
        l.poll(false);
        l.onChange({});
      }
    };
    const offs = [
      n.on("notification", (note) => {
        const change = changeFrom(f.picked, note);
        if (change !== null) for (const l of f.listeners) l.onChange(change);
      }),
      n.on("reconnecting", () => f.down()),
      n.on("reconnect", up),
      n.on("error", () => f.down()),
    ];
    void (async () => {
      try {
        f.picked = followedTriggers(await n.triggers(realm));
        // disconnect() does nothing before connect(), so a feed stopped by now must not connect.
        if (stopped) return;
        if (f.picked.size > 0) {
          // A push subscription the server forgot refuses the set; connect() still sends it live.
          await n.setOptins(optinsFor(f.picked, address, pushed())).catch(() => {});
          if (stopped) return;
          await n.connect();
        }
      } catch {
        // A server that cannot be followed leaves the node to poll, as no server does.
        f.picked = new Map();
      }
      if (stopped) return;
      if (f.picked.size > 0) up();
      else f.down();
    })();
    return f;
  }

  // followAddress sets the live feed's opt-ins again for the connected address.
  function followAddress(): void {
    const f = feed;
    if (notifier === undefined || f === null || f.picked.size === 0) return;
    // A push subscription the server forgot makes every set reject until notify(); the live
    // connection takes each set all the same.
    void notifier.setOptins(optinsFor(f.picked, address, pushed())).catch(() => {});
  }

  const arena: Arena = {
    get hasWallet() {
      return current instanceof Promise || (current !== null && current !== undefined);
    },
    walletSearch:
      wallet instanceof Promise
        ? wallet.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve(),
    canNotify: notifier !== undefined && offerPush,

    async connect() {
      try {
        ({ address } = await connectWallet(await current, chainId, network));
        followAddress();
      } catch (err) {
        if (err instanceof WalletError && (err.type === "noWallet" || err.type === "wrongNetwork")) {
          return { state: err.type, reason: err.reason };
        }
        throw errorFrom(err);
      }
      return status();
    },

    async authorize() {
      const me = requireAddress();
      try {
        if (stored("root") === null) store("root", await rootSignature(signingWallet(), me, origin));
      } catch (err) {
        throw errorFrom(err);
      }
      return status();
    },

    account: status,

    resumeSessions() {
      requireAddress();
      store("mode", "session");
      store("fallback", "");
      return status();
    },

    async renew(id) {
      checkID(id);
      requireAddress();
      const role = roleOf(await readMatch(id));
      if (role === undefined) throw new ArenaError("wrongPhase", `You do not play in match ${id}`);
      try {
        await serial(() => prepareSession(role));
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async openChallenges(page = 0) {
      const list = await read(`${realm}.Open(${page * pageSize}, ${pageSize})`, v.array(OpenChallengeSchema));
      return list.map((c) => ({
        ...c,
        action: actionFor({ ...c, Phase: "open" }, address, now()),
        deadline: c.Expires,
      }));
    },

    async myMatches(page = 0) {
      const me = requireAddress();
      const list = await read(
        `${realm}.Matches("${me}", ${page * pageSize}, ${pageSize})`,
        v.array(MatchSummarySchema),
      );
      return list.map((s) => ({ ...s, action: actionFor(s, me, now()), deadline: s.Deadline }));
    },

    async match(id) {
      checkID(id);
      try {
        const view = await readMatch(id);
        const { rounds, state } = replay(view, engine);
        let pending: PendingClash | undefined;
        let opened: BoxContents | undefined;
        if (view.Phase === "reveal" && view.ToMove === address && view.Box !== "" && stored("root") !== null) {
          opened = await openBox(await boxKey(), view.Box);
          pending = pendingClash(view, opened, state, engine);
        }
        const action = actionFor(view, address, now(), pending);
        const planning =
          action === "move"
            ? planFrom(view, state, pending, challengerDeck(view, opened, engine.cards), engine.cards)
            : undefined;
        return {
          ...view,
          rounds,
          state,
          pending,
          planning,
          action,
          ...(await sessionState(id, view)),
          deadline: view.Deadline,
        };
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async challenge({ clan, deck, plan, opponent = "" }) {
      requireAddress();
      checkOpening(engine, clan, deck, plan, 0);
      const key = await boxKey();
      const sealed = { deck: [...deck].sort((a, b) => a - b), deckSalt: newSalt(), plan, planSalt: newSalt() };
      const deckSeal = await sealOf(sealed.deckSalt, cardNames(sealed.deck, engine.cards));
      const planSeal = await sealOf(sealed.planSalt, cardNames(plan, engine.cards));
      const result = await send("Challenge", [clan, deckSeal, planSeal, await sealBox(key, sealed), opponent], () =>
        prepareSession("challenger"),
      );
      return matchId(/^\("(\d+)" string\)/.exec(result)?.[1] ?? "");
    },

    async accept(id, { clan, deck, plan }) {
      checkID(id);
      checkOpening(engine, clan, deck, plan, 1);
      await send("Accept", [id, clan, cardNames(deck, engine.cards), cardNames(plan, engine.cards)], () =>
        prepareSession("acceptor"),
      );
    },

    async move(id, plan) {
      const view = await arena.match(id);
      if (view.action !== "move") throw new ArenaError("wrongPhase", `There is no move to make in match ${id}`);
      if (view.planning === undefined)
        throw new ArenaError("unauthorized", "Authorize this device to open your sealed plan");
      checkPlan(engine, view.planning, plan);
      const planText = cardNames(plan, engine.cards);
      try {
        if (view.Phase === "play") {
          const { func, args } = moveCall(view, null, { plan: planText }, engine.cards);
          await send(func, args, () => signingIn(id, view));
          return;
        }
        const key = await boxKey();
        const planSalt = newSalt();
        const next = {
          plan: planText,
          seal: await sealOf(planSalt, planText),
          box: await sealBox(key, { plan, planSalt }),
        };
        const { func, args } = moveCall(view, await openBox(key, view.Box), next, engine.cards);
        await send(func, args, () => signingIn(id, view));
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async finish(id) {
      const view = await arena.match(id);
      if (view.action !== "finish") throw new ArenaError("wrongPhase", `Match ${id} has no reveal to finish`);
      try {
        const { func, args } = moveCall(view, await openBox(await boxKey(), view.Box), null, engine.cards);
        await send(func, args, () => signingIn(id, view));
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async resign(id) {
      checkID(id);
      await send("Resign", [id], () => endingSession(id));
    },

    async claimForfeit(id) {
      checkID(id);
      await send("ClaimForfeit", [id], () => endingSession(id));
    },

    subscribe(onChange, { interval = 4000 } = {}) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = () => {
        if (globalThis.document?.visibilityState !== "hidden") onChange({});
        timer = setTimeout(poll, interval);
      };
      const listener: Listener = {
        onChange,
        poll(on) {
          if (on) {
            if (timer === undefined) timer = setTimeout(poll, interval);
            return;
          }
          clearTimeout(timer);
          timer = undefined;
        },
      };
      if (notifier === undefined) {
        listener.poll(true);
        return () => listener.poll(false);
      }
      if (feed === null) feed = startFeed(notifier);
      const f = feed;
      f.listeners.add(listener);
      if (f.state === "down") listener.poll(true);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listener.poll(false);
        f.listeners.delete(listener);
        if (f.listeners.size > 0) return;
        f.stop();
        if (feed === f) feed = null;
      };
    },

    watch(id, onChange, { interval = 4000 } = {}) {
      let last = "";
      let stopped = false;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      let reading = Promise.resolve();
      // tell hands onChange its news. A listener that throws is reported the way the page
      // reports a throwing event listener, so the reads after it still run.
      const tell = async (view: MatchDetail | null, error?: ArenaError) => {
        try {
          await onChange(view, error);
        } catch (e) {
          reportError(e);
        }
      };
      const read = () => {
        reading = reading.then(async () => {
          if (stopped) return;
          try {
            const view = await arena.match(id);
            clearTimeout(expiry);
            if (view.sessionExpires !== undefined && view.sessionExpires > 0)
              expiry = setTimeout(read, Math.min((view.sessionExpires - now()) * 1000, longestTimer));
            const seen = JSON.stringify([
              view.Phase,
              view.Round,
              view.ToMove,
              view.Plans,
              view.HP,
              view.Result,
              view.DeadlinePassed,
              view.session,
            ]);
            if (seen !== last && !stopped) {
              last = seen;
              void tell(view);
            }
          } catch (err) {
            if (!stopped) void tell(null, errorFrom(err));
          }
        });
      };
      const unsubscribe = arena.subscribe(
        (change) => {
          if (change.match === undefined || change.match === id) read();
        },
        { interval },
      );
      read();
      return () => {
        stopped = true;
        clearTimeout(expiry);
        unsubscribe();
      };
    },

    async notify() {
      const me = requireAddress();
      if (notifier === undefined || !offerPush) {
        throw new ArenaError("failed", "Notifications are not set up for this network");
      }
      // enable runs first, within the click's gesture. It also registers the browser again
      // when the server forgot its subscription, which refuses any set until then.
      await notifier.enable();
      const picked =
        feed !== null && feed.picked.size > 0 ? feed.picked : followedTriggers(await notifier.triggers(realm));
      storage.setItem(pushKey, me);
      await notifier.setOptins(optinsFor(picked, address, me));
      return [...picked.values()].filter((event) => event !== "Board").length;
    },

    async notifying() {
      if (notifier === undefined || address === null || pushed() !== address) return false;
      return notifier.enabled();
    },
  };
  return arena;
}
