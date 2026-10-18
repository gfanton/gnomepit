// Everything the lobby and the match screens need from the arena realm: the account's
// state, the board, a player's matches, one match with what this player can do now, and
// every move. Seals, salts, boxes and reveals stay inside: a challenger's move opens the
// sealed plan, reveals it and seals the next one in one call.

import { ChainError, feeFor, payFor } from "./chain.ts";
import { createReader } from "./gnovalue.mjs";
import {
  WalletError,
  classifySessions,
  connect as connectWallet,
  deriveKeys,
  generations,
  lockedMatches,
  newSalt,
  openBox,
  revokeMessage,
  rootSignature,
  sealBox,
  sealOf,
  sessionBudget,
  sessionGas,
  sessionLifetime as defaultLifetime,
  sessionMessage,
  sessionReserve,
} from "./wallet.mjs";

const pageSize = 50; // the realm's maxPage
// ms; setTimeout runs a longer delay at once.
const longestTimer = 2 ** 31 - 1;

// ArenaError's type is one of: noWallet, wrongNetwork, refused, unauthorized, wrongPhase,
// sealMismatch, illegalPlan, deadlinePassed, sessionExpired, insufficientFunds,
// outOfStep, network, failed. reason is readable text.
export class ArenaError extends Error {
  constructor(type, reason) {
    super(reason);
    this.name = "ArenaError";
    this.type = type;
    this.reason = reason;
  }
}

// ---- Turn logic, over views as gnovalue decodes them

// cardIDs maps comma-separated card names to the engine's card ids. A name the page's
// card file lacks means the page is out of step with the deployed engine.
export function cardIDs(text, cards) {
  return text.split(",").map((name) => {
    const card = cards.find((c) => c.name === name);
    if (card === undefined) throw new ArenaError("outOfStep", `This page does not know the card ${name}; reload it`);
    return card.id;
  });
}

export function cardNames(ids, cards) {
  return ids.map((id) => cards[id].name).join(",");
}

// actionFor says what player me can do in a match: accept, move, finish, claimForfeit,
// wait or done. A summary carries no DeadlinePassed, so its deadline is read against now,
// in Unix seconds. pending is the challenger's next clash, when known.
export function actionFor(view, me, now, pending) {
  const player = me === view.Challenger || me === view.Acceptor;
  switch (view.Phase) {
    case "open":
      if (me === view.Challenger) return "wait";
      return view.Opponent === "" || view.Opponent === me ? "accept" : "done";
    case "reveal":
    case "play": {
      if (view.DeadlinePassed ?? now > view.Deadline) return player && me !== view.ToMove ? "claimForfeit" : "done";
      if (me !== view.ToMove) return player ? "wait" : "done";
      if (view.Phase === "play") return "move";
      return view.Round === 3 || (pending !== undefined && pending.result !== "ongoing") ? "finish" : "move";
    }
  }
  return "done";
}

