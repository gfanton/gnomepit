SHELL := /bin/sh
WEB := client/web
PNPM_STAMP := node_modules/.modules.yaml
GOLDEN := $(WEB)/testdata/golden-tx.json
# The gnotif checkout whose registry the arena imports, at its development path.
GNOTIF_DIR ?= $(HOME)/code/gfanton/gnotif
REGISTRY := deps/gnotif/v0
# The local chain: a chain ID and ports clear of a default gnodev, and the dev wallet's two
# players (client/web/devwallet.ts), each funded with 10,000 GNOT.
DEV_CHAIN := gnomehall-dev
DEV_RPC := 127.0.0.1:36657
DEV_WEB := 127.0.0.1:8890
DEV_ACCOUNTS := g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw
# The indexer that pushes the local chain's arena calls to the page.
DEV_INDEXER := 127.0.0.1:8546
TX_INDEXER := github.com/gnolang/tx-indexer/cmd@v1.3.0
INDEXER_DB := .indexer

.PHONY: all wasm golden build check serve dev indexer capture fund record e2e test realm-test deps clean fclean help

all: wasm ## Build the page's engine (default)

wasm: ## Compile the engine to WebAssembly with TinyGo and copy TinyGo's runtime glue next to the page
	tinygo build -target wasm -opt=z -no-debug -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" $(WEB)/

golden: ## Sign the signer tests' golden transactions with the chain's own Go types
	go -C client/golden run . > $(GOLDEN).tmp
	mv -f $(GOLDEN).tmp $(GOLDEN)

build: wasm $(PNPM_STAMP) ## Bundle each page with esbuild into dist/ with its files, for GNOMEHALL_NETWORK (local by default)
	pnpm run build

$(PNPM_STAMP): package.json pnpm-lock.yaml
	pnpm install --frozen-lockfile

check: $(PNPM_STAMP) ## Type-check, lint and format-check the TypeScript
	pnpm run check
	pnpm run lint
	pnpm run fmt:check

serve: build ## Build dist/ and serve it on 127.0.0.1:8080
	go run ./client/serve -dir dist

dev: deps ## Run gnodev with the engine, the arena, the gnotif registry and the dev accounts
	gnodev local -chain-id $(DEV_CHAIN) -node-rpc-listener $(DEV_RPC) -web-listener $(DEV_WEB) \
		$(foreach a,$(DEV_ACCOUNTS),-add-account $(a)=10000000000ugnot) \
		./p/engine ./r/arena ./$(REGISTRY)

# gnodev starts every chain from height 0, so the index starts empty each time.
indexer: ## Index a running make dev for the page's live updates; start it again after gnodev restarts or reloads
	rm -rf $(INDEXER_DB)
	go run $(TX_INDEXER) start -remote http://$(DEV_RPC) -db-path $(abspath $(INDEXER_DB)) -listen-address $(DEV_INDEXER)

capture: ## Record the arena's query answers from a running make dev
	RPC=$(DEV_RPC) CHAIN=$(DEV_CHAIN) scripts/capture.sh $(WEB)/testdata/qeval

fund: ## Send 1,000 GNOT on a running make dev to ADDRESS, such as an Adena account
	RPC=$(DEV_RPC) CHAIN=$(DEV_CHAIN) scripts/fund.sh $(ADDRESS)

record: ## Record the RPC answers the script tests replay, from a running make dev
	CHAIN=$(DEV_CHAIN) node scripts/record-rpc.mjs http://$(DEV_RPC)

e2e: wasm ## Play two arena matches on a running make dev and make indexer, one through per-match sessions and one the wallet signs
	CHAIN=$(DEV_CHAIN) node client/e2e/match.mjs http://$(DEV_RPC) http://$(DEV_INDEXER)/graphql/query

test: realm-test build check ## Run the Gno, Go and script tests; script tests run engine.wasm
	go vet ./...
	go test ./...
	pnpm test

realm-test: deps ## Run the arena realm's tests
	gno test ./r/...

deps: ## Copy the gnotif registry from GNOTIF_DIR into deps/, without its tests
	rm -rf $(REGISTRY)
	mkdir -p $(REGISTRY)
	cp -f $(GNOTIF_DIR)/gno/r/gnotif/v0/gnomod.toml $(REGISTRY)/
	find $(GNOTIF_DIR)/gno/r/gnotif/v0 -maxdepth 1 -name '*.gno' ! -name '*_test.gno' -exec cp -f {} $(REGISTRY)/ \;

clean: ## Remove the build outputs
	rm -rf dist
	rm -f $(WEB)/engine.wasm $(WEB)/wasm_exec.js

fclean: clean ## Remove the build outputs and the installed packages
	rm -rf node_modules

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## / — /'
