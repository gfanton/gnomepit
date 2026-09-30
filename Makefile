SHELL := /bin/sh
GOROOT := $(shell go env GOROOT)
WEB := client/web

.PHONY: all wasm serve test clean help

all: wasm ## Build the page's engine (default)

wasm: ## Compile the engine to WebAssembly and copy the Go runtime glue next to the page
	GOOS=js GOARCH=wasm go build -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$(GOROOT)/lib/wasm/wasm_exec.js" $(WEB)/

serve: ## Serve the page on 127.0.0.1:8080
	go run ./client/serve -dir $(WEB)

test: ## Run the Go and script tests
	go vet ./...
	go test ./...
	node --test '$(WEB)/*.test.mjs'

clean: ## Remove the build outputs
	rm -f $(WEB)/engine.wasm $(WEB)/wasm_exec.js

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## / — /'
