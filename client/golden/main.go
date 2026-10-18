// Command golden signs fixed requests with the chain's own types and prints them as JSON,
// [{name, request, tx}], for the page's signer tests. A request is in the form signer.ts
// takes, messages in Adena's form; tx is the base64 amino transaction, or for sign-bytes
// the base64 signature.
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"

	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/sdk/auth"
	"github.com/gnolang/gno/tm2/pkg/std"
)

const (
	chainID    = "dev"
	masterKey  = "0101010101010101010101010101010101010101010101010101010101010101"
	sessionKey = "0202020202020202020202020202020202020202020202020202020202020202"
	arena      = "gno.land/r/gfanton/gnomehall/arena"
	seal       = "5e3a1f0c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f"
)

type fee struct {
	GasWanted int64  `json:"gasWanted"`
	GasFee    string `json:"gasFee"`
}

type txRequest struct {
	ChainID       string     `json:"chainId"`
	AccountNumber uint64     `json:"accountNumber"`
	Sequence      uint64     `json:"sequence"`
	PrivKey       string     `json:"privKey"`
	SessionAddr   string     `json:"sessionAddr"`
	Fee           fee        `json:"fee"`
	Memo          string     `json:"memo"`
	Msgs          []adenaMsg `json:"msgs"`
}

type adenaMsg struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}

type callValue struct {
	Caller     string   `json:"caller"`
	Send       string   `json:"send"`
	MaxDeposit string   `json:"max_deposit"`
	PkgPath    string   `json:"pkg_path"`
	Func       string   `json:"func"`
	Args       []string `json:"args"`
}

// wrappedKey is a public key as a protobuf Any, as Adena takes it: value is 0x0a, 33,
// then the compressed key.
type wrappedKey struct {
	TypeURL string `json:"type_url"`
	Value   []byte `json:"value"`
}

type createValue struct {
	Creator     string     `json:"creator"`
	SessionKey  wrappedKey `json:"session_key"`
	ExpiresAt   string     `json:"expires_at"`
	AllowPaths  []string   `json:"allow_paths"`
	SpendLimit  string     `json:"spend_limit"`
	SpendPeriod string     `json:"spend_period"`
}

type revokeValue struct {
	Creator    string     `json:"creator"`
	SessionKey wrappedKey `json:"session_key"`
}

type signBytesRequest struct {
	PrivKey string `json:"privKey"`
	Bytes   []byte `json:"bytes"`
}

type golden struct {
	Name    string `json:"name"`
	Request any    `json:"request"`
	Tx      string `json:"tx"`
}

func main() {
	if err := run(); err != nil {
		slog.Error("golden", "err", err)
		os.Exit(1)
	}
}