// replay plays every resolved round of view with the page's engine. HP that differ from
// the realm's mean the page's card file is out of step with the deployed engine.
export function replay(view, engine) {
  let state = startState(engine.hp);
  const rounds = [];
  view.HP.forEach((hp, r) => {
    const [a, b] = view.Plans[r];
    const plans = [cardIDs(a, engine.cards), cardIDs(b, engine.cards)];
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
export function pendingClash(view, opened, state, engine) {
  const plans = [opened.plan, cardIDs(view.Plans[view.Round - 1][1], engine.cards)];
  const outcome = resolve(engine, state, [challengerDeck(view, opened, engine.cards), view.AcceptorDeck], plans);
  return { round: view.Round, plans, events: outcome.events, state: outcome.state, result: outcome.result };
}

// challengerDeck names the challenger's deck: from their round-1 box until its reveal.
function challengerDeck(view, opened, cards) {
  return opened?.deck === undefined ? view.ChallengerDeck : cardNames(opened.deck, cards);
}

// planFrom says what the player who moves next plans from: the engine state their round
// starts in, their side and their deck, as card ids. The acceptor plans the round being
// played; the challenger plans the one after the pending clash, from the deck their box
// holds until its first reveal. Without the pending clash, which needs the box opened,
// there is nothing to plan from: undefined.
export function planFrom(view, state, pending, challengerDeck, cards) {
  if (view.Phase === "play") return { state, side: 1, deck: cardIDs(view.AcceptorDeck, cards) };
  if (pending === undefined) return undefined;
  return { state: pending.state, side: 0, deck: cardIDs(challengerDeck, cards) };
}

// checkPlan throws illegalPlan unless the engine lists plan among the legal plans of
// planning, as planFrom gives it. A sealed plan the realm refuses at its reveal would
// lose the match, so nothing is sealed or sent before this check.
export function checkPlan(engine, planning, plan) {
  const legal = engine.legalPlans(planning).some((p) => p.length === plan.length && p.every((id, i) => id === plan[i]));
  if (!legal) throw new ArenaError("illegalPlan", "That plan is not legal this round");
}

// checkOpening throws illegalPlan unless deck is legal for clan and plan legal for side
// in round 1.
export function checkOpening(engine, clan, deck, plan, side) {
  if (!engine.legalDeck({ clan, deck })) throw new ArenaError("illegalPlan", `That deck is not legal for ${clan}`);
  checkPlan(engine, { state: startState(engine.hp), side, deck }, plan);
}

// walletFailure turns a wallet's failed answer to a move into an ArenaError: the chain's
// reason when the transaction ran and failed, refused otherwise.
export function walletFailure(response) {
  const reason = response?.message || response?.type || "The wallet sent nothing";
  if (response?.type === "TRANSACTION_FAILED") return errorFrom(new ChainError("failed", reason));
  return new ArenaError("refused", reason);
}

// moveCall is the realm call for the move in view: Play for the acceptor; Reveal for the
// challenger, naming the opened box's cards, with the deck on the first reveal only, and
// the next plan's seal and box, or none when the match ends.
export function moveCall(view, opened, next, cards) {
  if (view.Phase === "play") return { func: "Play", args: [view.ID, next.plan] };
  const first = view.ChallengerDeck === "";
  return {
    func: "Reveal",
    args: [
      view.ID,
      first ? cardNames(opened.deck, cards) : "",
      first ? opened.deckSalt : "",
      cardNames(opened.plan, cards),
      opened.planSalt,
      next?.seal ?? "",
      next?.box ?? "",
    ],
  };
}

const realmErrors = [
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
export function errorFrom(err) {
  if (err instanceof ArenaError) return err;
  if (err instanceof WalletError) return new ArenaError(err.type === "box" ? "unauthorized" : err.type, err.reason);
  if (err instanceof ChainError) {
    if (err.type === "network") return new ArenaError("network", err.reason);
    const known = realmErrors.find(([pattern]) => pattern.test(err.reason));
    return new ArenaError(known === undefined ? "failed" : known[1], err.reason);
  }
  return new ArenaError("failed", err instanceof Error ? err.message : String(err));
}

function startState(hp) {
  return { round: 1, gnomes: [0, 1].map(() => ({ hp, vulnerable: 0, strength: 0, spent: [] })) };
}

function resolve(engine, state, decks, [a, b]) {
  try {
    return engine.resolve({ state, decks: decks.map((d) => cardIDs(d, engine.cards)), a, b });
  } catch (err) {
    if (err instanceof ArenaError) throw err;
    throw new ArenaError("outOfStep", `This page's rules refuse a played round (${err.message}); reload it`);
  }
}

// ---- The arena client

// createArena reads and plays the arena at realm on chainId. wallet answers Adena's
// calls (Adena itself, or devWallet); engine is the loaded engine and signer is
// signer.mjs; storage keeps the root signature and the signing mode per wallet, like
// localStorage; notifier is a gnotif client. origin names the site in the root
// signature's text. signEachMove skips sessions: the wallet signs every move.
// sessionLifetime is how long each new session lasts, in seconds. network, {chainName,
// rpcUrl}, lets connect add chainId to a wallet that does not know it.
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
  indexer,
  network,
  signEachMove = false,
  sessionLifetime = defaultLifetime,
  now = () => Math.floor(Date.now() / 1000),
}) {
  let address = null;
  const readValue = createReader(chain);
  const keyCache = new Map();

  const storageKey = (name) => `gnomehall:${chainId}:${address}:${name}`;
  const stored = (name) => storage.getItem(storageKey(name));
  const store = (name, value) => storage.setItem(storageKey(name), value);
  const mode = () => (signEachMove ? "contract" : (stored("mode") ?? "session"));

  function requireAddress() {
    if (address === null) throw new ArenaError("noWallet", "Connect a wallet first");
  }

  function keysFor(generation) {
    const root = stored("root");
    if (root === null) throw new ArenaError("unauthorized", "Authorize this device first");
    const cacheKey = `${root}/${generation}`;
    if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, deriveKeys(root, generation, signer));
    return keyCache.get(cacheKey);
  }
  const boxKey = async () => (await keysFor(0)).boxKey;

  async function read(expr) {
    try {
      return await readValue(expr);
    } catch (err) {
      throw errorFrom(err);
    }
  }

  const readMatch = (id) => read(`${realm}.Match("${id}")`);
  const roleOf = (view) =>
    view.Challenger === address ? "challenger" : view.Acceptor === address ? "acceptor" : undefined;
  const left = (session) => session.spendLimit - session.spendUsed;

  function status() {
    return {
      address,
      state: stored("root") === null ? "missing" : "active",
      mode: mode(),
      fallback: stored("fallback") || null,
    };
  }

  // fallBack switches to the per-move mode for reason, and returns null: no session.
  function fallBack(reason) {
    store("mode", "contract");
    store("fallback", reason);
    return null;
  }

  // ownSessions reads this player's sessions on the chain and their locks in the realm,
  // with every generation's keys and the chain's gas price, which sets what a move costs.
  async function ownSessions() {
    const keys = new Map();
    for (let generation = 0; generation < generations; generation++) keys.set(generation, await keysFor(generation));
    return {
      onChain: await chain.sessions(address),
      keys,
      locks: await read(`${realm}.Locks("${address}")`),
      price: await chain.gasPrice(),
    };
  }
  const classify = ({ price, ...found }, matches) =>
    classifySessions({ ...found, matches, now: now(), realm, reserve: sessionReserve(price) });

  // prepareSession returns a live unlocked session with role's budget, else has the wallet
  // revoke the dead ones and create one, and throws refused when the player rejects that.
  // It returns null in the per-move mode, its fallback.
  async function prepareSession(role) {
    if (mode() === "contract") return null;
    const found = await ownSessions();
    const matches = new Map();
    for (const id of lockedMatches({ ...found, now: now() })) {
      try {
        const view = await readMatch(id);
        matches.set(id, { phase: view.Phase, role: roleOf(view) });
      } catch (err) {
        if (err.reason !== "unknown match") throw err;
      }
    }
    const { unlocked, dead, free } = classify(found, matches);
    const budget = sessionBudget(role, found.price);
    const reusable = unlocked.find(({ session }) => left(session) >= budget);
    if (reusable !== undefined) return reusable;
    const target = free[0] ?? dead[0];
    if (target === undefined) return fallBack("Every session this account can hold is used");
    const start = now();
    const messages = [
      ...dead.map(({ keys }) => revokeMessage(address, keys.sessionPubKey)),
      sessionMessage(address, target.keys.sessionPubKey, start, realm, budget, sessionLifetime),
    ];
    const gasWanted = sessionGas * messages.length;
    const response = await wallet.DoContract({
      messages,
      memo: "Gnomehall session",
      gasWanted,
      gasFee: feeFor(gasWanted, found.price),
    });
    // Adena's answer when the player rejects the approval or closes its window.
    if (response?.type === "TRANSACTION_REJECTED")
      throw new ArenaError("refused", response.message || "The session was not approved");
    if (response?.status !== "success")
      return fallBack(response?.message || response?.type || "The wallet created no session");
    // A read served before the approval's block applies may still show the revoked session.
    const created = (s) => s.address === target.keys.sessionAddress && s.expiresAt === start + sessionLifetime;
    const session = (await chain.sessions(address)).find(created);
    if (session === undefined) throw new ArenaError("failed", "The new session is not on the chain yet; try again");
    return { ...target, session };
  }

  // sessionIn returns the session that signs this player's next call in match id, which
  // view shows: the live session locked to it, else, outside the per-move mode, a live
  // unlocked one, such as a renewal leaves, which that call locks. It returns null when
  // there is none.
  async function sessionIn(id, view) {
    const role = roleOf(view);
    const found = await ownSessions();
    // Only this match is read: sessions locked elsewhere then count as dead, unused here.
    const { byMatch, unlocked } = classify(found, new Map([[id, { phase: view.Phase, role }]]));
    if (byMatch.has(id) || mode() === "contract") return byMatch.get(id) ?? null;
    return unlocked.find(({ session }) => left(session) >= sessionReserve(found.price).opening[role]) ?? null;
  }

  // signingIn is sessionIn for a move, which without a session needs a renewal, or the
  // wallet in the per-move mode.
  async function signingIn(id, view) {
    const found = await sessionIn(id, view);
    if (found === null && mode() !== "contract")
      throw new ArenaError("sessionExpired", `The session for match ${id} has expired or run out; renew it`);
    return found;
  }

  const endingSession = async (id) => (stored("root") === null ? null : sessionIn(id, await readMatch(id)));

  // sessionState gives session, "expired" when this player must renew before acting in match
  // id and "active" otherwise, always in the per-move mode, and sessionExpires, the expiry of
  // the session that signs their next call there, when there is one.
  async function sessionState(id, view) {
    if (mode() === "contract" || stored("root") === null || roleOf(view) === undefined || view.Phase === "ended")
      return { session: "active" };
    const found = await sessionIn(id, view);
    return found === null ? { session: "expired" } : { session: "active", sessionExpires: found.session.expiresAt };
  }

  // serial runs task once every task before it has settled. Calls go out one at a time,
  // so each signs with the sequence the previous one's block left, and no call takes the
  // session prepared for another.
  let queue = Promise.resolve();
  function serial(task) {
    const done = queue.then(task);
    queue = done.catch(() => {});
    return done;
  }

  // send makes one arena call, signed by the session signing resolves to, or by the
  // wallet itself when it resolves to null or the arena signs each move.
  const send = (func, args, signing) => serial(() => sendNow(func, args, signing));

  async function sendNow(func, args, signing) {
    requireAddress();
    const msg = {
      type: "/vm.m_call",
      value: { caller: address, send: "", max_deposit: "", pkg_path: realm, func, args },
    };
    try {
      const signedBy = signEachMove ? null : await signing();
      if (signedBy === null) {
        const response = await wallet.DoContract({ messages: [msg], memo: "" });
        if (response?.status !== "success") throw walletFailure(response);
        return;
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
      await chain.broadcast(await payFor(chain, (fee) => signer.signTx({ ...request, fee })));
    } catch (err) {
      throw errorFrom(err);
    }
  }

  function checkID(id) {
    if (!/^\d{1,10}$/.test(id)) throw new ArenaError("wrongPhase", `No match ${id}`);
  }

  const arena = {
    // canNotify is false without a notifier, so notify can only fail.
    hasWallet: wallet != null,
    canNotify: notifier !== undefined,

    // connect returns the account's state: {state, address, mode, fallback}, state being
    // noWallet, wrongNetwork, missing (this device is not authorized) or active.
    async connect() {
      try {
        ({ address } = await connectWallet(wallet, chainId, network));
      } catch (err) {
        if (err instanceof WalletError && (err.type === "noWallet" || err.type === "wrongNetwork")) {
          return { state: err.type, reason: err.reason };
        }
        throw errorFrom(err);
      }
      return status();
    },

    // authorize gets the root signature, once per device, and returns the account's state.
    async authorize() {
      requireAddress();
      try {
        if (stored("root") === null) store("root", await rootSignature(wallet, address, origin));
      } catch (err) {
        throw errorFrom(err);
      }
      return status();
    },

    // account returns the account's state as connect gives it, without asking the wallet;
    // mode contract means the wallet signs each call that no live session locked to its
    // match can sign, for the reason fallback holds.
    account: status,

    // resumeSessions leaves the per-move mode, so the next challenge, acceptance or renewal
    // asks the wallet for a session again, and returns the account's state.
    resumeSessions() {
      requireAddress();
      store("mode", "session");
      store("fallback", "");
      return status();
    },

    // renew asks the wallet for a session for this player's side of match id, revoking
    // the dead ones, unless a live unlocked one has the budget. It sends no move: the next
    // one locks the session to the match.
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
      const list = await read(`${realm}.Open(${page * pageSize}, ${pageSize})`);
      return list.map((c) => ({
        ...c,
        action: actionFor({ ...c, Phase: "open" }, address, now()),
        deadline: c.Expires,
      }));
    },

    async myMatches(page = 0) {
      requireAddress();
      const list = await read(`${realm}.Matches("${address}", ${page * pageSize}, ${pageSize})`);
      return list.map((s) => ({ ...s, action: actionFor(s, address, now()), deadline: s.Deadline }));
    },

    // match returns the view of match id with its replayed rounds, the engine state they
    // lead to, the challenger's pending clash when it is their move, the action, when the
    // action is move what the plan is made from (planFrom), session, "expired" when this
    // player must renew before acting, and sessionExpires, in Unix seconds, when a session
    // of theirs signs their next call.
    async match(id) {
      checkID(id);
      try {
        const view = await readMatch(id);
        const { rounds, state } = replay(view, engine);
        let pending;
        let opened;
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

    // challenge posts a challenge with card ids for the deck and round-1 plan, open to
    // anyone or reserved for opponent's address, and returns the new match's id. Like
    // accept, it signs with a session prepareSession gives, which the call locks.
    async challenge({ clan, deck, plan, opponent = "" }) {
      requireAddress();
      checkOpening(engine, clan, deck, plan, 0);
      const key = await boxKey();
      const sealed = { deck: [...deck].sort((a, b) => a - b), deckSalt: newSalt(), plan, planSalt: newSalt() };
      const deckSeal = await sealOf(sealed.deckSalt, cardNames(sealed.deck, engine.cards));
      const planSeal = await sealOf(sealed.planSalt, cardNames(plan, engine.cards));
      await send("Challenge", [clan, deckSeal, planSeal, await sealBox(key, sealed), opponent], () =>
        prepareSession("challenger"),
      );
      const [latest] = await read(`${realm}.Matches("${address}", 0, 1)`);
      return latest.ID;
    },

    async accept(id, { clan, deck, plan }) {
      checkID(id);
      checkOpening(engine, clan, deck, plan, 1);
      await send("Accept", [id, clan, cardNames(deck, engine.cards), cardNames(plan, engine.cards)], () =>
        prepareSession("acceptor"),
      );
    },

    // move sends this player's plan, as card ids, for the round being played.
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
          return await send(func, args, () => signingIn(id, view));
        }
        const key = await boxKey();
        const planSalt = newSalt();
        const next = {
          plan: planText,
          seal: await sealOf(planSalt, planText),
          box: await sealBox(key, { plan, planSalt }),
        };
        const { func, args } = moveCall(view, await openBox(key, view.Box), next, engine.cards);
        return await send(func, args, () => signingIn(id, view));
      } catch (err) {
        throw errorFrom(err);
      }
    },

    // finish sends the challenger's last reveal, after round 3 or a knockout.
    async finish(id) {
      const view = await arena.match(id);
      if (view.action !== "finish") throw new ArenaError("wrongPhase", `Match ${id} has no reveal to finish`);
      try {
        const { func, args } = moveCall(view, await openBox(await boxKey(), view.Box), null, engine.cards);
        return await send(func, args, () => signingIn(id, view));
      } catch (err) {
        throw errorFrom(err);
      }
    },

    // These end the match, so with no live session for it, or no root signature to derive
    // one, the wallet signs them. A claimer's session always ends before the deadline it claims.
    async resign(id) {
      checkID(id);
      await send("Resign", [id], () => endingSession(id));
    },

    async claimForfeit(id) {
      checkID(id);
      await send("ClaimForfeit", [id], () => endingSession(id));
    },

    // subscribe calls onChange(change) when the arena may have changed, and returns a
    // function that stops it. Through the indexer, change is {match, func, caller,
    // height} for each call, match being null for a new challenge, and {} each time the
    // indexer starts answering, since it reports only calls indexed after its first
    // answer. While no indexer answers, change is {} every interval ms the page is
    // visible.
    subscribe(onChange, { interval = 4000 } = {}) {
      let timer = null;
      const poll = () => {
        if (globalThis.document?.visibilityState !== "hidden") onChange({});
        timer = setTimeout(poll, interval);
      };
      const startPolling = () => {
        if (timer === null) timer = setTimeout(poll, interval);
      };
      const stopPolling = () => {
        clearTimeout(timer);
        timer = null;
      };
      if (indexer === undefined) {
        startPolling();
        return stopPolling;
      }
      const stopFeed = indexer.watchCalls(
        realm,
        ({ height, caller, func, args }) =>
          onChange({ match: func === "Challenge" ? null : (args[0] ?? null), func, caller, height }),
        (state) => {
          if (state === "down") return startPolling();
          stopPolling();
          onChange({});
        },
      );
      return () => {
        stopFeed();
        stopPolling();
      };
    },

    // watch calls onChange(view) whenever match id changes, or onChange(null, error) when
    // a read fails; subscribe says when to read it again, and so does the expiry of the
    // session that signs this player's next call there. It returns a function that stops it.
    watch(id, onChange, { interval = 4000 } = {}) {
      let last = "";
      let stopped = false;
      let expiry = null;
      let reading = Promise.resolve();
      const read = () => {
        reading = reading.then(async () => {
          if (stopped) return;
          try {
            const view = await arena.match(id);
            clearTimeout(expiry);
            if (view.sessionExpires > 0)
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
              onChange(view);
            }
          } catch (err) {
            if (!stopped) onChange(null, errorFrom(err));
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

    // notify asks the browser for permission and opts it in to the arena's Turn and
    // Ended notifications for this wallet. Call it from a click.
    async notify() {
      requireAddress();
      if (notifier === undefined) throw new ArenaError("failed", "Notifications are not set up for this network");
      await notifier.enable();
      const triggers = (await notifier.triggers(realm)).filter((t) => t.event === "Turn" || t.event === "Ended");
      await notifier.setOptins(triggers.map((t) => ({ trigger: t.id, value: address })));
      return triggers.length;
    },
  };
  return arena;
}
