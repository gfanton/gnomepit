SHELL := /bin/sh
WEB := client/web
PNPM_STAMP := node_modules/.modules.yaml
GOLDEN := $(WEB)/testdata/golden-tx.json
# GNOTIF_DIR names the gnotif checkout whose registry the arena imports; the dev shell sets it to
# the gnotif revision the flake pins.
REGISTRY := deps/gnotif/v1
TRIGGER := deps/gnotif/trigger/v0
# The local chain: a chain ID and ports clear of a default gnodev, and the dev wallet's four
# players (client/web/devwallet.ts), each funded with 10,000 GNOT.
DEV_CHAIN := gnomepit-dev
DEV_RPC := 127.0.0.1:36657
DEV_WEB := 127.0.0.1:8890
DEV_ACCOUNTS := g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw \
	g1x79lhtyj8sef3yyv3pvy20hzmgfst0274k8jx0 g1t834akqrqg83csrq98t443larad7vnr6pp3lsd
GNODEV_WORKSPACE := .gnodev
# The indexer gnotifd reads the local chain through.
DEV_INDEXER := 127.0.0.1:8546
# gnotifd, which sends the page its live updates and push notifications.
DEV_GNOTIF := 127.0.0.1:8547
GNOTIF_DB := .gnotif
TX_INDEXER := github.com/gnolang/tx-indexer/cmd@v1.3.0
INDEXER_DB := .indexer

.PHONY: all wasm golden build check serve dev indexer gnotif capture fund record e2e test realm-test deps clean fclean help

all: wasm ## Build the page's engine (default)

wasm: ## Compile the engine to WebAssembly with TinyGo and copy TinyGo's runtime glue next to the page
	tinygo build -target wasm -opt=z -no-debug -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$$(tinygo env TINYGOROOT)/targets/wasm_exec.js" $(WEB)/

golden: ## Sign the signer tests' golden transactions with the chain's own Go types
	go -C client/golden run . > $(GOLDEN).tmp
	mv -f $(GOLDEN).tmp $(GOLDEN)

build: wasm $(PNPM_STAMP) ## Build engine.wasm and bundle the pages into dist/ for GNOMEPIT_NETWORK: local (the default), onyx or offline
	pnpm run build

$(PNPM_STAMP): package.json pnpm-lock.yaml pnpm-workspace.yaml
	pnpm install --frozen-lockfile
	touch $@

check: $(PNPM_STAMP) ## Type-check, lint and format-check the TypeScript
	pnpm run check
	pnpm run lint
	pnpm run fmt:check

serve: build ## Build dist/ and serve it on 127.0.0.1:8080
	go run ./client/serve -dir dist

# gnodev runs from an empty workspace: from the repository's, its lazy loader would load
# r/arena at genesis as soon as the arena's deploy transaction named it. Outside the
# repository's workspace gnodev resolves no import from its examples, so it loads them all.
# gnodev runs in the background, where its terminal keys find no terminal. It must never
# reload: a reload moves every transaction to genesis, the arena's triggers with them.
dev: deps ## Run gnodev with the engine, the gnotif registry and the dev accounts, then deploy the arena on it
	mkdir -p $(GNODEV_WORKSPACE)
	touch $(GNODEV_WORKSPACE)/gnowork.toml
	RPC=$(DEV_RPC) CHAIN=$(DEV_CHAIN) scripts/dev.sh \
		gnodev local -interactive=false -no-watch \
		-C $(abspath $(GNODEV_WORKSPACE)) -extra-root "$$(gno env GNOROOT)/examples" \
		-chain-id $(DEV_CHAIN) -node-rpc-listener $(DEV_RPC) -web-listener $(DEV_WEB) \
		$(foreach a,$(DEV_ACCOUNTS),-add-account $(a)=10000000000ugnot) \
		$(abspath p/engine $(REGISTRY) $(TRIGGER))

# gnodev starts every chain from height 0, so the index starts empty each time.
indexer: ## Index a running make dev for gnotifd; start it again after make dev restarts
	rm -rf $(INDEXER_DB)
	go run $(TX_INDEXER) start -remote http://$(DEV_RPC) -db-path $(abspath $(INDEXER_DB)) -listen-address $(DEV_INDEXER)

# gnodev starts every chain from height 0, so gnotifd starts on new keys and an empty database each time.
gnotif: ## Run gnotifd on a running make indexer, for the page's live updates and push; start it again after make indexer does
	rm -rf $(GNOTIF_DB)
	mkdir -p $(GNOTIF_DB)
	gnotifd keygen > $(GNOTIF_DB)/vapid.env
	set -a && . ./$(GNOTIF_DB)/vapid.env && set +a && gnotifd -indexer http://$(DEV_INDEXER)/graphql/query \
		-registry gno.land/r/dev/gnotif/v1 -start-height 1 -poll 1s -max-age 1h -stream-max 64 \
		-db $(GNOTIF_DB)/gnotif.db -listen $(DEV_GNOTIF) -vapid-subject https://github.com/gfanton/gnomepit

capture: ## Record the arena's query answers from a running make dev
	RPC=$(DEV_RPC) CHAIN=$(DEV_CHAIN) scripts/capture.sh $(WEB)/testdata/qeval

fund: ## Send 1,000 GNOT on a running make dev to ADDRESS, such as an Adena account
	RPC=$(DEV_RPC) CHAIN=$(DEV_CHAIN) scripts/fund.sh $(ADDRESS)

record: $(PNPM_STAMP) ## Record the RPC answers the TypeScript tests replay, from a running make dev
	CHAIN=$(DEV_CHAIN) node scripts/record-rpc.ts http://$(DEV_RPC)

e2e: wasm $(PNPM_STAMP) ## Play two arena matches on a running make dev, make indexer and make gnotif, one through per-match sessions and one the wallet signs
	CHAIN=$(DEV_CHAIN) node client/e2e/match.ts http://$(DEV_RPC) http://$(DEV_GNOTIF)

test: realm-test build check ## Run the Gno tests, build the page, check the TypeScript, then run go vet, the Go tests and the TypeScript tests
	go vet ./...
	go test ./...
	pnpm test

realm-test: deps ## Run the arena realm's tests
	gno test ./r/...

deps: ## Copy the gnotif registry and its trigger package from GNOTIF_DIR into deps/, without their tests
	$(if $(GNOTIF_DIR),,$(error GNOTIF_DIR is unset: enter the dev shell or set it to a gnotif checkout))
	rm -rf deps/gnotif
	mkdir -p $(REGISTRY) $(TRIGGER)
	cp -f $(GNOTIF_DIR)/gno/r/gnotif/gnomod.toml $(REGISTRY)/
	find $(GNOTIF_DIR)/gno/r/gnotif -maxdepth 1 -name '*.gno' ! -name '*_test.gno' -exec cp -f {} $(REGISTRY)/ \;
	cp -f $(GNOTIF_DIR)/gno/p/gnotif/trigger/gnomod.toml $(TRIGGER)/
	find $(GNOTIF_DIR)/gno/p/gnotif/trigger -maxdepth 1 -name '*.gno' ! -name '*_test.gno' -exec cp -f {} $(TRIGGER)/ \;

clean: ## Remove the build outputs
	rm -rf dist
	rm -f $(WEB)/engine.wasm $(WEB)/wasm_exec.js

fclean: clean ## Remove the build outputs and the installed packages
	rm -rf node_modules

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## / — /'
