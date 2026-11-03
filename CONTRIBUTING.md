# Contributing to Gnomepit

Build Gnomepit, run it locally, play online against a local chain, and run the tests. For online play in depth, including the arena API and its costs, read [`client/ONLINE.md`](client/ONLINE.md).

## Set up the dev shell

The Nix dev shell carries every tool the project needs: Go, TinyGo, Node 24, pnpm, jq, gno, gnokey, gnodev and gnotifd. You need [Nix](https://nixos.org/download) with flakes enabled.

Enter the shell with `nix develop`, or run `direnv allow` once if you use direnv. Run every command on this page inside it.

## Run the game locally

1. Run `make serve`, which builds the page into `dist/` and serves it.
2. Open <http://127.0.0.1:8080/> and choose **Play the bot** to start a match.

## Play online against a local chain

Online play needs a local chain. Run each command in its own terminal, in this order:

1. Run `make dev`, which starts a gnodev chain with the engine, funds four dev accounts and deploys the standings realm and the arena.
2. Run `make indexer`, which indexes the chain for the notification server.
3. Run `make gnotif`, which serves live updates and push notifications to the page.
4. If `make serve` is not already running, run it.
5. Open <http://127.0.0.1:8080/?dev=alice> in one browser and <http://127.0.0.1:8080/?dev=bob> in another, then choose **Play online** in both.

Each `?dev=` page signs with a dev account in place of Adena. Without `make gnotif`, each page polls the node every 4 seconds instead of following live updates. gnodev keeps the chain in memory, so after restarting `make dev`, restart `make indexer` and then `make gnotif`.

## Run the tests

`make test` runs the Gno, Go and TypeScript tests, and the type, lint and format checks. With `make dev`, `make indexer` and `make gnotif` running, `make e2e` plays two full arena matches against the local chain. `make help` lists every target.

## Repository layout

Each directory holds one part of the game.

| Directory       | Holds                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| `p/engine`      | The duel rules, one source that compiles as Go and as Gno                       |
| `r/standings`   | The realm that keeps ratings, records and rated results across arena versions   |
| `r/arena`       | The realm that runs online matches                                              |
| `cardfile`      | Loads a ruleset from the JSON card file                                         |
| `cardtext`      | Prints a card's text from its effect data                                       |
| `client/bridge` | Exposes the engine to the page as JSON requests and responses                   |
| `client/wasm`   | The WebAssembly entry point that registers the bridge in the page               |
| `client/serve`  | A static file server for the page during development                            |
| `client/golden` | Signs fixed requests with the chain's own Go types, for the signer tests        |
| `client/web`    | The page: TypeScript, styles, card art and their tests                          |
| `client/e2e`    | Plays arena matches against a running `make dev`, or on onyx                    |
| `scripts`       | Records chain answers, funds an account, measures storage, writes the onyx copy |
