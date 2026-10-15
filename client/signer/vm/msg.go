// Package vm mirrors the chain's vm.MsgCall under the same amino name, so the page signs
// realm calls without linking the gno VM into its WebAssembly.
package vm

import (
	"errors"
	"go/token"

	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/std"
)

var Package = amino.RegisterPackage(amino.NewPackage(
	"gnomehall/client/signer/vm",
	"vm",
	amino.GetCallersDirname(),
).WithDependencies(
	std.Package,
).WithTypes(
	MsgCall{}, "m_call",
))

// MsgCall calls a realm function. Its fields, order and tags are those of
// gno.land/pkg/sdk/vm.MsgCall.
type MsgCall struct {
	Caller     crypto.Address `json:"caller" yaml:"caller"`
	Send       std.Coins      `json:"send" yaml:"send"`
	MaxDeposit std.Coins      `json:"max_deposit" yaml:"max_deposit"`
	PkgPath    string         `json:"pkg_path" yaml:"pkg_path"`
	Func       string         `json:"func" yaml:"func"`
	Args       []string       `json:"args,omitempty" yaml:"args"`
}

var _ std.Msg = MsgCall{}

func (msg MsgCall) Route() string { return "vm" }

func (msg MsgCall) Type() string { return "exec" }

// ValidateBasic checks what can be checked without the VM; the chain checks the rest.
func (msg MsgCall) ValidateBasic() error {
	switch {
	case msg.Caller.IsZero():
		return errors.New("missing caller address")
	case msg.PkgPath == "":
		return errors.New("missing package path")
	case !token.IsIdentifier(msg.Func):
		return errors.New("func must be a Go identifier")
	case !msg.Send.IsValid() || !msg.MaxDeposit.IsValid():
		return errors.New("invalid coins")
	}
	return nil
}

func (msg MsgCall) GetSignBytes() []byte {
	return std.MustSortJSON(amino.MustMarshalJSON(msg))
}

func (msg MsgCall) GetSigners() []crypto.Address {
	return []crypto.Address{msg.Caller}
}
