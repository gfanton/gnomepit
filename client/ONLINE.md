# Online play

Online matches run through the arena realm, `r/arena`, on a gno chain. The page reads the realm, signs each match's moves with a session key of its own, and replays each round with its own engine. `client/web/arena.ts` is the one module a lobby needs.

## Run a local chain

Every command below runs in the flake's dev shell: `direnv allow` once, or `nix develop`. It provides Go, TinyGo, Node, pnpm, jq, gno, gnokey and gnodev built from gno's `chain/onyx` tag, and gnotifd built from the gnotif revision the flake pins.

1. `make dev` starts gnodev with the engine, the gnotif registry and its trigger package, on the chain `gnomepit-dev`, then deploys the arena in a transaction from gnodev's test1 account. tx-indexer files genesis transactions at height 0, where gnotifd never reads, so the arena's triggers have to land in a block. The RPC listens on `127.0.0.1:36657` and gnoweb on `127.0.0.1:8890`. It copies the registry from the gnotif revision the flake pins, or from the checkout `GNOTIF_DIR` names. It funds four dev accounts, alice, bob, carol and dave, with 10,000 GNOT each.
2. `make indexer` runs tx-indexer v1.3.0 on that chain, answering on `127.0.0.1:8546`. gnotifd reads the chain through it.
3. `make gnotif` runs gnotifd on `127.0.0.1:8547`, reading the chain through `make indexer`. The page learns of the other player's moves and of the board's changes from it. It makes new VAPID keys and an empty database in `.gnotif/` each time.
4. `make serve` builds `engine.wasm` with TinyGo and bundles the pages with esbuild into `dist/`, then serves `dist/` on `http://127.0.0.1:8080/`. `GNOMEPIT_NETWORK` picks the network the build targets: `local` by default, `onyx` for the arena on onyx, or `offline` for a page with no online play. `make e2e` and `make test` build the engine too.
5. Open `http://127.0.0.1:8080/?dev=alice` in one browser and `?dev=bob` in another, then **Play online**: the lobby, with a dev wallet in place of Adena. Without `dev`, the lobby uses Adena.
6. `online-dev.html?dev=alice` and `?dev=bob` open a bare console instead, which picks decks and plans at random. Add `&contract=1` to have the wallet sign every move instead of a session, and `&gnotif=` with no value to poll the node instead of following gnotifd.
7. `make e2e` plays from node, with `make indexer` and `make gnotif` running:
   - **A match through sessions.** Alice and bob each sign through a session of their own. `Locks` lists each player's lock on the match after their opening, and a second challenge signed with alice's locked session fails with `session locked to match 1`. So does a resignation signed with it in match 2, which alice's wallet posts and nobody accepts. Alice's sessions last 30 seconds, so hers expires after round 1: her match's `session` reads `expired`, and she renews it to finish.
   - **A second challenge.** Alice posts again and gets a new session, which revokes the session of the ended match. Nobody accepts it.
   - **A match the wallet signs.** Both players sign every move with the wallet, which locks no session.

   It also checks that each player's live feed reports their Board, Turn and Ended notifications, in chain order, then has alice withdraw the two challenges nobody accepted.

gnodev keeps the chain in memory, so a restart starts from an empty arena. Start `make indexer` again after one, since its index holds the old heights, then `make gnotif`. gnodev watches no files: a reload would replay the chain's transactions at genesis, the arena's deploy among them, where gnotifd never sees its triggers. A change to the engine, the gnotif registry or the arena needs a new `make dev`.

## Check Adena

`adena-check.html` tests what only a person can approve in Adena: a stable root signature, a session, a session revoked beside the one created, and a move Adena signs.

