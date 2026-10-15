SHELL := /bin/sh
GOROOT := $(shell go env GOROOT)
WEB := client/web
# The gnotif checkout whose registry the arena imports, at its development path.
GNOTIF_DIR ?= $(HOME)/code/gfanton/gnotif
REGISTRY := deps/gnotif/v0
# The local chain: ports clear of a default gnodev, and the dev wallet's two players
# (client/web/devwallet.mjs), each funded with 10,000 GNOT.
DEV_RPC := 127.0.0.1:36657
DEV_WEB := 127.0.0.1:8890
DEV_ACCOUNTS := g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw
# The indexer that pushes the local chain's arena calls to the page.
DEV_INDEXER := 127.0.0.1:8546
TX_INDEXER := github.com/gnolang/tx-indexer/cmd@v1.3.0
INDEXER_DB := .indexer

.PHONY: all wasm serve dev indexer capture fund record e2e test realm-test deps clean help

all: wasm ## Build the page's engine (default)

wasm: ## Compile the engine to WebAssembly and copy the Go runtime glue next to the page
	GOOS=js GOARCH=wasm go build -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$(GOROOT)/lib/wasm/wasm_exec.js" $(WEB)/

serve: ## Serve the page on 127.0.0.1:8080
	go run ./client/serve -dir $(WEB)

dev: deps ## Run gnodev with the engine, the arena, the gnotif registry and the dev accounts
	gnodev local -node-rpc-listener $(DEV_RPC) -web-listener $(DEV_WEB) \
		$(foreach a,$(DEV_ACCOUNTS),-add-account $(a)=10000000000ugnot) \
		./p/engine ./r/arena ./$(REGISTRY)

# gnodev starts every chain from height 0, so the index starts empty each time.
indexer: ## Index a running make dev for the page's live updates; start it again after gnodev restarts or reloads
	rm -rf $(INDEXER_DB)
	go run $(TX_INDEXER) start -remote http://$(DEV_RPC) -db-path $(abspath $(INDEXER_DB)) -listen-address $(DEV_INDEXER)

capture: ## Record the arena's query answers from a running make dev
	RPC=$(DEV_RPC) scripts/capture.sh $(WEB)/testdata/qeval

fund: ## Send 1,000 GNOT on a running make dev to ADDRESS, such as an Adena account
	RPC=$(DEV_RPC) scripts/fund.sh $(ADDRESS)

record: wasm ## Record the RPC answers the script tests replay, from a running make dev
	node scripts/record-rpc.mjs http://$(DEV_RPC)

e2e: wasm ## Play a whole arena match on a running make dev and make indexer, with both signing paths
	node client/e2e/match.mjs http://$(DEV_RPC) http://$(DEV_INDEXER)/graphql/query

test: realm-test wasm ## Run the Gno, Go and script tests; script tests run engine.wasm
	go vet ./...
	go test ./...
	node --test '$(WEB)/*.test.mjs'

realm-test: deps ## Run the arena realm's tests
	gno test ./r/...

deps: ## Copy the gnotif registry from GNOTIF_DIR into deps/, without its tests
	rm -rf $(REGISTRY)
	mkdir -p $(REGISTRY)
	cp -f $(GNOTIF_DIR)/gno/r/gnotif/v0/gnomod.toml $(REGISTRY)/
	find $(GNOTIF_DIR)/gno/r/gnotif/v0 -maxdepth 1 -name '*.gno' ! -name '*_test.gno' -exec cp -f {} $(REGISTRY)/ \;

clean: ## Remove the build outputs
	rm -f $(WEB)/engine.wasm $(WEB)/wasm_exec.js

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## / — /'
