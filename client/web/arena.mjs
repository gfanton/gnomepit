// Everything the lobby and the match screens need from the arena realm: the account's
// state, the board, a player's matches, one match with what this player can do now, and
// every move. Seals, salts, boxes and reveals stay inside: a challenger's move opens the
// sealed plan, reveals it and seals the next one in one call.

import { ChainError, payFor } from "./chain.mjs";
import { decode, structTypes, typeFields } from "./gnovalue.mjs";
import {
  WalletError, connect as connectWallet, deriveKeys, findSession, newSalt, openBox, rootSignature, sealBox, sealOf,
  sessionMessage,
} from "./wallet.mjs";

const pageSize = 20;

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
  const plans = [cardIDs(opened.plan, engine.cards), cardIDs(view.Plans[view.Round - 1][1], engine.cards)];
  const outcome = resolve(engine, state, [opened.deck ?? view.ChallengerDeck, view.AcceptorDeck], plans);
  return { round: view.Round, plans, events: outcome.events, state: outcome.state, result: outcome.result };
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
// challenger, with the opened box, the deck on the first reveal only, and the next plan's
// seal and box, or none when the match ends.
export function moveCall(view, opened, next) {
  if (view.Phase === "play") return { func: "Play", args: [view.ID, next.plan] };
  const first = view.ChallengerDeck === "";
  return {
    func: "Reveal",
    args: [view.ID, first ? opened.deck : "", first ? opened.deckSalt : "", opened.plan, opened.planSalt, next?.seal ?? "", next?.box ?? ""],
  };
}

