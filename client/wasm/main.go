//go:build js && wasm

// The page's engine and signer: registers the bridge and the signer on
// globalThis.gnomehall and stays resident.
package main

import (
	"encoding/json"
	"syscall/js"

	"gnomehall/client/bridge"
	"gnomehall/client/signer"
)

func main() {
	b := bridge.New()
	js.Global().Set("gnomehall", map[string]any{
		"load":       call(b.Load),
		"legalDeck":  call(b.LegalDeck),
		"legalPlans": call(b.LegalPlans),
		"resolve":    call(b.Resolve),
		"keyInfo": call(jsonCall(func(r struct {
			PrivKey string `json:"privKey"`
		}) (any, error) {
			return signer.KeyInfo(r.PrivKey)
		})),
		"signTx": call(jsonCall(func(r signer.TxRequest) (any, error) {
			tx, err := signer.SignTx(r)
			return struct {
				Tx string `json:"tx"`
			}{tx}, err
		})),
		"signBytes": call(jsonCall(func(r struct {
			PrivKey string `json:"privKey"`
			Bytes   []byte `json:"bytes"` // base64 in JSON
		}) (any, error) {
			sig, err := signer.SignBytes(r.PrivKey, r.Bytes)
			return struct {
				Signature []byte `json:"signature"`
			}{sig}, err
		})),
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

// jsonCall turns fn into a function of one JSON string, answering its result as JSON
// or {"error": message}, as the bridge does.
func jsonCall[Req any](fn func(Req) (any, error)) func(string) string {
	return func(in string) string {
		var req Req
		if err := json.Unmarshal([]byte(in), &req); err != nil {
			return failure(err)
		}
		out, err := fn(req)
		if err != nil {
			return failure(err)
		}
		bz, err := json.Marshal(out)
		if err != nil {
			return failure(err)
		}
		return string(bz)
	}
}

func failure(err error) string {
	bz, _ := json.Marshal(struct {
		Error string `json:"error"`
	}{err.Error()})
	return string(bz)
}
