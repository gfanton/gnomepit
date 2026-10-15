package signer

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/std"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"gnomehall/client/signer/auth"
	"gnomehall/client/signer/vm"
)

const (
	chainID   = "dev"
	masterKey = "0101010101010101010101010101010101010101010101010101010101010101"
	otherKey  = "0202020202020202020202020202020202020202020202020202020202020202"
)

func keyOf(t *testing.T, privHex string) Key {
	t.Helper()
	k, err := KeyInfo(privHex)
	require.NoError(t, err)
	return k
}

func callMsg(t *testing.T, caller string) Msg {
	t.Helper()
	value := `{"caller":"` + caller + `","send":"","max_deposit":"","pkg_path":"gno.land/r/gfanton/gnomehall/arena","func":"Play","args":["1","Pick,Pick,Pick"]}`
	return Msg{Type: "/vm.m_call", Value: json.RawMessage(value)}
}

func sessionMsg(t *testing.T, creator string, sessionPub string) Msg {
	t.Helper()
	value := `{"creator":"` + creator + `","session_key":{"@type":"/tm.PubKeySecp256k1","value":"` + sessionPub + `"},` +
		`"expires_at":"1760000000","allow_paths":["vm/exec:gno.land/r/gfanton/gnomehall/arena"],"spend_limit":"1000000ugnot","spend_period":"0"}`
	return Msg{Type: "/auth.m_create_session", Value: json.RawMessage(value)}
}

func decodeTx(t *testing.T, encoded string) std.Tx {
	t.Helper()
	bz, err := base64.StdEncoding.DecodeString(encoded)
	require.NoError(t, err)
	var tx std.Tx
	require.NoError(t, amino.Unmarshal(bz, &tx))
	return tx
}

func TestKeyInfo(t *testing.T) {
	k := keyOf(t, masterKey)
	assert.True(t, strings.HasPrefix(k.Address, "g1"))
	pub, err := base64.StdEncoding.DecodeString(k.PubKey)
	require.NoError(t, err)
	assert.Len(t, pub, 33)
	assert.Equal(t, k, keyOf(t, masterKey))
	assert.NotEqual(t, k.Address, keyOf(t, otherKey).Address)
}

func TestKeyInfoRejectsBadKeys(t *testing.T) {
	cases := map[string]string{
		"zero":         strings.Repeat("00", 32),
		"curve order":  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
		"short":        strings.Repeat("01", 31),
		"not hex":      strings.Repeat("zz", 32),
		"empty string": "",
	}
	for name, key := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := KeyInfo(key)
			assert.Error(t, err)
		})
	}
}

func TestSignTxVerifies(t *testing.T) {
	master := keyOf(t, masterKey)
	encoded, err := SignTx(TxRequest{
		ChainID: chainID, AccountNumber: 7, Sequence: 3, PrivKey: masterKey,
		Fee: Fee{GasWanted: 50_000_000, GasFee: "50000ugnot"}, Memo: "m",
		Msgs: []Msg{callMsg(t, master.Address)},
	})
	require.NoError(t, err)

	tx := decodeTx(t, encoded)
	require.Len(t, tx.Msgs, 1)
	call, ok := tx.Msgs[0].(vm.MsgCall)
	require.True(t, ok, "message is %T", tx.Msgs[0])
	assert.Equal(t, "Play", call.Func)
	assert.Equal(t, []string{"1", "Pick,Pick,Pick"}, call.Args)
	assert.Equal(t, int64(50_000_000), tx.Fee.GasWanted)
	assert.Equal(t, "50000ugnot", tx.Fee.GasFee.String())

	require.Len(t, tx.Signatures, 1)
	sig := tx.Signatures[0]
	assert.True(t, sig.SessionAddr.IsZero())
	signBytes, err := tx.GetSignBytes(chainID, 7, 3)
	require.NoError(t, err)
	assert.True(t, sig.PubKey.VerifyBytes(signBytes, sig.Signature))
	other, err := tx.GetSignBytes(chainID, 7, 4)
	require.NoError(t, err)
	assert.False(t, sig.PubKey.VerifyBytes(other, sig.Signature))
	assert.Equal(t, master.Address, sig.PubKey.Address().String())
}

func TestSessionSignature(t *testing.T) {
	master, session := keyOf(t, masterKey), keyOf(t, otherKey)
	encoded, err := SignTx(TxRequest{
		ChainID: chainID, PrivKey: otherKey, SessionAddr: session.Address,
		Fee: Fee{GasWanted: 1, GasFee: "1ugnot"}, Msgs: []Msg{callMsg(t, master.Address)},
	})
	require.NoError(t, err)

	sig := decodeTx(t, encoded).Signatures[0]
	assert.Equal(t, session.Address, sig.SessionAddr.String())
	assert.Equal(t, session.Address, sig.PubKey.Address().String())
}

