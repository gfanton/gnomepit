// Review prototype only: all account, match and challenge data is fictional.

import { elementById } from "./dom.ts";

const app = elementById("app", HTMLElement);
const states = [
  "Lobby",
  "Empty hall",
  "No wallet",
  "Wrong network",
  "Not connected",
  "Signature needed",
  "Session needed",
  "Session expiring",
  "Session expired",
  "Sending move",
  "Move failed",
  "Challenge waiting",
  "Challenge withdrawn",
  "Challenge expired",
  "Claim forfeit",
  "Claim sending",
  "Won",
  "Lost",
  "Draw",
  "Notifications asking",
  "Notifications on",
  "Notifications refused",
  "Card file mismatch",
];
let state = new URLSearchParams(location.search).get("state") ?? "Lobby";
if (!states.includes(state)) state = "Lobby";
const address = "g1…7m4q";
const fullAddress = "g1demoaddress7m4q";
const portrait = (iron = false) =>
  `<img class="portrait ${iron ? "portrait--iron" : ""}" src="art/${iron ? "ironhide" : "pickers"}-portrait-v2.jpg" alt="${iron ? "Ironhide" : "Pickers"} champion">`;
const copy = () =>
  `<span class="address">${address}</span> <button class="copy-address" data-action="copy" aria-label="Copy opponent address">Copy</button>`;
const button = (label: string, action: string, secondary = false) =>
  `<button class="${secondary ? "quiet" : "button"}" data-action="${action}">${label}</button>`;
