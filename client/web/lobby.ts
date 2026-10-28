import { type AccountState, type Arena, ArenaError, type Connection, type MatchDetail } from "./arena.ts";
import { otherSide } from "./engine.ts";
import { type Address, type MatchId, matchId } from "./ids.ts";
import { escapeHTML } from "./keywords.ts";
import { type ArenaView, type View, isSet, viewOf, shortAddress, timeLeft } from "./online-model.ts";
const esc = (value: string | number | undefined) => escapeHTML(String(value ?? "")).replaceAll('"', "&quot;");
const btn = (text: string, action: string, disabled = false, secondary = false, extra = "") =>
  `<button type="button" class="${secondary ? "quiet" : "button"}" data-action="online${action}" ${disabled ? "disabled" : ""} ${extra}>${esc(text)}</button>`;
const filled = (text: string | null | undefined): text is string => text !== null && text !== undefined && text !== "";
const textOr = (text: string, fallback: string) => (text === "" ? fallback : text);
// dueOf is the time a view's deadline or, without one, its expiry falls on.
const dueOf = (v: View) => (isSet(v.deadline) ? v.deadline : v.expires);
// waitsFor says whether v's match still waits for a plan sent as context.
const waitsFor = (context: DraftContext, v: View) => v.action === (context.intent === "move" ? "move" : "accept");
// turnOf numbers a match's turns in order: open, reveal 1, play 2, reveal 2, play 3, reveal 3,
// then its end. Each confirmed plan moves its match to the next one.
const turnOf = (v: View) =>
  v.phase === "open"
    ? 0
    : v.phase === "play"
      ? 2 * (v.round ?? 1) - 2
      : v.phase === "reveal"
        ? 2 * (v.round ?? 1) - 1
        : Infinity;
const perMatch =
  "Each match you post or accept asks your wallet once, for a one-day session that only plays that match.";
