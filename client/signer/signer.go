// Package signer signs gno transactions inside the page: realm calls and session
// creation, by an account's own key or by a session key acting for it. It leaves the
// network to the page.
package signer

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"

	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/std"

	"gnomehall/client/signer/auth"
	"gnomehall/client/signer/vm"
)

// curveOrder is the order of secp256k1; a private key lies in [1, curveOrder).
var curveOrder, _ = new(big.Int).SetString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

// Key is the public half of a private key.
type Key struct {
	Address string `json:"address"`
	PubKey  string `json:"pubKey"` // base64 of the 33-byte compressed key
}

// Msg is one message as Adena's transaction parameters carry it: an amino type URL
// and the message's amino JSON.
type Msg struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
}

type Fee struct {
	GasWanted int64  `json:"gasWanted"`
	GasFee    string `json:"gasFee"` // one coin, such as "25000ugnot"
}

// TxRequest is a transaction to sign with PrivKey under the account number and sequence
// the chain holds for the signing account. A non-empty SessionAddr signs as that
// session of the messages' signer.
type TxRequest struct {
	ChainID       string `json:"chainId"`
	AccountNumber uint64 `json:"accountNumber"`
	Sequence      uint64 `json:"sequence"`
	PrivKey       string `json:"privKey"` // 32 bytes of hex
	SessionAddr   string `json:"sessionAddr"`
	Fee           Fee    `json:"fee"`
	Memo          string `json:"memo"`
	Msgs          []Msg  `json:"msgs"`
}

// KeyInfo returns the address and public key of a private key given in hex.
func KeyInfo(privKeyHex string) (Key, error) {
	priv, err := privKey(privKeyHex)
	if err != nil {
		return Key{}, err
	}
	pub := priv.PubKey().(secp256k1.PubKeySecp256k1)
	return Key{Address: pub.Address().String(), PubKey: base64.StdEncoding.EncodeToString(pub[:])}, nil
}

// SignTx returns the signed transaction as base64 amino binary, ready to broadcast.
func SignTx(r TxRequest) (string, error) {
	if r.ChainID == "" {
		return "", errors.New("missing chain id")
	}
	priv, err := privKey(r.PrivKey)
	if err != nil {
		return "", err
	}
	if len(r.Msgs) == 0 {
		return "", errors.New("no message to sign")
	}
	msgs := make([]std.Msg, 0, len(r.Msgs))
	for _, m := range r.Msgs {
		msg, err := decodeMsg(m)
		if err != nil {
			return "", err
		}
		if err := msg.ValidateBasic(); err != nil {
			return "", fmt.Errorf("%s: %w", m.Type, err)
		}
		msgs = append(msgs, msg)
	}
	gasFee, err := std.ParseCoin(r.Fee.GasFee)
	if err != nil {
		return "", fmt.Errorf("gas fee: %w", err)
	}
	var session crypto.Address
	if r.SessionAddr != "" {
		if session, err = crypto.AddressFromBech32(r.SessionAddr); err != nil {
			return "", fmt.Errorf("session address: %w", err)
		}
	}

	tx := std.Tx{Msgs: msgs, Fee: std.NewFee(r.Fee.GasWanted, gasFee), Memo: r.Memo}
	signBytes, err := tx.GetSignBytes(r.ChainID, r.AccountNumber, r.Sequence)
	if err != nil {
		return "", fmt.Errorf("sign bytes: %w", err)
	}
	signature, err := priv.Sign(signBytes)
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	tx.Signatures = []std.Signature{{PubKey: priv.PubKey(), Signature: signature, SessionAddr: session}}
	bz, err := amino.Marshal(tx)
	if err != nil {
		return "", fmt.Errorf("encode transaction: %w", err)
	}
	return base64.StdEncoding.EncodeToString(bz), nil
}

// SignBytes signs data with a private key given in hex, as a wallet signs a document.
func SignBytes(privKeyHex string, data []byte) ([]byte, error) {
	priv, err := privKey(privKeyHex)
	if err != nil {
		return nil, err
	}
	return priv.Sign(data)
}

func decodeMsg(m Msg) (std.Msg, error) {
	var msg std.Msg
	switch m.Type {
	case "/vm.m_call":
		var call vm.MsgCall
		if err := amino.UnmarshalJSON(m.Value, &call); err != nil {
			return nil, fmt.Errorf("%s: %w", m.Type, err)
		}
		msg = call
	case "/auth.m_create_session":
		var create auth.MsgCreateSession
		if err := amino.UnmarshalJSON(m.Value, &create); err != nil {
			return nil, fmt.Errorf("%s: %w", m.Type, err)
		}
		msg = create
	default:
		return nil, fmt.Errorf("unknown message type %q", m.Type)
	}
	return msg, nil
}

func privKey(privKeyHex string) (secp256k1.PrivKeySecp256k1, error) {
	raw, err := hex.DecodeString(privKeyHex)
	if err != nil || len(raw) != len(secp256k1.PrivKeySecp256k1{}) {
		return secp256k1.PrivKeySecp256k1{}, errors.New("private key must be 32 bytes of hex")
	}
	if n := new(big.Int).SetBytes(raw); n.Sign() == 0 || n.Cmp(curveOrder) >= 0 {
		return secp256k1.PrivKeySecp256k1{}, errors.New("private key out of range")
	}
	return secp256k1.PrivKeySecp256k1(raw), nil
}