func TestCreateSessionMessage(t *testing.T) {
	master, session := keyOf(t, masterKey), keyOf(t, otherKey)
	encoded, err := SignTx(TxRequest{
		ChainID: chainID, PrivKey: masterKey, Fee: Fee{GasWanted: 1, GasFee: "1ugnot"},
		Msgs: []Msg{sessionMsg(t, master.Address, session.PubKey)},
	})
	require.NoError(t, err)

	msg, ok := decodeTx(t, encoded).Msgs[0].(auth.MsgCreateSession)
	require.True(t, ok)
	assert.Equal(t, session.Address, msg.SessionKey.Address().String())
	assert.Equal(t, int64(1760000000), msg.ExpiresAt)
	assert.Equal(t, []crypto.Address{msg.Creator}, msg.GetSigners())
}

func TestSignTxRejects(t *testing.T) {
	master := keyOf(t, masterKey)
	good := TxRequest{ChainID: chainID, PrivKey: masterKey, Fee: Fee{GasWanted: 1, GasFee: "1ugnot"}, Msgs: []Msg{callMsg(t, master.Address)}}
	cases := map[string]func(r *TxRequest){
		"no message":                  func(r *TxRequest) { r.Msgs = nil },
		"unknown type":                func(r *TxRequest) { r.Msgs = []Msg{{Type: "/bank.MsgSend", Value: json.RawMessage(`{}`)}} },
		"bad value":                   func(r *TxRequest) { r.Msgs = []Msg{{Type: "/vm.m_call", Value: json.RawMessage(`{"caller":"nope"}`)}} },
		"bad fee":                     func(r *TxRequest) { r.Fee.GasFee = "lots" },
		"bad session":                 func(r *TxRequest) { r.SessionAddr = "g1nope" },
		"no chain":                    func(r *TxRequest) { r.ChainID = "" },
		"bad key":                     func(r *TxRequest) { r.PrivKey = "00" },
		"message fails ValidateBasic": func(r *TxRequest) { r.Msgs = []Msg{callMsg(t, "")} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := good
			mutate(&r)
			_, err := SignTx(r)
			assert.Error(t, err)
		})
	}
}

func TestSignBytesIsDeterministic(t *testing.T) {
	data := []byte("Gnomehall at http://127.0.0.1:8080")
	a, err := SignBytes(masterKey, data)
	require.NoError(t, err)
	b, err := SignBytes(masterKey, data)
	require.NoError(t, err)
	assert.Equal(t, a, b)

	raw, err := hex.DecodeString(masterKey)
	require.NoError(t, err)
	assert.True(t, secp256k1.PrivKeySecp256k1(raw).PubKey().VerifyBytes(data, a))
}

// TestMirrorsEncodeLikeTheChain encodes each message with the chain's own types, in a
// separate program since amino refuses two types under one name in one binary, and
// compares the bytes with the mirrors'. The program is its own module, so that linking
// the VM stays out of this one; both must require the same gno version.
func TestMirrorsEncodeLikeTheChain(t *testing.T) {
	assert.Equal(t, gnoVersion(t, "../../go.mod"), gnoVersion(t, "testdata/encode/go.mod"))
	master, session := keyOf(t, masterKey), keyOf(t, otherKey)
	for _, msg := range []Msg{callMsg(t, master.Address), sessionMsg(t, master.Address, session.PubKey)} {
		t.Run(msg.Type, func(t *testing.T) {
			input, err := json.Marshal(msg)
			require.NoError(t, err)
			cmd := exec.Command("go", "run", ".")
			cmd.Dir = "testdata/encode"
			cmd.Stdin = bytes.NewReader(input)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			want, err := cmd.Output()
			require.NoError(t, err, stderr.String())

			decoded, err := decodeMsg(msg)
			require.NoError(t, err)
			got, err := encodeForComparison(decoded)
			require.NoError(t, err)
			assert.Equal(t, strings.TrimSpace(string(want)), got)
		})
	}
}

// gnoVersion returns the gno module version the go.mod at path requires.
func gnoVersion(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	for line := range strings.Lines(string(data)) {
		line = strings.TrimPrefix(strings.TrimSpace(line), "require ")
		if rest, ok := strings.CutPrefix(line, "github.com/gnolang/gno "); ok {
			return strings.Fields(rest)[0]
		}
	}
	t.Fatalf("%s requires no gno version", path)
	return ""
}

// encodeForComparison renders msg as testdata/encode prints the chain's types: the hex
// of its amino binary as an Any, then its amino JSON.
func encodeForComparison(msg std.Msg) (string, error) {
	bin, err := amino.MarshalAny(msg)
	if err != nil {
		return "", err
	}
	js, err := amino.MarshalJSON(msg)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(bin) + "\n" + string(js), nil
}
