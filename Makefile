GOROOT := $(shell go env GOROOT)
WEB := client/web

.PHONY: wasm serve test

wasm:
	GOOS=js GOARCH=wasm go build -o $(WEB)/engine.wasm ./client/wasm
	cp -f "$(GOROOT)/lib/wasm/wasm_exec.js" $(WEB)/

serve:
	go run ./client/serve -dir $(WEB)

test:
	go vet ./...
	go test ./...
	node --test '$(WEB)/*.test.mjs'
