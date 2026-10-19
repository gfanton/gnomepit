//go:build js && wasm

// The page's engine: registers the bridge on globalThis.gnomepit and stays resident.
package main

import (
	"syscall/js"

	"gnomehall/client/bridge"
)

func main() {
	b := bridge.New()
	js.Global().Set("gnomepit", map[string]any{
		"load":       call(b.Load),
		"legalDeck":  call(b.LegalDeck),
		"legalPlans": call(b.LegalPlans),
		"resolve":    call(b.Resolve),
	})
	select {}
}

// call wraps a bridge method taking and returning one JSON string.
func call(fn func(string) string) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return `{"error":"one string argument expected"}`
		}
		return fn(args[0].String())
	})
}
