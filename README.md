# Gnomehall

Gnomehall is a two-player card duel between gnome clans beneath a mountain. Each player builds a deck of eight special cards from a clan's pool, plans three beats per round in secret, and both plans resolve together. Play against a bot, share one screen, or play online, where the Gno realm `r/arena` holds the match and checks every move with the same engine the page runs.

The page at <https://gfanton.github.io/gnomehall/> plays offline: against the bot, two players on one device, or the guided match. Online play needs the arena on a chain the page is built for; `make serve` builds the page for the local chain `make dev` runs.

## Develop

Enter the Nix dev shell with `direnv allow` or `nix develop`. It carries Go, TinyGo, Node 24, pnpm, and gno, gnokey and gnodev built from gno's `chain/onyx` tag.

- `make dev` runs a local chain with the engine, the arena and the dev accounts.
- `make indexer` indexes the running chain for the page's live updates.
- `make serve` builds the page into `dist/` and serves it on <http://127.0.0.1:8080/>.
- `make test` runs the realm's Gno tests, builds the page, type-checks, lints and format-checks the TypeScript, then runs `go vet`, the Go tests and the TypeScript tests.

To play online locally, run `make dev`, then `make serve`, which builds for `make dev`'s chain by default. Open <http://127.0.0.1:8080/?dev=alice> in one browser and `?dev=bob` in another, then choose **Play online**. Without `?dev=`, the lobby uses Adena. With `make indexer` running, each page follows the other's moves through the indexer; without it, the page polls the node every 4 seconds.

`make help` lists every target.

## Layout

| Directory       | Holds                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| `p/engine`      | The duel rules, one source that compiles as Go and as Gno                        |
| `r/arena`       | The realm that runs online matches                                               |
| `cardfile`      | Loads a ruleset from the JSON card file                                          |
| `cardtext`      | Prints a card's text from its effect data                                        |
| `client/bridge` | Exposes the engine to the page as JSON requests and responses                    |
| `client/wasm`   | The WebAssembly entry point that registers the bridge in the page                |
| `client/serve`  | A static file server for the page during development                             |
| `client/golden` | Signs fixed requests with the chain's own Go types, for the signer tests         |
| `client/web`    | The page: TypeScript, styles, card art and their tests                           |
| `client/e2e`    | Plays arena matches against a running `make dev`                                 |
| `scripts`       | Records chain answers for the tests, funds an account and measures storage costs |

## Documents

- [`client/ONLINE.md`](client/ONLINE.md): online play, the wallet, sessions and costs
- [`client/BATTLE.md`](client/BATTLE.md): the battle board and its motion
- [`client/DESIGN.md`](client/DESIGN.md): the visual design
- [`client/LOBBY.md`](client/LOBBY.md): the lobby
- [`client/DELVERS.md`](client/DELVERS.md): the Delvers clan

## License

[Apache-2.0](LICENSE), covering the code, the docs and the art.