const realmErrors = [
  [/^(wrong phase|not your move|not a player|not your challenge|not the named opponent|unknown match)/, "wrongPhase"],
  [/^seal mismatch/, "sealMismatch"],
  [/^(illegal plan|illegal deck|unknown card|unknown clan)/, "illegalPlan"],
  [/^(deadline passed|challenge expired)/, "deadlinePassed"],
  [/^(unknown session|session expired|session spend limit|session has no spend limit)/, "sessionExpired"],
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
// calls (Adena itself, or devWallet); engine is the loaded engine and signer; storage
// keeps the root signature and the signing mode per wallet, like localStorage; notifier
// is a gnotif client. origin names the site in the root signature's text. signEachMove
// skips the session: the wallet signs every move.
export function createArena({
  chain, wallet, engine, realm, chainId, origin, storage, notifier, signEachMove = false, now = () => Math.floor(Date.now() / 1000),
}) {
  let address = null;
  const fields = new Map();
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
    if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, deriveKeys(root, generation, engine));
    return keyCache.get(cacheKey);
  }
  const boxKey = async () => (await keysFor(0)).boxKey;

  async function read(expr) {
    try {
      const [result] = await chain.evalJSON(expr);
      for (const id of structTypes(result)) {
        if (!fields.has(id)) for (const [type, names] of typeFields(await chain.typeJSON(id))) fields.set(type, names);
      }
      return decode(result, fields);
    } catch (err) {
      throw errorFrom(err);
    }
  }

  async function status() {
    const base = { address, mode: mode(), fallback: stored("fallback") || null };
    if (stored("root") === null) return { ...base, state: "missing", expiresAt: 0 };
    if (mode() === "contract") return { ...base, state: "active", expiresAt: 0 };
    const found = await findSession(chain, address, keysFor, now(), realm);
    return { ...base, state: found.state, expiresAt: found.expiresAt };
  }

  // send makes one arena call: signed by the session key, or by the wallet itself in
  // the per-move mode. Calls go out one at a time, so each signs with the sequence the
  // previous one's block left.
  let queue = Promise.resolve();
  function send(func, args) {
    const sent = queue.then(() => sendNow(func, args));
    queue = sent.catch(() => {});
    return sent;
  }

  async function sendNow(func, args) {
    requireAddress();
    const msg = { type: "/vm.m_call", value: { caller: address, send: "", max_deposit: "", pkg_path: realm, func, args } };
    try {
      if (mode() === "contract") {
        const response = await wallet.DoContract({ messages: [msg], memo: "" });
        if (response?.status !== "success") throw walletFailure(response);
        return;
      }
      const found = await findSession(chain, address, keysFor, now(), realm);
      if (found.state !== "active") throw new ArenaError("sessionExpired", "The session has expired or run out; authorize again");
      const { keys, session } = found;
      const request = {
        chainId, accountNumber: session.accountNumber, sequence: session.sequence,
        privKey: keys.sessionKey, sessionAddr: keys.sessionAddress, memo: "", msgs: [msg],
      };
      await chain.broadcast(await payFor(chain, (fee) => engine.signTx({ ...request, fee })));
    } catch (err) {
      throw errorFrom(err);
    }
  }

  function checkID(id) {
    if (!/^\d{1,10}$/.test(id)) throw new ArenaError("wrongPhase", `No match ${id}`);
  }

  const arena = {
    // connect returns the account's state: {state, address, mode, expiresAt, fallback},
    // state being noWallet, wrongNetwork, missing (this device is not authorized),
    // active, or expired.
    async connect() {
      try {
        ({ address } = await connectWallet(wallet, chainId));
      } catch (err) {
        if (err instanceof WalletError && (err.type === "noWallet" || err.type === "wrongNetwork")) {
          return { state: err.type, reason: err.reason };
        }
        throw errorFrom(err);
      }
      try {
        return await status();
      } catch (err) {
        throw errorFrom(err);
      }
    },

    // authorize gets the root signature, once per device, and creates a session. Where
    // the wallet creates none, the wallet signs each move until an authorization does;
    // the state's fallback holds the wallet's reason meanwhile.
    async authorize() {
      requireAddress();
      try {
        if (stored("root") === null) store("root", await rootSignature(wallet, address, origin));
        if (signEachMove) return await status();
        const found = await findSession(chain, address, keysFor, now(), realm);
        if (found.state !== "active" && found.generation === null) {
          store("mode", "contract");
          store("fallback", "Every session this account can hold is used");
          return await status();
        }
        if (found.state !== "active") {
          const response = await wallet.DoContract({
            messages: [sessionMessage(address, found.keys.sessionPubKey, now(), realm)],
            memo: "Gnomehall session",
          });
          if (response?.status !== "success") {
            store("mode", "contract");
            store("fallback", response?.message || response?.type || "The wallet created no session");
            return await status();
          }
        }
        store("mode", "session");
        store("fallback", "");
        return await status();
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async openChallenges(page = 0) {
      const list = await read(`${realm}.Open(${page * pageSize}, ${pageSize})`);
      return list.map((c) => ({ ...c, action: actionFor({ ...c, Phase: "open" }, address, now()), deadline: c.Expires }));
    },

    async myMatches(page = 0) {
      requireAddress();
      const list = await read(`${realm}.Matches("${address}", ${page * pageSize}, ${pageSize})`);
      return list.map((s) => ({ ...s, action: actionFor(s, address, now()), deadline: s.Deadline }));
    },

    // match returns the view of match id with its replayed rounds, the engine state they
    // lead to, the challenger's pending clash when it is their move, the action, and,
    // when the action is move, what the plan is made from (planFrom).
    async match(id) {
      checkID(id);
      try {
        const view = await read(`${realm}.Match("${id}")`);
        const { rounds, state } = replay(view, engine);
        let pending;
        let opened;
        if (view.Phase === "reveal" && view.ToMove === address && view.Box !== "" && stored("root") !== null) {
          opened = await openBox(await boxKey(), view.Box);
          pending = pendingClash(view, opened, state, engine);
        }
        const action = actionFor(view, address, now(), pending);
        const planning = action === "move" ? planFrom(view, state, pending, opened?.deck ?? view.ChallengerDeck, engine.cards) : undefined;
        return { ...view, rounds, state, pending, planning, action, deadline: view.Deadline };
      } catch (err) {
        throw errorFrom(err);
      }
    },

    // challenge posts a challenge with card ids for the deck and round-1 plan, open to
    // anyone or reserved for opponent's address, and returns the new match's id.
    async challenge({ clan, deck, plan, opponent = "" }) {
      requireAddress();
      checkOpening(engine, clan, deck, plan, 0);
      const key = await boxKey();
      const opened = { deck: cardNames(deck, engine.cards), deckSalt: newSalt(), plan: cardNames(plan, engine.cards), planSalt: newSalt() };
      await send("Challenge", [
        clan, await sealOf(opened.deckSalt, opened.deck), await sealOf(opened.planSalt, opened.plan), await sealBox(key, opened), opponent,
      ]);
      const [latest] = await read(`${realm}.Matches("${address}", 0, 1)`);
      return latest.ID;
    },

    async accept(id, { clan, deck, plan }) {
      checkID(id);
      checkOpening(engine, clan, deck, plan, 1);
      await send("Accept", [id, clan, cardNames(deck, engine.cards), cardNames(plan, engine.cards)]);
    },

    // move sends this player's plan, as card ids, for the round being played.
    async move(id, plan) {
      const view = await arena.match(id);
      if (view.action !== "move") throw new ArenaError("wrongPhase", `There is no move to make in match ${id}`);
      if (view.planning === undefined) throw new ArenaError("unauthorized", "Authorize this device to open your sealed plan");
      checkPlan(engine, view.planning, plan);
      const planText = cardNames(plan, engine.cards);
      try {
        if (view.Phase === "play") {
          const { func, args } = moveCall(view, null, { plan: planText });
          return await send(func, args);
        }
        const key = await boxKey();
        const planSalt = newSalt();
        const next = { plan: planText, seal: await sealOf(planSalt, planText), box: await sealBox(key, { plan: planText, planSalt }) };
        const { func, args } = moveCall(view, await openBox(key, view.Box), next);
        return await send(func, args);
      } catch (err) {
        throw errorFrom(err);
      }
    },

    // finish sends the challenger's last reveal, after round 3 or a knockout.
    async finish(id) {
      const view = await arena.match(id);
      if (view.action !== "finish") throw new ArenaError("wrongPhase", `Match ${id} has no reveal to finish`);
      try {
        const { func, args } = moveCall(view, await openBox(await boxKey(), view.Box), null);
        return await send(func, args);
      } catch (err) {
        throw errorFrom(err);
      }
    },

    async resign(id) {
      checkID(id);
      await send("Resign", [id]);
    },

    async claimForfeit(id) {
      checkID(id);
      await send("ClaimForfeit", [id]);
    },

    // watch calls onChange(view) whenever match id changes, polling every interval ms
    // while the page is visible, or onChange(null, error) when a read fails. It returns
    // a function that stops it.
    watch(id, onChange, { interval = 4000 } = {}) {
      let last = "";
      let stopped = false;
      let timer;
      const tick = async () => {
        if (stopped) return;
        if (globalThis.document?.visibilityState !== "hidden") {
          try {
            const view = await arena.match(id);
            const seen = JSON.stringify([view.Phase, view.Round, view.ToMove, view.Plans, view.HP, view.Result, view.DeadlinePassed]);
            if (seen !== last && !stopped) {
              last = seen;
              onChange(view);
            }
          } catch (err) {
            if (!stopped) onChange(null, errorFrom(err));
          }
        }
        if (!stopped) timer = setTimeout(tick, interval);
      };
      void tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },

    // notify asks the browser for permission and opts it in to the arena's Turn and
    // Ended notifications for this wallet. Call it from a click.
    async notify() {
      requireAddress();
      await notifier.enable();
      const triggers = (await notifier.triggers(realm)).filter((t) => t.event === "Turn" || t.event === "Ended");
      await notifier.setOptins(triggers.map((t) => ({ trigger: t.id, value: address })));
      return triggers.length;
    },
  };
  return arena;
}