func run() error {
	master, err := privKey(masterKey)
	if err != nil {
		return err
	}
	session, err := privKey(sessionKey)
	if err != nil {
		return err
	}
	masterAddr := master.PubKey().Address().String()
	sessionPub := session.PubKey().(secp256k1.PubKeySecp256k1)
	wrapped := wrappedKey{TypeURL: "/tm.PubKeySecp256k1", Value: append([]byte{0x0a, byte(len(sessionPub))}, sessionPub[:]...)}

	requests := []struct {
		name string
		req  txRequest
	}{
		{"wallet-call", txRequest{
			ChainID: chainID, AccountNumber: 7, Sequence: 3, PrivKey: masterKey,
			Fee: fee{GasWanted: 21_500_000, GasFee: "21500ugnot"}, Memo: "Gnomehall",
			Msgs: []adenaMsg{{"/vm.m_call", callValue{
				Caller: masterAddr, Send: "1000000ugnot", PkgPath: arena, Func: "Play",
				Args: []string{"12", "Pick,Brace,Pick"},
			}}},
		}},
		{"session-call", txRequest{
			ChainID: chainID, AccountNumber: 41, Sequence: 0, PrivKey: sessionKey,
			SessionAddr: sessionPub.Address().String(),
			Fee:         fee{GasWanted: 30_000_000, GasFee: "30000ugnot"},
			Msgs: []adenaMsg{{"/vm.m_call", callValue{
				Caller: masterAddr, PkgPath: arena, Func: "Challenge",
				Args: []string{"Pickers", seal, seal, "AQIDBAUGBwgJCgsMDQ4PEA==", ""},
			}}},
		}},
		{"create-and-revoke", txRequest{
			ChainID: chainID, AccountNumber: 7, Sequence: 4, PrivKey: masterKey,
			Fee: fee{GasWanted: 6_000_000, GasFee: "6000ugnot"},
			Msgs: []adenaMsg{
				{"/auth.m_revoke_session", revokeValue{Creator: masterAddr, SessionKey: wrapped}},
				{"/auth.m_create_session", createValue{
					Creator: masterAddr, SessionKey: wrapped, ExpiresAt: "1760086400",
					AllowPaths: []string{"vm/exec:" + arena}, SpendLimit: "10000000ugnot", SpendPeriod: "0",
				}},
			},
		}},
		{"create-with-period", txRequest{
			ChainID: chainID, AccountNumber: 7, Sequence: 5, PrivKey: masterKey,
			Fee: fee{GasWanted: 3_000_000, GasFee: "3000ugnot"},
			Msgs: []adenaMsg{{"/auth.m_create_session", createValue{
				Creator: masterAddr, SessionKey: wrapped, ExpiresAt: "1760086400",
				AllowPaths: []string{"vm/exec:" + arena}, SpendLimit: "10000000ugnot", SpendPeriod: "3600",
			}}},
		}},
	}

	out := make([]golden, 0, len(requests)+1)
	for _, r := range requests {
		tx, err := signTx(r.req)
		if err != nil {
			return fmt.Errorf("%s: %w", r.name, err)
		}
		out = append(out, golden{Name: r.name, Request: r.req, Tx: tx})
	}

	doc := signBytesRequest{PrivKey: masterKey, Bytes: []byte("Gnomehall at http://127.0.0.1:8080")}
	signature, err := master.Sign(doc.Bytes)
	if err != nil {
		return fmt.Errorf("sign-bytes: %w", err)
	}
	out = append(out, golden{Name: "sign-bytes", Request: doc, Tx: base64.StdEncoding.EncodeToString(signature)})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func signTx(r txRequest) (string, error) {
	priv, err := privKey(r.PrivKey)
	if err != nil {
		return "", err
	}
	msgs := make([]std.Msg, 0, len(r.Msgs))
	for _, m := range r.Msgs {
		msg, err := chainMsg(m)
		if err != nil {
			return "", fmt.Errorf("%s: %w", m.Type, err)
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
	var sessionAddr crypto.Address
	if r.SessionAddr != "" {
		if sessionAddr, err = crypto.AddressFromBech32(r.SessionAddr); err != nil {
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
	tx.Signatures = []std.Signature{{PubKey: priv.PubKey(), Signature: signature, SessionAddr: sessionAddr}}
	bz, err := amino.Marshal(tx)
	if err != nil {
		return "", fmt.Errorf("encode transaction: %w", err)
	}
	return base64.StdEncoding.EncodeToString(bz), nil
}

// chainMsg decodes a message in Adena's form with the chain's own types, through amino
// JSON, which carries a session key bare under "@type" where Adena wraps it.
func chainMsg(m adenaMsg) (std.Msg, error) {
	value, err := json.Marshal(m.Value)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(value, &fields); err != nil {
		return nil, err
	}
	if raw, ok := fields["session_key"]; ok {
		var key wrappedKey
		if err := json.Unmarshal(raw, &key); err != nil {
			return nil, err
		}
		const keyLen = len(secp256k1.PubKeySecp256k1{})
		if len(key.Value) != 2+keyLen || key.Value[0] != 0x0a || int(key.Value[1]) != keyLen {
			return nil, errors.New("session key is not a wrapped secp256k1 key")
		}
		bare := struct {
			Type  string `json:"@type"`
			Value []byte `json:"value"`
		}{key.TypeURL, key.Value[2:]}
		if fields["session_key"], err = json.Marshal(bare); err != nil {
			return nil, err
		}
		if value, err = json.Marshal(fields); err != nil {
			return nil, err
		}
	}

	switch m.Type {
	case "/vm.m_call":
		var msg vm.MsgCall
		err = amino.UnmarshalJSON(value, &msg)
		return msg, err
	case "/auth.m_create_session":
		var msg auth.MsgCreateSession
		err = amino.UnmarshalJSON(value, &msg)
		return msg, err
	case "/auth.m_revoke_session":
		var msg auth.MsgRevokeSession
		err = amino.UnmarshalJSON(value, &msg)
		return msg, err
	}
	return nil, fmt.Errorf("unknown message type %q", m.Type)
}

func privKey(privKeyHex string) (secp256k1.PrivKeySecp256k1, error) {
	raw, err := hex.DecodeString(privKeyHex)
	if err != nil || len(raw) != len(secp256k1.PrivKeySecp256k1{}) {
		return secp256k1.PrivKeySecp256k1{}, errors.New("private key must be 32 bytes of hex")
	}
	return secp256k1.PrivKeySecp256k1(raw), nil
}