function match(status: string, round: number, time: string, action: string, turn = false): string {
  return `<article class="match ${turn ? "match--turn" : ""}"><div class="match-top"><span class="status">${status}</span><small>Round ${round} / 3</small></div><div class="fighters">${portrait()}<span class="versus">vs</span>${portrait(true)}<div class="opponent"><strong>Ironhide</strong><div>${copy()}</div></div></div><div class="match-bottom"><div><strong>${time}</strong><br><small>${turn ? "Your deadline" : "Opponent’s deadline"}</small></div>${button(turn ? "Take your turn" : "View match", action, !turn)}</div></article>`;
}
function challenge(iron: boolean, reserved = false): string {
  return `<article class="challenge ${iron ? "challenge--iron" : ""}"><div class="match-top"><div><div class="eyebrow">${reserved ? "Reserved for you" : "Open challenge"}</div><div class="clan-name">${iron ? "Ironhide" : "Pickers"}</div></div><span class="notice-mark" aria-hidden="true">${iron ? "⛨" : "⚒"}</span></div><p>Posted by ${copy()}</p><div class="match-bottom"><small>Expires in ${reserved ? "2" : "6"} days</small>${button("Accept challenge", iron ? "acceptIron" : "acceptPick", true)}</div></article>`;
}
function notice(): string {
  // Each state's title and text, and the label and action of its button when it has one.
  const messages: Record<string, [string, string, string?, string?]> = {
    "Session expiring": [
      "Session expires tomorrow",
      "Renew to keep sending moves without wallet pop-ups.",
      "Renew session",
      "setup",
    ],
    "Session expired": [
      "Your session has expired",
      "Approve a new seven-day session to send your next move.",
      "Renew session",
      "setup",
    ],
    "Sending move": ["Sending your move…", "Waiting for confirmation. Keep this page open."],
    "Move failed": [
      "Your move wasn’t sent",
      "Network error. Your plan is still here; try sending it again.",
      "Retry move",
      "retry",
    ],
    "Challenge waiting": [
      "Your challenge is on the board",
      "Pickers · Reserved for g1…7m4q · Expires in 7 days. Share the link; your friend won’t be notified.",
      "Copy invite link",
      "invite",
    ],
    "Challenge withdrawn": ["Challenge withdrawn", "This challenge is no longer available.", "Post another", "post"],
    "Challenge expired": ["Challenge expired", "Nobody accepted within seven days.", "Post another", "post"],
    "Claim forfeit": ["Opponent missed their deadline", "Claim the win to finish this match.", "Claim win", "claim"],
    "Claim sending": ["Claiming your win…", "Waiting for confirmation."],
    Won: ["You won", "Round 3 · Pickers 14 HP · Ironhide 10 HP. Higher HP wins.", "Challenge them again", "rematch"],
    Lost: ["You lost", "Your move deadline passed. This match ended by forfeit.", "Challenge them again", "rematch"],
    Draw: ["An even score", "Round 3 · Both clans finished with 8 HP.", "Challenge them again", "rematch"],
    "Notifications asking": [
      "Allow notifications in your browser",
      "Get notified when your opponent moves and when a match ends.",
    ],
    "Notifications on": [
      "Notifications are on",
      "You’ll hear when your opponent moves or a match ends. Deadline reminders are not sent.",
    ],
    "Notifications refused": [
      "Notifications are blocked",
      "Allow notifications for this site in your browser settings, then try again.",
      "Try again",
      "notify",
    ],
    "Card file mismatch": [
      "The game needs an update",
      "This page’s cards don’t match the chain’s engine. Online play is paused. Reload the page to check for an update.",
      "Reload page",
      "reload",
    ],
  };
  const n = messages[state];
  return n !== undefined
    ? `<section class="notice ${["Move failed", "Card file mismatch", "Lost"].includes(state) ? "notice--danger" : ""}" role="status"><div><strong>${n[0]}</strong><p>${n[1]}</p></div>${n[2] !== undefined && n[3] !== undefined ? button(n[2], n[3], true) : ""}</section>`
    : "";
}
function render(): void {
  const needsSetup = ["No wallet", "Wrong network", "Not connected", "Signature needed", "Session needed"].includes(
    state,
  );
  const sessionLabel =
    state === "Session expired"
      ? "Session expired"
      : state === "Session expiring"
        ? "Session expires tomorrow"
        : "Session active · 6 days left";
  app.innerHTML = `<aside class="review-bar" aria-label="Prototype controls"><span><strong>Design preview</strong> · Sample data, no wallet calls</span><label>Preview state <select id="state">${states.map((s) => `<option ${s === state ? "selected" : ""}>${s}</option>`).join("")}</select></label></aside>
 <header class="masthead"><a class="wordmark" href="index.html">Gnomehall<span>UNDER THE MOUNTAIN</span></a><div class="account">${button(needsSetup ? "Connect wallet" : "g1…9k2r · Account", "setup", true)}<small>${needsSetup ? "Online play needs Adena" : sessionLabel}</small></div></header>
 <section class="hall-banner"><img src="art/hall-hero-v2.jpg" alt=""/><div class="copy"><span class="eyebrow">THE CHALLENGE BOARD</span><h1>A rival awaits.</h1><p>Settle a grudge in three rounds. Play together tonight, or take turns over a few days. Each move has a 24-hour deadline.</p><div class="banner-actions">${button("Post a challenge", needsSetup ? "setup" : "post")}${button(state === "Notifications on" ? "Notifications on" : "Notify me", "notify", true)}</div></div></section>
 ${notice()}${needsSetup ? `<section class="notice"><div><strong>${state === "No wallet" ? "You’ll need the Adena wallet" : state === "Wrong network" ? "Switch to the game’s network" : "Connect to join the hall"}</strong><p>Browse challenges now. Connect your wallet when you’re ready to play.</p></div>${button("Set up online play", "setup")}</section>` : ""}
 <div class="lobby-columns"><section aria-labelledby="matches-title"><div class="section-head"><div><h2 id="matches-title">My matches</h2><p>${needsSetup ? "Connect to see your matches" : "One grudge needs your attention"}</p></div><span> ${needsSetup ? "" : "3 matches"}</span></div><div class="match-list">${state === "Empty hall" || needsSetup ? `<div class="empty"><h3>Your first grudge starts here.</h3><p>${needsSetup ? "Connect your wallet to find and resume matches." : "Accept a challenge or post one of your own."}</p>${button(needsSetup ? "Connect wallet" : "Post a challenge", needsSetup ? "setup" : "post")}</div>` : match("Your move", 2, "18h 42m left", "turn", true) + match("Waiting for Ironhide", 1, "22h 16m left", "wait") + `<article class="match"><div class="match-top"><span class="status">Awaiting a rival</span><small>Pickers</small></div><p>Your challenge · Anyone can accept</p><div class="match-bottom"><small>Expires in 5 days</small>${button("Manage challenge", "manage", true)}</div></article>`}</div></section>
 <section aria-labelledby="challenges-title"><div class="section-head"><div><h2 id="challenges-title">Open challenges</h2><p>Choose a rival. Bring your own deck.</p></div><small>Newest first</small></div><div class="challenge-list">${state === "Empty hall" ? `<div class="empty"><h3>The board is quiet.</h3><p>Leave a challenge for the next gnome through the door.</p>${button("Post a challenge", "post")}</div>` : challenge(true) + challenge(false) + challenge(true, true)}</div></section></div>
 <footer class="footer"><span>No stakes. Just grudges.</span><a href="index.html">Practice against the bot or play at the same table →</a></footer>
 <dialog id="detail" aria-labelledby="dialog-title"></dialog><div id="announcement" role="status" aria-live="polite"></div>`;
  if (state === "Card file mismatch")
    app.querySelectorAll("[data-action]").forEach((b) => {
      if (
        b instanceof HTMLButtonElement &&
        ["post", "acceptIron", "acceptPick", "turn"].includes(b.dataset.action ?? "")
      )
        b.disabled = true;
    });
  elementById("state", HTMLSelectElement).addEventListener("change", (e) => {
    if (!(e.target instanceof HTMLSelectElement)) return;
    state = e.target.value;
    history.replaceState(null, "", `?state=${encodeURIComponent(state)}`);
    render();
    elementById("state", HTMLSelectElement).focus();
  });
}
function dialog(title: string, body: string, actions = ""): void {
  const d = elementById("detail", HTMLDialogElement);
  d.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${title}</h2>${button("Close", "close", true)}</div>${body}<div class="dialog-actions">${actions}</div>`;
  d.showModal();
}
function toast(message: string): void {
  elementById("announcement", HTMLDivElement).innerHTML = "";
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  elementById("announcement", HTMLDivElement).append(t);
  setTimeout(() => t.remove(), 4000);
}
// onClick runs a preview button's action; only a copy waits, for the clipboard.
async function onClick(e: MouseEvent): Promise<void> {
  const b = e.target instanceof Element ? e.target.closest("[data-action]") : null;
  if (!(b instanceof HTMLElement)) return;
  const a = b.dataset.action;
  if (a === "close") {
    elementById("detail", HTMLDialogElement).close();
    return;
  }
  if (a === "setup" && !needsConnection() && state !== "Session expiring") {
    dialog(
      "Your account",
      `<p>Connected as g1…9k2r.</p><p>${state === "Session expiring" ? "Session expires tomorrow." : "Your session is active for six more days."}</p><p>Gnomehall moves can be sent without another wallet pop-up until your session expires.</p>`,
      button("Renew session", "renew", true),
    );
    return;
  }
  if (a === "renew") {
    state = "Session expired";
    elementById("detail", HTMLDialogElement).close();
    render();
    return;
  }
  if (a === "setup") {
    const no = state === "No wallet",
      wrong = state === "Wrong network";
    dialog(
      no ? "Adena opens the door" : wrong ? "Choose the game’s network" : "Your wallet. Fewer interruptions.",
      no
        ? "<p>Install the Adena browser wallet, then return here to connect.</p>"
        : wrong
          ? "<p>Your wallet is on a different network. Switch to the network used by this game to continue.</p>"
          : '<p>Two approvals the first time. After that, send your moves without a wallet pop-up for seven days.</p><ol class="steps"><li><strong>1 · Sign once on this device</strong><p>This lets the page keep your hidden plans private and recover them on this device.</p></li><li><strong>2 · Approve a seven-day session</strong><p>The page can sign Gnomehall moves for you. Fees count toward a 10 GNOT session limit. Your wallet still approves setup and renewal.</p></li></ol>',
      button(
        no
          ? "Preview wallet installed"
          : wrong
            ? "Preview network switched"
            : state === "Signature needed"
              ? "Approve signature"
              : state === "Session needed" || state === "Session expired"
                ? "Approve session"
                : "Begin setup",
        "setupNext",
      ),
    );
  } else if (a === "setupNext") {
    elementById("detail", HTMLDialogElement).close();
    state = ["Session needed", "Session expired"].includes(state)
      ? "Lobby"
      : state === "Signature needed"
        ? "Session needed"
        : "Signature needed";
    render();
  } else if (a === "post" || a === "rematch")
    dialog(
      "Leave a challenge",
      `<p>Choose your clan, build your eight-card deck, then plan the first round.</p><label class="field">Opponent address (optional)<input id="reserved" placeholder="Anyone can accept" ${a === "rematch" ? `value="${fullAddress}"` : ""}></label><small>Reserve it for a friend, then share the match link. They won’t receive an invitation notification.</small>`,
      button("Continue to clan selection", "handoff"),
    );
  else if (a === "acceptIron" || a === "acceptPick") {
    const iron = a === "acceptIron";
    dialog(
      "Answer the challenge",
      `${portrait(iron)}<p><strong>${iron ? "Ironhide" : "Pickers"}</strong> · ${copy()}</p><p>You know their clan. Their deck stays hidden until round 2.</p><p>Choose your clan, build your deck, and plan round 1 before accepting. Once accepted, each move has a 24-hour deadline.</p>`,
      button(needsConnection() ? "Connect wallet" : "Choose your clan", needsConnection() ? "setup" : "handoff"),
    );
  } else if (a === "handoff") {
    elementById("detail", HTMLDialogElement).close();
    toast("Prototype handoff: continue into the existing clan, deck and planning screens.");
  } else if (a === "turn")
    dialog(
      "Your move · Round 2",
      "<p>18h 42m left to send your next plan.</p><p>First watch the last round’s clash, then choose your next three beats.</p>",
      button("Watch clash & plan", "handoff"),
    );
  else if (a === "wait")
    dialog(
      "Waiting for Ironhide",
      "<p>They have 22h 16m left to play.</p><p>Your plan is sealed: they can’t see it until they’ve played theirs.</p><p>Review the clash so far while you wait.</p>",
      button("Review match", "handoff") + button("Resign match", "resign", true),
    );
  else if (a === "resign")
    dialog(
      "Resign this match?",
      "<p>This records a loss. Your opponent wins.</p>",
      button("Keep playing", "close", true) + button("Resign", "resignConfirm"),
    );
  else if (a === "resignConfirm") {
    elementById("detail", HTMLDialogElement).close();
    state = "Lost";
    render();
    const note = document.querySelector(".notice p");
    if (note === null) throw new Error("The Lost notice has no text");
    note.textContent = "You resigned. Your opponent wins.";
  } else if (a === "manage")
    dialog(
      "Your challenge",
      "<p>Pickers · Open to anyone · Expires in 5 days.</p><p>Share the match link to invite someone.</p>",
      button("Copy invite link", "invite") + button("Withdraw challenge", "withdraw", true),
    );
  else if (a === "withdraw") {
    elementById("detail", HTMLDialogElement).close();
    state = "Challenge withdrawn";
    render();
  } else if (a === "notify")
    dialog(
      "Hear when your rival moves",
      "<p>Allow browser notifications for opponent moves and match results, even with this page closed.</p><p>No deadline reminders are sent. Check your countdown to avoid forfeiting.</p>",
      button("Preview allowed", "notifyAllowed") + button("Preview blocked", "notifyBlocked", true),
    );
  else if (a === "notifyAllowed" || a === "notifyBlocked") {
    elementById("detail", HTMLDialogElement).close();
    state = a === "notifyAllowed" ? "Notifications on" : "Notifications refused";
    render();
  } else if (a === "claim" || a === "retry") {
    state = a === "claim" ? "Claim sending" : "Sending move";
    render();
  } else if (a === "reload") location.reload();
  else if (a === "copy" || a === "invite") {
    try {
      await navigator.clipboard.writeText(
        a === "copy" ? fullAddress : `${location.origin}/lobby-preview.html?state=Challenge%20waiting`,
      );
      toast(a === "copy" ? "Sample address copied" : "Prototype invite link copied");
    } catch {
      toast("Clipboard unavailable. Copy from the preview address or browser URL.");
    }
  }
}
app.addEventListener("click", (e) => void onClick(e));
function needsConnection(): boolean {
  return [
    "No wallet",
    "Wrong network",
    "Not connected",
    "Signature needed",
    "Session needed",
    "Session expired",
  ].includes(state);
}
render();