1. Run `make dev` and `make serve`, and install Adena 1.22.3 or later.
2. Open `http://127.0.0.1:8080/adena-check.html`. Click **Add the gnodev network to Adena** and approve, then **Connect**.
3. Run `make fund ADDRESS=<your Adena address>`; it sends 1,000 GNOT from gnodev's test account.
4. Run checks 1 to 4. For check 1, run it again in another browser profile with the same wallet: the signature it prints must be the same. Check 4 withdraws a challenge it posts, which leaves that challenge's session dead, so its second post's approval revokes the dead session as it creates the next one.

Rejecting check 2's approval cancels its post. When Adena cannot create the session, check 2 prints Adena's reason, and the arena falls back to check 3's path: Adena approves each move.

## How a match reaches the chain

- **The root signature.** On each device the player signs one fixed text naming the site with `SignArbitrary`. The same wallet gives the same signature everywhere. HKDF-SHA256 derives two keys from it: a session key per generation (`gnomepit session <n>`) and a box key (`gnomepit box`). The page keeps the signature in local storage.
- **A session per match.** Adena approves one session for each post or accept, and one for each renewal. That transaction revokes the player's dead sessions and creates a session for a free generation, or for a revoked one when none is free. The session may call the arena alone, spend its side's budget, and lasts one day; its spending counts gas fees and storage deposits. The realm locks it to the match of its first call, after which it acts in no other match and posts or accepts nothing more. A session is dead once it has expired, has less left than the costliest move it may still pay, or is locked to a match that ended or that the realm no longer knows.
- **Renewal.** When the player has no live session locked to a match, nor an unlocked one to lock, the next move there needs a renewal: `renew(id)` asks Adena for a session the same way, and the move locks it to the match. Resigning and claiming a forfeit need none: with no live session, the wallet signs that one call, in one approval.
- **Boxes.** A challenger's sealed deck and plans travel to the chain encrypted with the box key, beside their seals. Any browser with the same wallet opens them, so a challenger can continue from another device.
- **A rejected approval.** When the player rejects the session's approval or closes Adena's window, Adena answers `TRANSACTION_REJECTED`. The challenge, acceptance or renewal throws `refused` and sends nothing, and the next one asks for a session again.
- **The fallback.** When Adena answers that it cannot create the session, or every generation holds a live session, Adena signs and sends each call through `DoContract`, except in a match that has a live session locked to it, which keeps signing with that session. The account state's `fallback` holds the reason, and after `resumeSessions()` the next challenge, acceptance or renewal asks for a session again.
- **Confirmed in a block.** Every `DoContract` asks Adena, with `commit: true`, to answer once the transaction's block is committed, with its `deliver_tx`, as a session's broadcast does. Adena reads that field since its session release without documenting it; an older Adena answers once CheckTx passes, with no result.

## Live updates

The node pushes nothing, so the page follows the arena through a gnotif server's live stream: one WebSocket per page, opened when the board or a match first subscribes and closed when the last stops. The arena sets three triggers in gnotif's registry: Turn and Ended name the player they notify in `to`, and Board, which names nobody, tells of a challenge posted, taken or withdrawn. The page opts in to Board as soon as it subscribes, and to Turn and Ended for the connected wallet's address. Each notification names a match and is a hint: the page reads that match again, and the board reads its lists again. A notification arrives once gnotifd has read its block through its indexer, which `make gnotif` has it ask every second.

The stream replays nothing it sent while no connection was open, so each time the connection opens the page reads everything it shows again. While gnotifd cannot list the arena's triggers, refuses the connection, or the connection is down, `subscribe` polls the node instead: it reports a change every 4 s, and the page reads again what it shows. The page does the same with no gnotif server at all.

The connection sends the gnotif server the page's opt-ins: the ids of the triggers it follows and, once a wallet is connected, the player's address. Push carries only Turn and Ended, for the address whose player turned it on with Notify me. The page remembers that address for its chain, and gnotif keeps one set of opt-ins for both channels, so every set the page sends keeps it: a later visit, with another wallet or none, leaves that player's push on. The connected wallet's own Turn and Ended reach the open page only, until its player turns push on.

## Modules

