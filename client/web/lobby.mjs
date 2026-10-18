import { escapeHTML } from "./keywords.ts";
import { viewOf, shortAddress, timeLeft } from "./online-model.ts";
const esc = (value) => escapeHTML(String(value ?? "")).replaceAll('"', "&quot;");
const btn = (text, action, disabled = false, secondary = false, extra = "") =>
  `<button type="button" class="${secondary ? "quiet" : "button"}" data-action="online${action}" ${disabled ? "disabled" : ""} ${extra}>${esc(text)}</button>`;
const collection = (value) =>
  Array.isArray(value) ? value : (value?.items ?? value?.matches ?? value?.challenges ?? []);
const perMatch =
  "Each match you post or accept asks your wallet once, for a one-day session that only plays that match.";
const unreachable = "Can't reach the hall right now. Check your connection and try again.";
// setupStep is the first thing a device still lacks to play online: 1 a wallet, 2 a connection
// on the game's network, 3 the root signature; null once it is ready.
export function setupStep({ hasWallet, address, ready }) {
  if (!hasWallet) return 1;
  if (!address) return 2;
  if (!ready) return 3;
  return null;
}
export function createLobby({ app, arena, storage, onRender, onCompose, onPlay, onResume, onExit, portrait, emblem }) {
  const model = {
    active: false,
    inGame: false,
    account: null,
    matches: [],
    challenges: [],
    view: null,
    busy: false,
    error: "",
    notice: "",
    page: 0,
    matchPage: 0,
    notifications: "off",
    blocked: false,
    draft: null,
  };
  let epoch = 0,
    unwatch = null,
    unfollow = null,
    focusReturn = null;
  const address = () => model.account?.address ?? "";
  const accountState = () => model.account?.state ?? "disconnected";
  // ready holds once this device has the root signature.
  const ready = () => Boolean(address() && accountState() === "active");
  const signsEachMove = () => model.account?.mode === "contract";
  const link = (id) => `${location.origin}${location.pathname}#match=${encodeURIComponent(id)}`;
  const copyButton = (addr) =>
    `<span class="address" title="${esc(addr)}">${esc(shortAddress(addr))}</span> ${btn("Copy", "Copy", false, true, `data-address="${esc(addr)}" aria-label="Copy full address"`)}`;
  function cancelWatch() {
    unwatch?.();
    unwatch = null;
  }
  // follow reads the board's lists again whenever the arena reports a change, while the
  // board shows, and redraws only when they differ: a redraw replays the cards' entrance.
  function follow() {
    if (unfollow || typeof arena?.subscribe !== "function") return;
    unfollow = arena.subscribe(() => {
      if (!model.active || model.inGame || model.view || model.busy) return;
      const token = epoch;
      const shown = () => JSON.stringify([model.challenges, model.matches]);
      const before = shown();
      lists().then(
        () => {
          if (token === epoch && shown() !== before) changed();
        },
        (e) => {
          if (token === epoch) {
            fail(e);
            changed();
          }
        },
      );
    });
  }
  function close() {
    app.querySelector("#online-dialog")?.close();
  }
  function changed() {
    onRender();
  }
  function fail(error) {
    model.error = error?.type === "network" ? unreachable : (error?.message ?? "The request failed. Try again.");
    if (/card file|chain.?s engine|ruleset|mismatch/i.test(model.error)) model.blocked = true;
  }
  async function run(task) {
    if (model.busy) return;
    const token = epoch;
    model.busy = true;
    model.error = "";
    changed();
    try {
      await task();
    } catch (e) {
      if (token === epoch) fail(e);
    } finally {
      if (token === epoch) {
        model.busy = false;
        changed();
      }
    }
  }
  async function lists() {
    if (!arena) return;
    const [challenges, matches] = await Promise.all([
      arena.openChallenges(model.page),
      address() ? arena.myMatches(model.matchPage) : Promise.resolve([]),
    ]);
    model.challenges = collection(challenges).map((v) => viewOf({ ...v, Phase: "open" }, address()));
    model.matches = collection(matches).map((v) => viewOf(v, address()));
  }
  async function refreshView(id) {
    const raw = await arena.match(id);
    model.view = viewOf(raw, address());
    return raw;
  }
  // The realm deletes a withdrawn challenge, and a later challenge clears an expired one.
  const removed = (e) => /^unknown match/.test(e?.message ?? "");
  async function open(id) {
    history.replaceState(null, "", `#match=${encodeURIComponent(id)}`);
    cancelWatch();
    await run(async () => {
      let raw;
      try {
        raw = await refreshView(id);
      } catch (e) {
        if (!removed(e)) throw e;
        leaveMatch();
        model.notice = "This challenge was withdrawn or has expired.";
        await lists();
        return;
      }
      if (model.view.action === "finish" && ready() && model.view.session !== "expired") {
        await arena.finish(id);
        raw = await refreshView(id);
      }
      await showEnding(raw);
    });
    if (!model.inGame) watchView(id);
  }
  function watchView(id) {
    cancelWatch();
    if (model.view && typeof arena?.watch === "function") {
      const token = epoch;
      const stop = arena.watch(id, async (value) => {
        if (token !== epoch || !model.active) return;
        try {
          const raw = value ?? (await arena.match(id));
          model.view = viewOf(raw, address());
          if (model.inGame) return;
          await showEnding(raw);
          if (!model.inGame) changed();
        } catch (e) {
          fail(e);
          changed();
        }
      });
      if (typeof stop === "function") unwatch = stop;
    }
  }
  // decided is the player's match that a clash ended. Resignations and missed deadlines end without one.
  const decided = (v) => v.side >= 0 && v.phase === "ended" && ["hp", "knockout"].includes(v.reason);
  // The board knows a match by its summary alone. Match numbers start again on a fresh chain;
  // the plans tell two matches under one number apart.
  const summaryKey = (v) => `gnomehall:ending:${address()}:${v.id}:${v.players}:${v.result}:${v.reason}`;
  const endingKey = (v) => `${summaryKey(v)}:${JSON.stringify(v.plans)}`;
  // showEnding plays the clash that ended a match, once per player, before its result shows.
  async function showEnding(raw) {
    const v = viewOf(raw, address());
    if (!decided(v) || storage?.getItem(endingKey(v))) return;
    await onPlay(raw, address(), true);
    storage?.setItem(endingKey(v), "seen");
    storage?.setItem(summaryKey(v), "seen");
    model.inGame = true;
    cancelWatch();
  }
  // A finish before round 3 follows a knockout, so it reads as a move until its clash plays.
  const early = (v) => v.action === "finish" && v.round < 3;
  const step = () =>
    arena ? setupStep({ hasWallet: arena.hasWallet === true, address: address(), ready: ready() }) : null;
  // stepsHTML: done steps say Done; only the current step shows its action.
  function stepsHTML() {
    const current = step();
    const reason = model.account?.reason;
    const steps = [
      [
        "Install Adena",
        "Adena is the browser wallet that signs your moves.",
        `<a class="button" href="https://adena.app" target="_blank" rel="noopener">Install Adena</a>${btn("I've installed it", "Reload", false, true)}`,
      ],
      [
        "Connect Adena",
        "Connecting adds this game's network to Adena if it is missing, then switches to it.",
        btn("Connect wallet", "Authorize", !arena || model.busy) +
          (accountState() === "wrongNetwork"
            ? `<p class="wallet-setup__problem">Adena did not add the network${reason ? `: ${esc(reason)}` : ""}. Connect again to retry.</p>`
            : ""),
      ],
      [
        "Sign once on this device",
        "This protects your hidden plans and lets this device recover them.",
        btn("Sign on this device", "Authorize", !arena || model.busy),
      ],
    ];
    return `<ol class="wallet-setup__steps">${steps
      .map(([title, text, act], i) => {
        const n = i + 1;
        const state = current === null || n < current ? "done" : n === current ? "current" : "todo";
        return `<li class="wallet-setup__step wallet-setup__step--${state}"${state === "current" ? ' aria-current="step"' : ""}><strong>${n} · ${esc(title)}</strong><p>${esc(text)}</p>${state === "done" ? '<span class="wallet-setup__done">Done</span>' : state === "current" ? `<div class="banner-actions">${act}</div>` : ""}</li>`;
      })
      .join("")}</ol><p class="wallet-setup__after"><strong>Approve a session for each match.</strong> ${perMatch}</p>`;
  }
  function setup() {
    dialog("Get ready to play online", stepsHTML());
  }
  function accountDialog() {
    const reason = model.account?.fallback;
    dialog(
      "Your account",
      `<p>${copyButton(address())}</p><p>This device can play online. ${perMatch}</p>${signsEachMove() ? `<p>Sessions are off, so your wallet approves each move.${reason ? ` Reason: ${esc(reason)}` : ""}</p>` : ""}`,
      signsEachMove() ? btn("Use sessions again", "ResumeSessions") : "",
    );
  }
  function dialog(title, body, actions = "") {
    focusReturn = document.activeElement;
    const d = app.querySelector("#online-dialog");
    d.innerHTML = `<div class="dialog-head"><h2 id="online-dialog-title">${esc(title)}</h2>${btn("Close", "Close", false, true)}</div>${body}<div class="dialog-actions">${actions}</div>`;
    d.showModal();
    d.addEventListener("close", () => focusReturn?.isConnected && focusReturn.focus(), { once: true });
  }
  function notice() {
    return !arena
      ? '<section class="notice"><div><strong>Online play is not connected yet</strong><p>This build has no online play. Play offline in the meantime.</p></div></section>'
      : model.error
        ? `<section class="notice notice--danger" role="alert"><div><strong>${model.blocked ? "The game needs an update" : "That didn’t go through"}</strong><p>${esc(model.error)}</p></div>${btn(model.blocked ? "Reload page" : "Refresh", "Refresh", model.busy, true)}</section>`
        : model.notice
          ? `<section class="notice" role="status">${esc(model.notice)}</section>`
          : "";
  }
  function header() {
    return `<header class="masthead"><a class="wordmark" href="./" data-action="onlineExit">Gnomehall<span>UNDER THE MOUNTAIN</span></a><div class="account">${btn(address() ? shortAddress(address()) + " · Account" : "Connect wallet", "Account", !arena || model.busy, true)}${address() ? `<small>${ready() ? "Device ready" : "Approval needed"}</small>` : ""}</div></header>`;
  }
  function matchCard(v) {
    const unwatched = decided(v) && !storage?.getItem(summaryKey(v));
    const mine = v.action === "move" || v.action === "finish" || v.action === "claimForfeit" || unwatched;
    const other = v.side === 0 ? 1 : 0;
    const status =
      v.phase === "open"
        ? "Awaiting a rival"
        : v.action === "claimForfeit"
          ? "Claim your win"
          : v.action === "finish"
            ? "Ready to finish"
            : v.action === "move"
              ? "Your move"
              : unwatched
                ? "Match over"
                : v.phase === "ended"
                  ? resultText(v)
                  : v.phase === "expired"
                    ? `Challenge ${v.phase}`
                    : `Waiting for ${v.clans[other] || "opponent"}`;
    return `<article class="match ${mine ? "match--turn" : ""}"><div class="match-top"><strong class="status">${esc(status)}</strong><small>${v.phase === "open" ? "Challenge" : `Round ${v.round ?? 1} / 3`}</small></div><div class="fighters">${portrait(v.clans[v.side] || v.clans[0], 'class="portrait"')}<span class="versus">vs</span>${portrait(v.clans[other], 'class="portrait portrait--iron"')}<div>${esc(v.clans[other] || "Rival to come")}<div>${v.players[other] ? copyButton(v.players[other]) : "Anyone can accept"}</div></div></div><div class="match-bottom"><small>${unwatched ? "Watch the last clash" : ["ended", "expired"].includes(v.phase) ? esc(reasonText(v)) : esc(timeLeft(v.deadline || v.expires))}</small>${btn(mine ? "Open match" : "View match", "Open", model.busy, !mine, `data-id="${esc(v.id)}"`)}</div></article>`;
  }
  function challengeCard(v) {
    const reserved = v.opponent;
    return `<article class="challenge ${v.clans[0] === "Ironhide" ? "challenge--iron" : ""}"><div class="match-top"><div><span class="eyebrow">${reserved ? (reserved === address() ? "Reserved for you" : "Reserved") : "Open challenge"}</span><h3>${esc(v.clans[0])}</h3></div><span class="notice-mark">${emblem(v.clans[0])}</span></div><p>Posted by ${copyButton(v.challenger)}</p>${reserved && reserved !== address() ? `<p>For ${copyButton(reserved)}</p>` : ""}<div class="match-bottom"><small>${esc(timeLeft(v.expires))}</small>${btn("View challenge", "Open", model.busy || model.blocked, false, `data-id="${esc(v.id)}"`)}</div></article>`;
  }
  function resultText(v) {
    if (v.result === "draw") return "An even score";
    return v.side < 0 ? "Match ended" : v.result === ["a", "b"][v.side] ? "You won" : "You lost";
  }
  function reasonText(v) {
    return (
      {
        hp: "Decided by HP after three rounds",
        knockout: "Ended by knockout",
        resign: "Ended by resignation",
        forfeit: "Ended by a missed deadline",
      }[v.reason] ?? ""
    );
  }
  function detail() {
    const v = model.view;
    const mine = v.side >= 0;
    const expired = v.phase === "expired";
    const other = v.side === 0 ? 1 : 0;
    return `${header()}${notice()}<section class="match"><div class="section-head"><h1>${esc(v.phase === "open" ? "A challenge awaits" : v.phase === "ended" ? resultText(v) : expired ? `Challenge ${v.phase}` : v.action === "move" || early(v) ? "Your move" : v.action === "finish" ? "Ready to finish" : v.action === "claimForfeit" ? "Opponent missed the deadline" : `Waiting for ${v.clans[other] || "a rival"}`)}</h1>${btn("Back to board", "Board", model.busy, true)}</div><div class="fighters">${portrait(v.clans[0], 'class="portrait"')}<strong>${esc(v.clans[0])}</strong><span class="versus">vs</span>${portrait(v.clans[1], 'class="portrait portrait--iron"')}<strong>${esc(v.clans[1] || "Rival to come")}</strong></div><p>Posted by ${copyButton(v.challenger)}</p>${v.acceptor ? `<p>Opponent ${copyButton(v.acceptor)}</p>` : ""}<p>${esc(v.phase === "ended" ? reasonText(v) : timeLeft(v.deadline || v.expires))}</p>${v.deadline || v.expires ? `<p><small>Deadline: ${esc(new Date((v.deadline || v.expires) * 1000).toLocaleString())}</small></p>` : ""}${v.hp?.length ? `<p>Latest clash: ${esc(v.clans[0])} ${esc(v.hp.at(-1)[0])} HP · ${esc(v.clans[1])} ${esc(v.hp.at(-1)[1])} HP</p>` : ""}${v.phase === "open" ? `<p>Choose a clan, build eight cards, and plan round 1 before accepting. Their deck stays hidden until round 2.</p>${v.opponent ? `<p>Reserved for ${copyButton(v.opponent)}. Share the link to invite them; reservations do not send notifications.</p>` : ""}` : v.action === "wait" && mine ? "<p>Your plan is sealed: they can’t see it until they’ve played theirs.</p>" : ""}<div class="banner-actions">${v.action === "accept" ? btn(ready() ? "Accept challenge" : "Connect to accept", ready() ? "Accept" : "Account", model.busy || model.blocked) : ""}${v.session === "expired" && ["move", "finish"].includes(v.action) ? btn("Renew session to play", "Renew", model.busy || model.blocked) : v.action === "move" || early(v) ? btn(ready() ? "Watch clash & plan" : "Connect to play", ready() ? (early(v) ? "Finish" : "Play") : "Account", model.busy || model.blocked) : v.action === "finish" ? btn("Finish match", "Finish", model.busy || model.blocked) : ""}${v.action === "claimForfeit" ? btn("Claim win", "Claim", model.busy) : ""}${(v.plans ?? []).some((p) => p?.[0]?.length && p?.[1]?.length) ? btn("Review last clash", "Review", model.busy || model.blocked, true) : ""}${mine && v.phase === "open" ? btn("Withdraw challenge", "Resign", model.busy, true) : mine && ["play", "reveal"].includes(v.phase) ? btn("Resign match", "Resign", model.busy, true) : ""}${v.phase === "ended" && mine ? btn("Challenge them again", "Rematch", model.busy || model.blocked) : ""}${btn("Copy match link", "Link", false, true)}</div><div role="status">${model.busy ? "Waiting for confirmation…" : ""}</div></section><dialog id="online-dialog" aria-labelledby="online-dialog-title"></dialog>`;
  }
  function render() {
    app.classList.remove("board--battle");
    app.classList.add("lobby");
    app.dataset.screen = "lobby";
    app.innerHTML = model.view
      ? detail()
      : `${header()}${step() !== null ? `<section class="wallet-setup" aria-labelledby="wallet-setup-title"><h2 id="wallet-setup-title">Get ready to play online</h2>${stepsHTML()}</section>` : ""}<section class="hall-banner"><img src="art/hall-hero-v2.jpg" alt=""><div class="copy"><span class="eyebrow">THE CHALLENGE BOARD</span><h1>A rival awaits.</h1><p>Settle a grudge in three rounds. Play together tonight, or take turns over a few days. Each move has a 24-hour deadline.</p><div class="banner-actions">${btn("Post a challenge", "Post", !arena || model.busy || model.blocked)}${arena?.canNotify ? btn(model.notifications === "on" ? "Notifications on" : "Notify me", "Notify", model.busy, true) : ""}</div></div></section>${notice()}${model.draft ? `<section class="notice"><div><strong>Your unsent plan is saved in this tab</strong><p>Resume it after renewing your session or checking the board.</p></div>${btn("Resume draft", "ResumeDraft", model.busy)}</section>` : ""}<div class="lobby-columns"><section aria-labelledby="matches-title"><div class="section-head"><div><h2 id="matches-title">My matches</h2><p>Your next move starts here.</p></div>${btn("Refresh", "Refresh", !arena || model.busy, true)}</div><div class="match-list">${model.matches.map(matchCard).join("") || `<div class="empty"><h3>${model.busy ? "Looking for matches…" : address() ? "Your first grudge starts here." : "Your matches live here."}</h3><p>${address() ? "Accept a challenge or post one of your own." : "Connect your wallet to find and resume matches."}</p></div>`}</div>${pager("Matches", model.matchPage, model.matches.length)}</section><section aria-labelledby="challenges-title"><div class="section-head"><div><h2 id="challenges-title">Open challenges</h2><p>Choose a rival. Bring your own deck.</p></div><small>Newest first</small></div><div class="challenge-list">${model.challenges.map(challengeCard).join("") || `<div class="empty"><h3>${model.busy ? "Reading the board…" : arena ? "The board is quiet." : "The board is not connected."}</h3><p>${arena ? "Leave a challenge for the next gnome through the door." : "Online challenges will appear when the arena is connected."}</p></div>`}</div>${pager("Challenges", model.page, model.challenges.length)}</section></div><footer class="footer"><span>No stakes. Just grudges.</span>${btn("Play offline", "Offline", model.busy, true)}</footer><dialog id="online-dialog" aria-labelledby="online-dialog-title"></dialog><p class="sr-only" role="status">${model.busy ? "Loading…" : ""}</p>`;
  }
  function pager(kind, page, count) {
    return arena && (page > 0 || count >= 50)
      ? `<div class="banner-actions">${btn("Previous", "Page", model.busy || page === 0, true, `data-kind="${kind}" data-page="${page - 1}"`)}<span>Page ${page + 1}</span>${btn("Next", "Page", model.busy || count < 50, true, `data-kind="${kind}" data-page="${page + 1}"`)}</div>`
      : "";
  }
  function leaveMatch() {
    history.replaceState(null, "", location.pathname + location.search);
    cancelWatch();
    model.view = null;
    model.notice = "";
  }
  function compose(intent, opponent = "") {
    if (!ready()) {
      setup();
      return;
    }
    model.inGame = true;
    cancelWatch();
    try {
      onCompose({ intent, view: model.view, opponent, account: address() });
    } catch (e) {
      model.inGame = false;
      fail(e);
      changed();
    }
  }
  async function action(name, data) {
    if (name === "Close") {
      close();
      return;
    }
    // Adena is looked for once, as the page loads.
    if (name === "Reload") {
      location.reload();
      return;
    }
    // Offline leaves for the home page's offline row; Exit, from the wordmark, for its top.
    if (name === "Exit" || name === "Offline") {
      epoch++;
      cancelWatch();
      unfollow?.();
      unfollow = null;
      history.replaceState(null, "", location.pathname + location.search);
      model.active = false;
      model.inGame = false;
      app.classList.remove("lobby");
      onExit(name === "Offline");
      return;
    }
    if (name === "Copy" || name === "Link") {
      try {
        await navigator.clipboard.writeText(name === "Link" ? link(model.view.id) : data.address);
        model.notice = "Copied.";
      } catch {
        model.notice = "Clipboard unavailable. Select and copy the address or match URL.";
      }
      if (app.querySelector("#online-dialog")?.open) {
        const p = document.createElement("p");
        p.setAttribute("role", "status");
        p.textContent = model.notice;
        app.querySelector("#online-dialog").append(p);
      } else changed();
      return;
    }
    if (model.busy) return;
    if (name === "ResumeDraft") {
      onResume();
      return;
    }
    if (name === "Account") {
      if (ready()) accountDialog();
      else setup();
    } else if (name === "Authorize") {
      close();
      await run(async () => {
        model.account = await arena.connect();
        if (address() && !ready()) model.account = await arena.authorize();
        await lists();
      });
      if (model.view?.id) await open(model.view.id);
    } else if (name === "ResumeSessions") {
      close();
      await run(async () => {
        model.account = await arena.resumeSessions();
      });
    } else if (name === "Renew") {
      const id = model.view.id;
      await run(async () => {
        await arena.renew(id);
        model.account = arena.account();
        await refreshView(id);
      });
    } else if (name === "Refresh") {
      if (model.blocked) {
        location.reload();
        return;
      }
      await run(async () => (model.view ? refreshView(model.view.id) : lists()));
    } else if (name === "Page") {
      if (data.kind === "Matches") model.matchPage = Number(data.page);
      else model.page = Number(data.page);
      await run(lists);
    } else if (name === "Open") await open(data.id);
    else if (name === "Board") {
      leaveMatch();
      await run(lists);
    } else if (name === "Post" || name === "Rematch") {
      if (!ready()) {
        setup();
        return;
      }
      dialog(
        "Leave a challenge",
        '<p>Choose your clan, build your eight-card deck, then plan round 1.</p><label class="field">Opponent address (optional)<input id="online-opponent" autocomplete="off" spellcheck="false" placeholder="Anyone can accept" value="' +
          esc(name === "Rematch" ? model.view.players[1 - model.view.side] : "") +
          '"></label><p>Reserve for a friend, then share the match link. They won’t receive an invitation notification.</p>',
        btn("Choose your clan", "Compose"),
      );
    } else if (name === "Compose") {
      const opponent = app.querySelector("#online-opponent").value.trim();
      close();
      compose("challenge", opponent);
    } else if (name === "Accept") compose("accept");
    else if (name === "Play" || name === "Review") {
      await run(async () => {
        const raw = await arena.match(model.view.id);
        model.view = viewOf(raw, address());
        if (name === "Play" && model.view.action !== "move")
          throw new Error("This match moved on. Refresh to see its current state.");
        await onPlay(raw, address(), name === "Review");
        model.inGame = true;
        cancelWatch();
      });
    } else if (name === "Resign")
      dialog(
        model.view.phase === "open" ? "Withdraw this challenge?" : "Resign this match?",
        `<p>${model.view.phase === "open" ? "Nobody will be able to accept it." : "This records a loss. Your opponent wins."}</p>`,
        btn("Keep playing", "Close", false, true) + btn("Confirm", "ResignConfirm"),
      );
    // The realm deletes a withdrawn challenge, so neither a view nor a watch outlives it.
    else if (name === "ResignConfirm") {
      close();
      const { id, phase } = model.view;
      if (phase === "open") cancelWatch();
      await run(async () => {
        await arena.resign(id);
        if (phase === "open") {
          leaveMatch();
          await lists();
        } else await refreshView(id);
      });
    } else if (name === "Claim" || name === "Finish") {
      await run(async () => {
        if (!ready()) {
          model.account = await arena.authorize();
          if (!ready()) throw new Error("Approve this device to continue.");
        }
        await arena[name === "Claim" ? "claimForfeit" : "finish"](model.view.id);
        await showEnding(await refreshView(model.view.id));
      });
    } else if (name === "Notify") {
      await run(async () => {
        await arena.notify();
        model.notifications = globalThis.Notification?.permission === "denied" ? "blocked" : "on";
        if (globalThis.Notification?.permission === "default") model.notifications = "off";
        model.notice =
          model.notifications === "off"
            ? "Notifications were not enabled. You can try again from Notify me."
            : model.notifications === "blocked"
              ? "Notifications are blocked. Allow this site in browser settings."
              : "Notifications are on for opponent moves and match results. Deadline reminders are not sent.";
      });
    }
  }
  return {
    model,
    render,
    action,
    address,
    ready,
    async enter(id) {
      epoch++;
      model.active = true;
      model.inGame = false;
      model.error = "";
      follow();
      changed();
      await run(async () => {
        if (arena) await lists();
      });
      if (arena && id) await open(id);
    },
    async sendDraft(context, clan, deck, plan) {
      if (!arena) throw new Error("Online play is not connected.");
      if (!ready())
        throw new Error("This device needs approval. Return to the board and approve it; your plan is preserved.");
      if (context.view?.id) {
        const current = viewOf(await arena.match(context.view.id), address());
        if (current.action !== (context.intent === "move" ? "move" : "accept"))
          throw new Error("This match moved on. Refresh it before sending.");
      }
      if (context.intent === "move") await arena.move(context.view.id, plan);
      else
        try {
          if (context.intent === "accept") await arena.accept(context.view.id, { clan, deck, plan });
          else {
            const result = await arena.challenge({ clan, deck, plan, opponent: context.opponent });
            const id = typeof result === "string" ? result : result?.id;
            if (id) model.view = { id };
          }
        } finally {
          model.account = arena.account();
        }
      model.inGame = false;
      model.draft = null;
      model.notice = "Your move is confirmed.";
      try {
        const sentIn = context.view?.id || model.view?.id;
        if (sentIn) {
          await refreshView(sentIn);
          watchView(sentIn);
        }
        await lists();
      } catch (e) {
        model.view = null;
        fail(e);
        model.notice = "Your move was confirmed. Refresh the board to see it; do not send it again.";
      }
    },
    async returnToBoard() {
      model.inGame = false;
      changed();
      if (model.view?.id) await open(model.view.id);
    },
    report: fail,
  };
}