const unreachable = "Can't reach the hall right now. Check your connection and try again.";
// linkedMatch is the match a #match= fragment names, the form of the lobby's match links and
// of the arena's notification links; undefined for any other fragment or a malformed one.
export function linkedMatch(hash: string): string | undefined {
  const encoded = /^#match=(.+)$/.exec(hash)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
// setupStep is the first thing a device still lacks to play online: 1 a wallet, 2 a connection
// on the game's network, 3 the root signature; null once it is ready.
export function setupStep({
  hasWallet,
  address,
  ready,
}: {
  hasWallet: boolean;
  address: string;
  ready: boolean;
}): 1 | 2 | 3 | null {
  if (!hasWallet) return 1;
  if (address === "") return 2;
  if (!ready) return 3;
  return null;
}
// The arena the lobby plays through. One that does not say it found a wallet counts as having
// none, and without subscribe or watch the lobby neither follows the board nor watches a match.
export type LobbyArena = Omit<Arena, "hasWallet" | "subscribe" | "watch"> &
  Partial<Pick<Arena, "hasWallet" | "subscribe" | "watch">>;
type Dialog = Pick<HTMLDialogElement, "innerHTML" | "open" | "showModal" | "close" | "addEventListener" | "append">;
// The element the lobby draws into, and the dialog and opponent field its markup holds.
export type LobbyPage = Pick<HTMLElement, "innerHTML" | "dataset"> & {
  classList: Pick<DOMTokenList, "add" | "remove">;
  querySelector(selectors: "#online-dialog"): Dialog | null;
  querySelector(selectors: "#online-opponent"): Pick<HTMLInputElement, "value"> | null;
};
// What a draft is sent as: a challenge, open or reserved for opponent, or an acceptance or a
// move in view's match.
export type DraftContext = {
  intent: "challenge" | "accept" | "move";
  view?: Pick<View, "id"> | null;
  opponent?: string;
};
export type LobbyOptions = {
  app: LobbyPage;
  arena: LobbyArena | null;
  // Remembers which ended matches this player has watched end.
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  onRender: () => void;
  onCompose: (context: {
    intent: "challenge" | "accept";
    view: View | null;
    opponent: string;
    account: Address | "";
  }) => void;
  // review is false when the player is to plan their move after the clash.
  onPlay: (raw: MatchDetail, address: Address | "", review: boolean) => void | Promise<void>;
  onResume: () => void;
  // offline leads to the home page's offline row rather than its top.
  onExit: (offline: boolean) => void;
  portrait: (clan: string, attributes: string) => string;
  emblem: (clan: string) => string;
};
export type LobbyModel<Draft> = {
  active: boolean;
  inGame: boolean;
  account: Connection | null;
  matches: View[];
  challenges: View[];
  view: View | null;
  busy: boolean;
  error: string;
  notice: string;
  page: number;
  matchPage: number;
  notifications: "off" | "on" | "blocked";
  blocked: boolean;
  // The page's unsent plan, which the lobby holds until its match no longer waits for it.
  draft: Draft | null;
};
// An action's data: the clicked button's dataset.
type ActionData = Readonly<Record<string, string | undefined>>;
export type Lobby<Draft> = {
  model: LobbyModel<Draft>;
  render(): void;
  action(name: string, data?: ActionData): Promise<void>;
  address(): Address | "";
  ready(): boolean;
  enter(id?: string): Promise<void>;
  sendDraft(context: DraftContext, clan: string, deck: number[], plan: number[]): Promise<void>;
  returnToBoard(): Promise<void>;
  report(error: unknown): void;
};
// What the lobby reads of a draft: what it would be sent as.
type Drafted = { onlineContext: DraftContext | null };
export function createLobby<Draft extends Drafted = Drafted>({
  app,
  arena,
  storage,
  onRender,
  onCompose,
  onPlay,
  onResume,
  onExit,
  portrait,
  emblem,
}: LobbyOptions): Lobby<Draft> {
  const model: LobbyModel<Draft> = {
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
    unwatch: (() => void) | null = null,
    unfollow: (() => void) | null = null,
    focusReturn: Element | null = null;
  // The turn each match was on when the chain confirmed this page's plan for it. A read at or
  // before that turn comes from a node the plan's block has not reached yet.
  const sent = new Map<MatchId, number>();
  const status = (): AccountState | undefined =>
    model.account !== null && "mode" in model.account ? model.account : undefined;
  const address = () => status()?.address ?? "";
  const accountState = () => model.account?.state ?? "disconnected";
  // ready holds once this device has the root signature.
  const ready = () => address() !== "" && accountState() === "active";
  const signsEachMove = () => status()?.mode === "contract";
  const seen = (key: string) => filled(storage?.getItem(key));
  const link = (id: MatchId) => `${location.origin}${location.pathname}#match=${encodeURIComponent(id)}`;
  const copyButton = (addr: string | undefined) =>
    `<span class="address" title="${esc(addr)}">${esc(shortAddress(addr))}</span> ${btn("Copy", "Copy", false, true, `data-address="${esc(addr)}" aria-label="Copy full address"`)}`;
  // online is the arena; the lobby offers nothing that reaches it when it has none.
  function online(): LobbyArena {
    if (arena === null) throw new Error("Online play is not connected.");
    return arena;
  }
  // openView is the open match's view; the actions that read it come from its screen.
  function openView(): View {
    if (model.view === null) throw new Error("No match is open.");
    return model.view;
  }
  // reconciled is v with this page's sent plans: a match read at or before the turn it sent a
  // plan in waits for the opponent.
  function reconciled(v: View): View {
    const turn = sent.get(v.id);
    if (turn === undefined || turnOf(v) > turn) return v;
    return v.action === "accept" || v.action === "move" ? { ...v, action: "wait" } : v;
  }
  const viewFor = (raw: ArenaView) => reconciled(viewOf(raw, address()));
  function cancelWatch() {
    unwatch?.();
    unwatch = null;
  }
  // follow reads the board's lists again whenever the arena reports a change, while the
  // board shows, and redraws only when they differ: a redraw replays the cards' entrance.
  function follow() {
    if (unfollow !== null || arena?.subscribe === undefined) return;
    unfollow = arena.subscribe(() => {
      if (!model.active || model.inGame || model.view !== null || model.busy) return;
      const token = epoch;
      const shown = () => JSON.stringify([model.challenges, model.matches]);
      const before = shown();
      lists().then(
        () => {
          if (token === epoch && shown() !== before) changed();
        },
        (e: unknown) => {
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
  function fail(error: unknown) {
    model.error =
      error instanceof ArenaError && error.type === "network"
        ? unreachable
        : error instanceof Error
          ? error.message
          : "The request failed. Try again.";
    if (/card file|chain.?s engine|ruleset|mismatch/i.test(model.error)) model.blocked = true;
  }
  async function run(task: () => Promise<unknown>) {
    if (model.busy) return;
    const token = epoch;
    model.busy = true;
    model.error = "";
    model.notice = "";
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
    if (arena === null) return;
    const [challenges, matches] = await Promise.all([
      arena.openChallenges(model.page),
      address() !== "" ? arena.myMatches(model.matchPage) : Promise.resolve([]),
    ]);
    model.challenges = challenges.filter((c) => !sent.has(c.ID)).map((c) => viewOf({ ...c, Phase: "open" }, address()));
    model.matches = matches.map(viewFor);
    model.matches.forEach(dropStaleDraft);
  }
  async function refreshView(id: MatchId) {
    const raw = await online().match(id);
    model.view = viewFor(raw);
    dropStaleDraft(model.view);
    return raw;
  }
  // dropStaleDraft forgets the unsent plan once v, its match, no longer waits for it.
  function dropStaleDraft(v: View) {
    const context = model.draft?.onlineContext;
    if (context !== undefined && context !== null && context.view?.id === v.id && !waitsFor(context, v))
      model.draft = null;
  }
  // The realm deletes a withdrawn challenge, and a later challenge clears an expired one.
  const removed = (e: unknown) => e instanceof Error && e.message.startsWith("unknown match");
  async function open(id: MatchId) {
    history.replaceState(null, "", `#match=${encodeURIComponent(id)}`);
    cancelWatch();
    await run(async () => {
      let raw: MatchDetail;
      try {
        raw = await refreshView(id);
      } catch (e) {
        if (!removed(e)) throw e;
        leaveMatch();
        model.notice = "This challenge was withdrawn or has expired.";
        await lists();
        return;
      }
      if (openView().action === "finish" && ready() && openView().session !== "expired") {
        await online().finish(id);
        raw = await refreshView(id);
      }
      await showEnding(raw);
    });
    if (!model.inGame) watchView(id);
  }
  function watchView(id: MatchId) {
    cancelWatch();
    if (model.view !== null && arena?.watch !== undefined) {
      const token = epoch;
      unwatch = arena.watch(id, async (value) => {
        if (token !== epoch || !model.active) return;
        try {
          const raw = value ?? (await online().match(id));
          const next = viewFor(raw);
          // A match that moved on outdates the notice about the last thing done in it.
          if (model.view !== null && (next.phase !== model.view.phase || next.action !== model.view.action))
            model.notice = "";
          model.view = next;
          dropStaleDraft(model.view);
          if (model.inGame) return;
          await showEnding(raw);
          if (!model.inGame) changed();
        } catch (e) {
          fail(e);
          changed();
        }
      });
    }
  }
  // decided is the player's match that a clash ended. Resignations and missed deadlines end without one.
  const decided = (v: View) => v.side >= 0 && v.phase === "ended" && (v.reason === "hp" || v.reason === "knockout");
  // The board knows a match by its summary alone. Match numbers start again on a fresh chain;
  // the plans tell two matches under one number apart.
  const summaryKey = (v: View) => `gnomepit:ending:${address()}:${v.id}:${v.players.join(",")}:${v.result}:${v.reason}`;
  const endingKey = (v: View) => `${summaryKey(v)}:${JSON.stringify(v.plans)}`;
  // showEnding plays the clash that ended a match, once per player, before its result shows.
  async function showEnding(raw: MatchDetail) {
    const v = viewOf(raw, address());
    if (!decided(v) || seen(endingKey(v))) return;
    await onPlay(raw, address(), true);
    storage?.setItem(endingKey(v), "seen");
    storage?.setItem(summaryKey(v), "seen");
    model.inGame = true;
    cancelWatch();
  }
  // A finish before round 3 follows a knockout, so it reads as a move until its clash plays.
  const early = (v: View) => v.action === "finish" && v.round !== undefined && v.round < 3;
  const step = () =>
    arena === null ? null : setupStep({ hasWallet: arena.hasWallet === true, address: address(), ready: ready() });
  // stepsHTML: done steps say Done; only the current step shows its action.
  function stepsHTML() {
    const current = step();
    const reason = model.account !== null && "reason" in model.account ? model.account.reason : undefined;
    const steps: [string, string, string][] = [
      [
        "Install Adena",
        "Adena is the browser wallet that signs your moves.",
        `<a class="button" href="https://adena.app" target="_blank" rel="noopener">Install Adena</a>${btn("I've installed it", "Reload", false, true)}`,
      ],
      [
        "Connect Adena",
        "Connecting adds this game's network to Adena if it is missing, then switches to it.",
        btn("Connect wallet", "Authorize", arena === null || model.busy) +
          (accountState() === "wrongNetwork"
            ? `<p class="wallet-setup__problem">Adena did not add the network${filled(reason) ? `: ${esc(reason)}` : ""}. Connect again to retry.</p>`
            : ""),
      ],
      [
        "Sign once on this device",
        "This protects your hidden plans and lets this device recover them.",
        btn("Sign on this device", "Authorize", arena === null || model.busy),
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
    const reason = status()?.fallback;
    dialog(
      "Your account",
      `<p>${copyButton(address())}</p><p>This device can play online. ${perMatch}</p>${signsEachMove() ? `<p>Sessions are off, so your wallet approves each move.${filled(reason) ? ` Reason: ${esc(reason)}` : ""}</p>` : ""}`,
      signsEachMove() ? btn("Use sessions again", "ResumeSessions") : "",
    );
  }
  function dialog(title: string, body: string, actions = "") {
    focusReturn = document.activeElement;
    const d = app.querySelector("#online-dialog");
    if (d === null) throw new Error("The lobby has no dialog to open.");
    d.innerHTML = `<div class="dialog-head"><h2 id="online-dialog-title">${esc(title)}</h2>${btn("Close", "Close", false, true)}</div>${body}<div class="dialog-actions">${actions}</div>`;
    d.showModal();
    d.addEventListener(
      "close",
      () => {
        if ((focusReturn instanceof HTMLElement || focusReturn instanceof SVGElement) && focusReturn.isConnected)
          focusReturn.focus();
      },
      { once: true },
    );
  }
  function notice() {
    return arena === null
      ? '<section class="notice"><div><strong>Online play is not connected yet</strong><p>This build has no online play. Play offline in the meantime.</p></div></section>'
      : model.error !== ""
        ? `<section class="notice notice--danger" role="alert"><div><strong>${model.blocked ? "The game needs an update" : "That didn’t go through"}</strong><p>${esc(model.error)}</p></div>${btn(model.blocked ? "Reload page" : "Refresh", "Refresh", model.busy, true)}</section>`
        : model.notice !== ""
          ? `<section class="notice" role="status">${esc(model.notice)}</section>`
          : "";
  }
  function header() {
    return `<header class="masthead"><a class="wordmark" href="./" data-action="onlineExit">Gnomepit<span>UNDER THE MOUNTAIN</span></a><div class="account">${btn(address() !== "" ? shortAddress(address()) + " · Account" : "Connect wallet", "Account", arena === null || model.busy, true)}${address() !== "" ? `<small>${ready() ? "Device ready" : "Approval needed"}</small>` : ""}</div></header>`;
  }
  function matchCard(v: View) {
    const unwatched = decided(v) && !seen(summaryKey(v));
    const mine = v.action === "move" || v.action === "finish" || v.action === "claimForfeit" || unwatched;
    const other = v.side === 0 ? 1 : 0;
    const statusText =
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
                    : `Waiting for ${textOr(v.clans[other], "opponent")}`;
    const own = v.side === -1 ? v.clans[0] : textOr(v.clans[v.side], v.clans[0]);
    return `<article class="match ${mine ? "match--turn" : ""}"><div class="match-top"><strong class="status">${esc(statusText)}</strong><small>${v.phase === "open" ? "Challenge" : `Round ${v.round ?? 1} / 3`}</small></div><div class="fighters">${portrait(own, 'class="portrait"')}<span class="versus">vs</span>${portrait(v.clans[other], 'class="portrait portrait--iron"')}<div>${esc(textOr(v.clans[other], "Rival to come"))}<div>${v.players[other] !== "" ? copyButton(v.players[other]) : filled(v.opponent) ? `Reserved for ${copyButton(v.opponent)}` : "Anyone can accept"}</div></div></div><div class="match-bottom"><small>${unwatched ? "Watch the last clash" : v.phase === "ended" || v.phase === "expired" ? esc(reasonText(v)) : esc(timeLeft(dueOf(v)))}</small>${btn(mine ? "Open match" : "View match", "Open", model.busy, !mine, `data-id="${esc(v.id)}"`)}</div></article>`;
  }
  function challengeCard(v: View) {
    const reserved = v.opponent;
    return `<article class="challenge ${v.clans[0] === "Ironhide" ? "challenge--iron" : ""}"><div class="match-top"><div><span class="eyebrow">${filled(reserved) ? (reserved === address() ? "Reserved for you" : "Reserved") : "Open challenge"}</span><h3>${esc(v.clans[0])}</h3></div><span class="notice-mark">${emblem(v.clans[0])}</span></div><p>Posted by ${copyButton(v.challenger)}</p>${filled(reserved) && reserved !== address() ? `<p>For ${copyButton(reserved)}</p>` : ""}<div class="match-bottom"><small>${esc(timeLeft(v.expires))}</small>${btn("View challenge", "Open", model.busy || model.blocked, false, `data-id="${esc(v.id)}"`)}</div></article>`;
  }
  function resultText(v: View) {
    if (v.result === "draw") return "An even score";
    return v.side < 0 ? "Match ended" : v.result === (v.side === 0 ? "a" : "b") ? "You won" : "You lost";
  }
  const reasons: Record<string, string> = {
    hp: "Decided by HP after three rounds",
    knockout: "Ended by knockout",
    resign: "Ended by resignation",
    forfeit: "Ended by a missed deadline",
  };
  function reasonText(v: View) {
    return v.reason === undefined ? "" : (reasons[v.reason] ?? "");
  }
  function detail(v: View) {
    const mine = v.side >= 0;
    const expired = v.phase === "expired";
    const other = v.side === 0 ? 1 : 0;
    const due = dueOf(v);
    const latest = v.hp?.at(-1);
    return `${header()}${notice()}<section class="match"><div class="section-head"><h1>${esc(v.phase === "open" ? "A challenge awaits" : v.phase === "ended" ? resultText(v) : expired ? `Challenge ${v.phase}` : v.action === "move" || early(v) ? "Your move" : v.action === "finish" ? "Ready to finish" : v.action === "claimForfeit" ? "Opponent missed the deadline" : `Waiting for ${textOr(v.clans[other], "a rival")}`)}</h1>${btn("Back to board", "Board", model.busy, true)}</div><div class="fighters">${portrait(v.clans[0], 'class="portrait"')}<strong>${esc(v.clans[0])}</strong><span class="versus">vs</span>${portrait(v.clans[1], 'class="portrait portrait--iron"')}<strong>${esc(textOr(v.clans[1], "Rival to come"))}</strong></div><p>Posted by ${copyButton(v.challenger)}</p>${filled(v.acceptor) ? `<p>Opponent ${copyButton(v.acceptor)}</p>` : ""}<p>${esc(v.phase === "ended" ? reasonText(v) : timeLeft(due))}</p>${isSet(due) ? `<p><small>Deadline: ${esc(new Date(due * 1000).toLocaleString())}</small></p>` : ""}${latest !== undefined ? `<p>Latest clash: ${esc(v.clans[0])} ${esc(latest[0])} HP · ${esc(v.clans[1])} ${esc(latest[1])} HP</p>` : ""}${v.phase === "open" ? `<p>Choose a clan, build eight cards, and plan round 1 before accepting. Their deck stays hidden until round 2.</p>${!filled(v.opponent) ? "" : v.opponent === address() ? "<p>Reserved for you.</p>" : `<p>Reserved for ${copyButton(v.opponent)}.${mine ? " Share the link to invite them; reservations do not send notifications." : ""}</p>`}` : v.action === "wait" && mine ? "<p>Your plan is sealed: they can’t see it until they’ve played theirs.</p>" : ""}<div class="banner-actions">${v.action === "accept" ? btn(ready() ? "Accept challenge" : "Connect to accept", ready() ? "Accept" : "Account", model.busy || model.blocked) : ""}${v.session === "expired" && (v.action === "move" || v.action === "finish") ? btn("Renew session to play", "Renew", model.busy || model.blocked) : v.action === "move" || early(v) ? btn(ready() ? "Watch clash & plan" : "Connect to play", ready() ? (early(v) ? "Finish" : "Play") : "Account", model.busy || model.blocked) : v.action === "finish" ? btn("Finish match", "Finish", model.busy || model.blocked) : ""}${v.action === "claimForfeit" ? btn("Claim win", "Claim", model.busy) : ""}${(v.plans ?? []).some((p) => filled(p[0]) && filled(p[1])) ? btn("Review last clash", "Review", model.busy || model.blocked, true) : ""}${mine && v.phase === "open" ? btn("Withdraw challenge", "Resign", model.busy, true) : mine && (v.phase === "play" || v.phase === "reveal") ? btn("Resign match", "Resign", model.busy, true) : ""}${v.phase === "ended" && mine ? btn("Challenge them again", "Rematch", model.busy || model.blocked) : ""}${btn("Copy match link", "Link", false, true)}</div><div role="status">${model.busy ? "Waiting for confirmation…" : ""}</div></section><dialog id="online-dialog" aria-labelledby="online-dialog-title"></dialog>`;
  }
  function render() {
    app.classList.remove("board--battle");
    app.classList.add("lobby");
    app.dataset.screen = "lobby";
    app.innerHTML =
      model.view !== null
        ? detail(model.view)
        : `${header()}${notice()}${step() !== null ? `<section class="wallet-setup" aria-labelledby="wallet-setup-title"><h2 id="wallet-setup-title">Get ready to play online</h2>${stepsHTML()}</section>` : ""}<section class="hall-banner"><img src="art/hall-hero-v2.jpg" alt=""><div class="copy"><span class="eyebrow">THE CHALLENGE BOARD</span><h1>A rival awaits.</h1><p>Settle a grudge in three rounds. Play together tonight, or take turns over a few days. Each move has a 24-hour deadline.</p><div class="banner-actions">${btn("Post a challenge", "Post", arena === null || model.busy || model.blocked)}${arena?.canNotify === true ? btn(model.notifications === "on" ? "Notifications on" : "Notify me", "Notify", model.busy, true) : ""}</div></div></section>${model.draft !== null ? `<section class="notice"><div><strong>Your unsent plan is saved in this tab</strong><p>Resume it after renewing your session or checking the board.</p></div>${btn("Resume draft", "ResumeDraft", model.busy)}</section>` : ""}<div class="lobby-columns"><section aria-labelledby="matches-title"><div class="section-head"><div><h2 id="matches-title">My matches</h2><p>Your next move starts here.</p></div>${btn("Refresh", "Refresh", arena === null || model.busy, true)}</div><div class="match-list">${textOr(model.matches.map(matchCard).join(""), `<div class="empty"><h3>${model.busy ? "Looking for matches…" : address() !== "" ? "Your first grudge starts here." : "Your matches live here."}</h3><p>${address() !== "" ? "Accept a challenge or post one of your own." : "Connect your wallet to find and resume matches."}</p></div>`)}</div>${pager("Matches", model.matchPage, model.matches.length)}</section><section aria-labelledby="challenges-title"><div class="section-head"><div><h2 id="challenges-title">Open challenges</h2><p>Choose a rival. Bring your own deck.</p></div><small>Newest first</small></div><div class="challenge-list">${textOr(model.challenges.map(challengeCard).join(""), `<div class="empty"><h3>${model.busy ? "Reading the board…" : arena !== null ? "The board is quiet." : "The board is not connected."}</h3><p>${arena !== null ? "Leave a challenge for the next gnome through the door." : "Online challenges will appear when the arena is connected."}</p></div>`)}</div>${pager("Challenges", model.page, model.challenges.length)}</section></div><footer class="footer"><span>No stakes. Just grudges.</span>${btn("Play offline", "Offline", model.busy, true)}</footer><dialog id="online-dialog" aria-labelledby="online-dialog-title"></dialog><p class="sr-only" role="status">${model.busy ? "Loading…" : ""}</p>`;
  }
  function pager(kind: string, page: number, count: number) {
    return arena !== null && (page > 0 || count >= 50)
      ? `<div class="banner-actions">${btn("Previous", "Page", model.busy || page === 0, true, `data-kind="${kind}" data-page="${page - 1}"`)}<span>Page ${page + 1}</span>${btn("Next", "Page", model.busy || count < 50, true, `data-kind="${kind}" data-page="${page + 1}"`)}</div>`
      : "";
  }
  function leaveMatch() {
    history.replaceState(null, "", location.pathname + location.search);
    cancelWatch();
    model.view = null;
    model.notice = "";
  }
  function compose(intent: "challenge" | "accept", opponent = "") {
    if (!ready()) {
      setup();
      return;
    }
    model.inGame = true;
    cancelWatch();
    try {
      // A challenge starts a new match, so only an acceptance carries the open one.
      onCompose({ intent, view: intent === "accept" ? model.view : null, opponent, account: address() });
    } catch (e) {
      model.inGame = false;
      fail(e);
      changed();
    }
  }
  async function action(name: string, data: ActionData = {}) {
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
        await navigator.clipboard.writeText(name === "Link" ? link(openView().id) : (data.address ?? ""));
        model.notice = "Copied.";
      } catch {
        model.notice = "Clipboard unavailable. Select and copy the address or match URL.";
      }
      const d = app.querySelector("#online-dialog");
      if (d?.open === true) {
        const p = document.createElement("p");
        p.setAttribute("role", "status");
        p.textContent = model.notice;
        d.append(p);
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
        model.account = await online().connect();
        if (address() !== "" && !ready()) model.account = await online().authorize();
        await lists();
      });
      if (model.view !== null && model.view.id !== "") await open(model.view.id);
    } else if (name === "ResumeSessions") {
      close();
      await run(async () => {
        model.account = online().resumeSessions();
      });
    } else if (name === "Renew") {
      const id = openView().id;
      await run(async () => {
        await online().renew(id);
        model.account = online().account();
        await refreshView(id);
      });
    } else if (name === "Refresh") {
      if (model.blocked) {
        location.reload();
        return;
      }
      await run(async () => (model.view !== null ? refreshView(model.view.id) : lists()));
    } else if (name === "Page") {
      if (data.kind === "Matches") model.matchPage = Number(data.page);
      else model.page = Number(data.page);
      await run(lists);
    } else if (name === "Open") await open(matchId(data.id ?? ""));
    else if (name === "Board") {
      leaveMatch();
      await run(lists);
    } else if (name === "Post" || name === "Rematch") {
      if (!ready()) {
        setup();
        return;
      }
      const rematched = name === "Rematch" ? openView() : null;
      const rival = rematched === null || rematched.side === -1 ? "" : rematched.players[otherSide(rematched.side)];
      dialog(
        "Leave a challenge",
        '<p>Choose your clan, build your eight-card deck, then plan round 1.</p><label class="field">Opponent address (optional)<input id="online-opponent" autocomplete="off" spellcheck="false" placeholder="Anyone can accept" value="' +
          esc(rival) +
          '"></label><p>Reserve for a friend, then share the match link. They won’t receive an invitation notification.</p>',
        btn("Choose your clan", "Compose"),
      );
    } else if (name === "Compose") {
      const field = app.querySelector("#online-opponent");
      if (field === null) throw new Error("The lobby has no opponent field.");
      const opponent = field.value.trim();
      close();
      compose("challenge", opponent);
    } else if (name === "Accept") compose("accept");
    else if (name === "Play" || name === "Review") {
      await run(async () => {
        const raw = await online().match(openView().id);
        model.view = viewFor(raw);
        if (name === "Play" && model.view.action !== "move")
          throw new Error("This match moved on. Refresh to see its current state.");
        await onPlay(raw, address(), name === "Review");
        model.inGame = true;
        cancelWatch();
      });
    } else if (name === "Resign")
      dialog(
        openView().phase === "open" ? "Withdraw this challenge?" : "Resign this match?",
        `<p>${openView().phase === "open" ? "Nobody will be able to accept it." : "This records a loss. Your opponent wins."}</p>`,
        btn("Keep playing", "Close", false, true) + btn("Confirm", "ResignConfirm"),
      );
    // The realm deletes a withdrawn challenge, so neither a view nor a watch outlives it.
    else if (name === "ResignConfirm") {
      close();
      const { id, phase } = openView();
      if (phase === "open") cancelWatch();
      await run(async () => {
        await online().resign(id);
        if (phase === "open") {
          leaveMatch();
          await lists();
        } else await refreshView(id);
      });
    } else if (name === "Claim" || name === "Finish") {
      await run(async () => {
        if (!ready()) {
          model.account = await online().authorize();
          if (!ready()) throw new Error("Approve this device to continue.");
        }
        const id = openView().id;
        await (name === "Claim" ? online().claimForfeit(id) : online().finish(id));
        await showEnding(await refreshView(id));
      });
    } else if (name === "Notify") {
      await run(async () => {
        await online().notify();
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
        if (arena !== null) await lists();
      });
      if (arena !== null && id !== undefined && id !== "") await open(matchId(id));
    },
    async sendDraft(context, clan, deck, plan) {
      if (arena === null) throw new Error("Online play is not connected.");
      if (!ready())
        throw new Error("This device needs approval. Return to the board and approve it; your plan is preserved.");
      const id = context.view?.id ?? matchId("");
      let turn: number | undefined;
      if (id !== "") {
        const before = viewFor(await arena.match(id));
        if (!waitsFor(context, before)) throw new Error("This match moved on. Refresh it before sending.");
        turn = turnOf(before);
      }
      if (context.intent === "move") await arena.move(id, plan);
      else
        try {
          if (context.intent === "accept") await arena.accept(id, { clan, deck, plan });
          else {
            const posted = await arena.challenge({ clan, deck, plan, opponent: context.opponent ?? "" });
            if (posted !== "") model.view = viewOf({ ID: posted }, address());
          }
        } finally {
          model.account = arena.account();
        }
      if (turn !== undefined) sent.set(id, turn);
      model.inGame = false;
      model.draft = null;
      model.error = "";
      model.notice = "Your move is confirmed.";
      try {
        const sentIn = id !== "" ? id : model.view?.id;
        if (sentIn !== undefined && sentIn !== "") {
          await refreshView(sentIn);
          watchView(sentIn);
        }
        await lists();
      } catch {
        leaveMatch();
        model.matches = model.matches.map(reconciled);
        model.challenges = model.challenges.filter((v) => !sent.has(v.id));
        model.notice = "Your move was confirmed. Refresh the board to see it; do not send it again.";
      }
    },
    async returnToBoard() {
      model.inGame = false;
      changed();
      if (model.view !== null && model.view.id !== "") await open(model.view.id);
    },
    report: fail,
  };
}