| Module | Job |
|---|---|
| `arena.ts` | The account state, the board, a player's matches, one match with its action, and every move |
| `arena-provider.ts` | The arena the lobby (`lobby.ts`, `online-model.ts`) plays through, built from the page's query string |
| `wallet.ts` | Connecting a wallet, the root signature, key derivation, sessions and boxes |
| `chain.ts` | JSON-RPC to the node: queries, accounts, sessions, simulation, broadcast, and `payFor` |
| `gnovalue.ts` | Decoding `vm/qeval_json` answers into plain objects |
| `devwallet.ts` | A wallet with Adena's calls and public dev keys, for local chains only |
| `encoding.ts` | Hex and base64 |
| `engine.ts` | The engine's rules, from `engine.wasm` |
| `signer.ts` | `keyInfo`, `signTx` and `signBytes`: keys, transactions and signed documents |
| `gnotif.js`, `gnotif.d.ts`, `sw.js` | gnotif's browser client, its types and its service worker |

## Signer

`signer.ts` gives `keyInfo`, `signTx` and `signBytes` on the official gno JS clients, `@gnolang/tm2-js-client` 3.3.0 and `@gnolang/gno-js-client` 3.1.0. `make build` bundles them into each page that signs, with shims for the Node `Buffer` and `crypto` they call, so the page loads no code from a CDN. `make golden` signs five requests with the chain's own Go types into `testdata/golden-tx.json`, and the tests check that `signer.ts` gives the same bytes. After changing a pin in `package.json`, update `pnpm-lock.yaml` with `pnpm install`. Run `make golden` after changing a request in `client/golden` or its gno version, pinned at `c97fd36` in `client/golden/go.mod`. `signTx` refuses a request the chain would refuse: no chain id, no message, an account number or sequence that is not a non-negative integer, a `sessionAddr` other than the signing key's own address, or a session with no spend limit.

`engine.wasm` holds the engine alone, built with TinyGo and loaded with TinyGo's own `wasm_exec.js`: 1,097,496 bytes, 402,716 gzipped.

## The arena API

```js
const arena = createArena({ chain, wallet, engine, signer, realm, chainId, origin, storage, notifier, offerPush, network, signEachMove, sessionLifetime });
```

