// Command encode reads one {type, value} message from stdin, decodes it with the chain's
// own types, and prints the hex of its amino binary as an Any, then its amino JSON. The
// signer's tests compare its mirrors with this output.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/sdk/auth"
	"github.com/gnolang/gno/tm2/pkg/std"
)

func main() {
	if err := run(); err != nil {
		slog.Error("encode", "err", err)
		os.Exit(1)
	}
}

func run() error {
	var in struct {
		Type  string          `json:"type"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		return err
	}
	var msg std.Msg
	switch in.Type {
	case "/vm.m_call":
		var m vm.MsgCall
		if err := amino.UnmarshalJSON(in.Value, &m); err != nil {
			return err
		}
		msg = m
	case "/auth.m_create_session":
		var m auth.MsgCreateSession
		if err := amino.UnmarshalJSON(in.Value, &m); err != nil {
			return err
		}
		msg = m
	default:
		return fmt.Errorf("unknown message type %q", in.Type)
	}
	bin, err := amino.MarshalAny(msg)
	if err != nil {
		return err
	}
	js, err := amino.MarshalJSON(msg)
	if err != nil {
		return err
	}
	fmt.Println(hex.EncodeToString(bin))
	fmt.Println(string(js))
	return nil
}
