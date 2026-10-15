SHELL := /bin/sh
GOROOT := $(shell go env GOROOT)
WEB := client/web
# The gnotif checkout whose registry the arena imports, at its development path.
GNOTIF_DIR ?= $(HOME)/code/gfanton/gnotif
REGISTRY := deps/gnotif/v0

.PHONY: all wasm serve test realm-test deps clean help

all: wasm ## Build the page's engine (default)

wasm: ## Compile the engine to WebAssembly and copy the Go runtime glue next to the page
	GOOS=js GOARCH=wasm go build -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$(GOROOT)/lib/wasm/wasm_exec.js" $(WEB)/

serve: ## Serve the page on 127.0.0.1:8080
	go run ./client/serve -dir $(WEB)

test: realm-test ## Run the Gno, Go and script tests
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