`chain` comes from `createChain({ rpc })`, `wallet` is `window.adena` or a `devWallet`, or a promise of either while the page still looks for Adena (`loadArena` passes `pageWallet`'s promise, so the page draws before the search ends), `engine` from `loadEngine`, `signer` is `signer.ts` (`import * as signer`), `storage` is `localStorage`, and `notifier` a gnotif `Gnotif` for a gnotif server, such as `http://127.0.0.1:8547`. Without `notifier`, `subscribe` polls the node. `offerPush: false` keeps push off while `subscribe` still follows the live stream: `loadArena` passes it when `?realm=` or `?gnotif=` names another, since the gnotif server holds the push subscription it registers and the realm's triggers write what it pushes. `signEachMove` skips sessions. `sessionLifetime` is how long each new session lasts, in seconds, one day unless given. `network`, `{chainName, rpcUrl}`, lets `connect()` add the chain to a wallet that does not know it; `loadArena` passes it for its default chain only, named by its chain ID, and passes none when `?chain=` or `?rpc=` names another, so an RPC address from a link never enters the wallet.

| Call | Returns or does |
|---|---|
| `connect()` | `{state, address, mode, fallback}`. `state` is `noWallet`, `wrongNetwork`, `missing` (this device has not authorized) or `active`. `noWallet` and `wrongNetwork` return `{state, reason}` and no address. When the wallet does not know the chain and `network` is set, it asks Adena's `AddNetwork` first, then switches; `wrongNetwork` means Adena could not or would not add it. |
| `hasWallet` (property) | `true` when a wallet was found in this browser, and while the search for one still runs, since `connect()` waits for it. The board's setup panel starts at installing Adena otherwise. |
| `walletSearch` (property) | Settles when the search for a wallet ends, whatever it found. The board redraws then, or once an open dialog closes. |
| `canNotify` (property) | `true` when the arena has a notifier and `offerPush` is not `false`; otherwise `notify()` can only fail, so the board hides Notify me. |
| `authorize()` | Asks for the root signature once per device; returns the new state |
| `account()` | The account state `connect()` gives, without asking the wallet. `mode` is `contract` once the wallet could not create a session for a challenge, acceptance or renewal, or no generation was free. |
| `resumeSessions()` | Leaves the per-move fallback, so the next challenge, acceptance or renewal asks for a session again; returns the new state |
| `openChallenges(page)` | Open challenges, newest first, 50 a page, each with `action` (`accept`, `wait` for one's own, `done`) |
| `myMatches(page)` | This player's matches, newest first, each with `action` and `deadline` |
| `match(id)` | The match view, plus `rounds` (each resolved round replayed: plans, events, state, result), `state`, `pending` (the challenger's next clash, when it is their move), `planning` (`{state, side, deck}` to plan from when the action is `move`), `action`, `session`: `expired` when the player must call `renew(id)` before acting, `active` otherwise, and `sessionExpires`: the expiry, in Unix seconds, of the session that signs the player's next call, when one does |
| `challenge({clan, deck, plan, opponent})` | Posts a challenge and returns the id its call returns, or `""` from an Adena that answers before the call's block. Deck and plan are card ids. |
| `accept(id, {clan, deck, plan})` | Accepts a challenge |
| `renew(id)` | Asks the wallet for a new session for the player's side of match `id`, revoking the dead ones, unless a live unlocked session has that side's budget left. It sends no move: the next one locks the session. |
| `move(id, plan)` | Sends this player's turn: the challenger's reveal and next seal in one call, or the acceptor's plan |
| `finish(id)` | Sends the challenger's last reveal, after round 3 or a knockout |
| `resign(id)`, `claimForfeit(id)` | Resigns or withdraws; claims a passed deadline. With no live session for the match, the wallet signs the call. |
| `subscribe(onChange)` | Calls `onChange({match, event, height})` for each notification the page follows, `event` being `Turn`, `Ended` or `Board`, for the match the event names, and `onChange({})` when anything may have changed: each time the live connection opens, and on every poll of the node. Returns a stop function. |
| `watch(id, onChange)` | Calls `onChange(view)` whenever match `id` changes, reading it again on each change `subscribe` reports for it and at `sessionExpires`; returns a stop function |
| `notify()` | Opts the browser in to the arena's Turn and Ended notifications for this wallet, by push, and remembers the address for later visits; call it from a click |

`challenge`, `accept` and `move` check the deck and plan with the engine first: a deck or plan it refuses throws `illegalPlan` before anything is sealed or sent. Moves go out one at a time, so two calls in a row never sign with the same sequence.

`challenge` and `accept` sign with an unlocked session that has the side's budget left. Without one, they first ask the wallet, in one approval, to revoke the dead sessions and create one: expired or used-up sessions, and those locked to a match that ended or is gone. A rejected approval throws `refused` and sends nothing. Their call locks the session to the match. Every later call in the match signs with the live session locked to it or, when there is none, with any live unlocked session, such as the one `renew` creates, which that call locks. Without either, `move` and `finish` throw `sessionExpired`, while `resign` and `claimForfeit` have the wallet sign: a claimer's session always ends before the deadline it claims. In the per-move mode, every call without a live session locked to its match has the wallet sign.

An action is `accept`, `move`, `finish`, `claimForfeit`, `wait` or `done`. A failed call throws an `ArenaError` whose `type` is one of `noWallet`, `wrongNetwork`, `refused`, `unauthorized`, `wrongPhase`, `sealMismatch`, `illegalPlan`, `deadlinePassed`, `sessionExpired`, `insufficientFunds`, `outOfStep`, `network` or `failed`, with a readable `reason`. `outOfStep` means the page's card file differs from the deployed engine.

## Storage per move

`scripts/measure-storage.ts` has alice and bob play the realm test's worked match twice on a fresh `make dev`, built from gno `5cdbc25` (the `chain/onyx` tag), with gas at 1 ugnot per 1,000 and storage at 100 ugnot per byte, then a third match that bob resigns after round 1, then carol and dave play the worked match. Each player signs through a session for the match, as the page does.

- **Storage** is the bytes the move adds to the storage of the arena and the standings realm together, negative when it frees more than it adds.
- **Gas used** is the gas the transaction used.
- **Fee** is what the page pays for it: the gas used, plus a fifth and 100,000, at the chain's price.
- **Deposit** is the ugnot the move locks for the storage it adds. A move that frees storage locks nothing and gets 100 ugnot back per byte.

The first match is the chain's first, so it carries the one-time costs:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 2,445 B | 17,491,231 | 21,090 ugnot | 244,500 ugnot |
| Accept | 2,153 B | 28,442,030 | 34,231 ugnot | 215,300 ugnot |
| Reveal, round 1 | -69 B | 48,498,891 | 58,299 ugnot | 0 ugnot |
| Play, round 2 | 1 B | 20,629,928 | 24,856 ugnot | 100 ugnot |
| Reveal, round 2 | 0 B | 35,053,861 | 42,165 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 20,393,822 | 24,573 ugnot | 0 ugnot |
| Reveal, round 3 | 8,661 B | 40,026,942 | 48,133 ugnot | 876,100 ugnot |
| Total | 13,191 B | 210,536,705 | 253,347 ugnot | 1,336,000 ugnot |

The second match is between players who already have a record and a rating, inside the chunk the first match opened:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 319 B | 18,533,632 | 22,341 ugnot | 31,900 ugnot |
| Accept | 82 B | 29,102,189 | 35,023 ugnot | 8,200 ugnot |
| Reveal, round 1 | -71 B | 48,623,200 | 58,448 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 20,513,805 | 24,717 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 35,255,090 | 42,407 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 20,595,358 | 24,815 ugnot | 0 ugnot |
| Reveal, round 3 | 1,991 B | 42,145,585 | 50,675 ugnot | 208,900 ugnot |
| Total | 2,321 B | 214,768,859 | 258,426 ugnot | 249,000 ugnot |

The third match ends with bob's resignation after round 1:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 262 B | 18,735,396 | 22,583 ugnot | 26,200 ugnot |
| Accept | 32 B | 29,326,186 | 35,292 ugnot | 3,200 ugnot |
| Reveal, round 1 | -71 B | 48,762,671 | 58,616 ugnot | 0 ugnot |
| Resign | 2,028 B | 22,345,858 | 26,916 ugnot | 212,600 ugnot |
| Total | 2,251 B | 119,170,111 | 143,407 ugnot | 242,000 ugnot |

The fourth match is carol's and dave's first, on a ladder that already holds alice and bob:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 2,384 B | 18,658,675 | 22,491 ugnot | 238,400 ugnot |
| Accept | 2,154 B | 29,304,561 | 35,266 ugnot | 215,400 ugnot |
| Reveal, round 1 | -71 B | 48,908,299 | 58,790 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 20,762,195 | 25,015 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 35,493,941 | 42,693 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 20,841,644 | 25,110 ugnot | 0 ugnot |
| Reveal, round 3 | 10,224 B | 43,486,321 | 52,284 ugnot | 1,032,200 ugnot |
| Total | 14,691 B | 217,455,636 | 261,649 ugnot | 1,486,000 ugnot |

From one run to the next, a move's gas used differs by up to about 50,000, while its storage stays the same.

A finished match between known players keeps 2,321 bytes locked. Its last reveal adds 2,089 of them to the standings realm, which logs the result and moves both players on its ladder, and frees 98 in the arena; the third match's resignation adds 2,126 there. The arena keeps the other 232 bytes, the players' two 48-byte session locks included. Each record keeps its lock until that session expires, and the player's next session-signed call then drops it. The match's moves lock 249,000 ugnot, and its reveals give back 16,900 as they drop the deck seal, shrink the box and finally clear the seal and the box.

The one-time costs, the first match minus the second, are 10,870 bytes and a 1,087,000 ugnot deposit. The challenge carries 2,126 bytes of them: alice's new player record and the arena's first chunk. The acceptance carries 2,071 bytes: bob's new player record. The last reveal carries 6,670 bytes: the move that ends both players' first rated match stores their standings, their ladder entries and the clan records in the standings realm, along with its first logged result.

The ladder grows by more once it holds players. It is a tree whose players sit at the leaves, so the first two players take three nodes and every later player two. The fourth match's last reveal, the first rated match of two new players on that ladder, deposits 1,032,200 ugnot against the first match's 876,100, and it is the costliest ending measured. A Resign or a ClaimForfeit makes the same writes when it ends a first rated match; gnodev cannot pass a 24-hour deadline, so the script measures no ClaimForfeit.

## Session budgets

Each match gets its own session, and its spend limit is the budget of the player's side (`sessionBudget` in `wallet.ts`). A session's spending counts every fee and deposit, and refunds never restore it. The chain's gas price rises with load, and each move pays the price of its block, so the page prices a move at the chain's current gas price (`auth/gasprice`). A move costs two parts, measured in the first match under Storage per move, which carries the one-time costs:

- **The deposit**, in ugnot: 100 per byte the move adds, whatever the gas price. The opening's deposit holds the 48-byte session lock its call adds.
- **The fee**, for the gas the page asks for: the gas used, plus a fifth and 100,000 (`gasWantedFor` in `chain.ts`), at the chain's gas price.

`wallet.ts` keeps each measured move's gas used and deposit. Each side's moves end with the move that ends a first rated match, with the fourth match's 1,032,200 ugnot deposit. A knockout lets any Reveal end a match, so the challenger's ending takes the costliest Reveal's gas, the fourth match's round 1. The acceptor ends a match only by resigning or claiming a forfeit, so theirs takes the third match's Resign. When the page creates a session, it reads the gas price and sets the budget of the player's side:

- the cost of each of the side's moves;
- its costliest move once more, for one failed attempt.

At gnodev's 1 ugnot per 1,000 gas, the budgets come to:

| | Challenger | Acceptor |
|---|---|---|
| Opening move | Challenge: 21,090 + 244,500 = 265,590 | Accept: 34,231 + 215,300 = 249,531 |
| Later moves | Reveals: 58,299 + 42,165 | Plays: 24,856 + 100 = 24,956, then 24,573 |
| Ending | Reveal: 58,790 + 1,032,200 = 1,090,990 | Resign: 26,916 + 1,032,200 = 1,059,116 |
| The side's moves | 1,457,044 | 1,358,176 |
| The costliest move again | 1,090,990 | 1,059,116 |
| Budget | 2,548,034 ugnot | 2,417,292 ugnot |

At five times that gas price, the fees cost five times as much and the deposits stay: the budgets come to 3,504,566 and 2,967,248 ugnot.

A session with less left than the costliest move it may still pay counts as used up (`sessionReserve`). The page prices that move at the chain's gas price each time it reads the session. The chain refuses a move its session cannot pay before running it, and charges nothing, so the session's spending never shows the shortfall. Once a rising price leaves a session short, its match's `session` reads `expired` and the lobby offers a renewal. At the floor price:
- **An unlocked session** may still pay an opening: 265,590 ugnot for the challenger and 249,531 for the acceptor.
- **A session locked to a match** pays only its side's later moves and its ending. Their reserve is the costlier of the side's ending and its costliest later move in any measured match, plus a tenth, rounded up to the ugnot, since moves cost more as a chunk fills: 1,200,089 ugnot for the challenger, from the 1,090,990 ending, and 1,165,028 for the acceptor, from the 1,059,116 ending.

## On onyx

The `onyx` build plays on the arena at `gno.land/r/g188vafzutzvlfw6wt7u3s62xtuvm0epmu8ufmfz/gnomepit/arena`, deployed under a gnomcp test key with its engine at `gno.land/p/g188vafzutzvlfw6wt7u3s62xtuvm0epmu8ufmfz/gnomepit/engine`, and follows the chain through `https://gnotif.xyz/onyx`. CI builds the page for it when the repository variable `GNOMEPIT_NETWORK` is `onyx`. A player connects Adena on `onyx-1` and pays their sessions in onyx GNOT. The onyx build ignores `?dev=` and uses Adena: the dev accounts' keys ship in the page, and on a public chain anyone could play as them.

`scripts/onyx-copy.sh <address> <dir>` writes the engine and the arena, tests included, for a deploy under that address's namespace: their package paths move to it, the arena imports gnotif's registry at `gno.land/r/nym-gfanton001/gnotif/v1`, and `pagePath` becomes `/gnomepit/`, the page's path on GitHub Pages, so a notification's click opens the page there. Onyx parks every deploy until its approver type-checks it, and a deploy that fails stays parked with no error, so lint and test the copy with the gno release the node's `/status` names, v1.6.0-rc.1 on 2026-10-26, against dependencies fetched from onyx (`gno mod download -remote-overrides gno.land=https://rpc.onyx.testnets.gno.land:443`). The flake's gno, the `chain/onyx` tag, is an older release.

The approver charges the storage deposit to the deployer when it enables the package, up to the maximum deposit the deploy named. On gnodev the arena's deploy stores 127,627 bytes, 12.76 GNOT at 100 ugnot per byte, so a deploy capped at 10 GNOT, as gnomcp caps them before v0.12.3, never goes live.

Three things in onyx's release decide whether the arena works there. Each held on 2026-10-26; check them again after an onyx upgrade:
- **`runtime.GetSessionInfo` and session accounts.** The realm calls `GetSessionInfo` to lock each session to its match. Without it the lock has to go, and a session is held only to its per-match budget. The realm's tests pass on v1.6.0-rc.1.
- **Restricted ugnot transfers.** On a chain that restricts them, freed storage deposits go to the storage fee collector (`gno.land/pkg/sdk/vm/keeper.go`) instead of the caller. A call that frees storage then gets nothing back: a reveal that drops a seal, a withdrawn challenge, or a challenge that clears expired ones. Onyx's `bank` parameter `restricted_denoms` is empty.
- **The gas price and the storage price.** A budget prices gas at the gas price of the session's creation, so a price that keeps rising through a match makes its players renew. The deposits assume gnodev's storage price, the `vm` parameter `storage_price` of 100 ugnot per byte, which the page never reads. Onyx's `auth/gasprice` is 1 ugnot per 1,000 gas and its `storage_price` 100 ugnot per byte, the prices the budgets above were measured at.

`NETWORK=onyx SESSION_SECONDS=120 node client/e2e/match.ts` plays the end-to-end matches on onyx as alice and bob, who need onyx GNOT first. A 30-second session would expire before alice's first reveal at onyx's pace of a block every few seconds.

## Tests

- `make test` runs the realm's tests, builds the page, type-checks, lints and format-checks the TypeScript, then runs `go vet`, the Go tests and the TypeScript tests; the TypeScript tests run `engine.wasm`.
- With `make dev`, `make indexer` and `make gnotif` running, `make e2e` plays its matches and checks each player's live feed. With `make dev` running, `make capture` records the query answers `gnovalue.ts`'s and `arena.ts`'s tests read, and `make record` records the RPC answers the other tests replay.
