// Package auth mirrors the chain's auth.MsgCreateSession under the same amino name, so
// the dev wallet can create a session without linking the chain's auth module.
package auth

import (
	"errors"

	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/std"
)

var Package = amino.RegisterPackage(amino.NewPackage(
	"gnomehall/client/signer/auth",
	"auth",
	amino.GetCallersDirname(),
).WithDependencies(
	std.Package,
).WithTypes(
	MsgCreateSession{}, "m_create_session",
))

// MsgCreateSession lets SessionKey sign for Creator. Its fields, order and tags are
// those of tm2/pkg/sdk/auth.MsgCreateSession.
type MsgCreateSession struct {
	Creator     crypto.Address `json:"creator" yaml:"creator"`
	SessionKey  crypto.PubKey  `json:"session_key" yaml:"session_key"`
	ExpiresAt   int64          `json:"expires_at" yaml:"expires_at"`
	AllowPaths  []string       `json:"allow_paths,omitempty" yaml:"allow_paths"`
	SpendLimit  std.Coins      `json:"spend_limit,omitempty" yaml:"spend_limit"`
	SpendPeriod int64          `json:"spend_period,omitempty" yaml:"spend_period"`
}

var _ std.Msg = MsgCreateSession{}

func (msg MsgCreateSession) Route() string { return "auth" }

func (msg MsgCreateSession) Type() string { return "create_session" }

// ValidateBasic checks what can be checked without the chain; the chain checks the rest.
func (msg MsgCreateSession) ValidateBasic() error {
	switch {
	case msg.Creator.IsZero():
		return errors.New("missing creator address")
	case msg.SessionKey == nil:
		return errors.New("missing session key")
	case msg.ExpiresAt < 0 || msg.SpendPeriod < 0:
		return errors.New("negative expiry or spend period")
	case !msg.SpendLimit.IsValid():
		return errors.New("invalid spend limit")
	}
	return nil
}

func (msg MsgCreateSession) GetSignBytes() []byte {
	return std.MustSortJSON(amino.MustMarshalJSON(msg))
}

func (msg MsgCreateSession) GetSigners() []crypto.Address {
	return []crypto.Address{msg.Creator}
}
