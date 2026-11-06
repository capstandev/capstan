// Native parity checker for WASM-made Lighter txs (ported from the B2 spike). Built and run inside the pinned golang
// container against the pinned lighter-go source, with no network.
//
// Input: a JSON array of {chain, txType, txInfo, txHash, pubKey}. For each vector it recomputes the pre-signature
// hash from txInfo and the declared signing chain id, compares it with txHash, and validates the Schnorr signature
// against the hash. Schnorr is randomized, so parity means "same hash and a valid signature", never equal bytes.
// It also hashes the same tx under every other signing id (304, 466324, 300) and counts any signature that still
// validates: that count must be 0.
// Output: one JSON line {"vectors","hash_match","sig_valid","cross_checked","cross_accepted","bad","failures"}.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/elliottech/lighter-go/types/txtypes"
	schnorr "github.com/elliottech/poseidon_crypto/signature/schnorr"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

type vec struct {
	Chain  uint32 `json:"chain"`
	TxType uint8  `json:"txType"`
	TxInfo string `json:"txInfo"`
	TxHash string `json:"txHash"`
	PubKey string `json:"pubKey"`
}

type hasher interface {
	Hash(lighterChainId uint32) ([]byte, error)
}

var chains = []uint32{304, 466324, 300}

func decode(v vec) (hasher, []byte, error) {
	switch v.TxType {
	case txtypes.TxTypeL2CreateOrder:
		var t txtypes.L2CreateOrderTxInfo
		err := json.Unmarshal([]byte(v.TxInfo), &t)
		return &t, t.Sig, err
	case txtypes.TxTypeL2CancelOrder:
		var t txtypes.L2CancelOrderTxInfo
		err := json.Unmarshal([]byte(v.TxInfo), &t)
		return &t, t.Sig, err
	case txtypes.TxTypeL2CancelAllOrders:
		var t txtypes.L2CancelAllOrdersTxInfo
		err := json.Unmarshal([]byte(v.TxInfo), &t)
		return &t, t.Sig, err
	case txtypes.TxTypeL2ChangePubKey:
		var t txtypes.L2ChangePubKeyTxInfo
		err := json.Unmarshal([]byte(v.TxInfo), &t)
		return &t, t.Sig, err
	case txtypes.TxTypeL2ApproveIntegrator:
		var t txtypes.L2ApproveIntegratorTxInfo
		err := json.Unmarshal([]byte(v.TxInfo), &t)
		return &t, t.Sig, err
	}
	return nil, nil, fmt.Errorf("unsupported txType %d", v.TxType)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: parity <vectors.json>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var vs []vec
	if err := json.Unmarshal(raw, &vs); err != nil {
		panic(err)
	}
	okHash, okSig, cross, crossAccepted, bad := 0, 0, 0, 0, 0
	failures := []string{}
	fail := func(i int, why string) {
		bad++
		if len(failures) < 5 {
			failures = append(failures, fmt.Sprintf("%d: %s", i, why))
		}
	}
	for i, v := range vs {
		tx, sig, err := decode(v)
		if err != nil {
			fail(i, "decode: "+err.Error())
			continue
		}
		h, err := tx.Hash(v.Chain)
		if err != nil {
			fail(i, "hash: "+err.Error())
			continue
		}
		if common.Bytes2Hex(h) == v.TxHash {
			okHash++
		} else {
			fail(i, "hash mismatch")
		}
		pk, err := hexutil.Decode(v.PubKey)
		if err != nil {
			fail(i, "pubkey: "+err.Error())
			continue
		}
		if schnorr.Validate(pk, h, sig) == nil {
			okSig++
		} else {
			fail(i, "signature does not validate")
		}
		for _, other := range chains {
			if other == v.Chain {
				continue
			}
			h2, err := tx.Hash(other)
			if err != nil {
				continue
			}
			cross++
			if schnorr.Validate(pk, h2, sig) == nil {
				crossAccepted++
				fail(i, fmt.Sprintf("signature for %d also validates under %d", v.Chain, other))
			}
		}
	}
	out, _ := json.Marshal(map[string]interface{}{
		"vectors": len(vs), "hash_match": okHash, "sig_valid": okSig, "cross_checked": cross,
		"cross_accepted": crossAccepted, "bad": bad, "failures": failures,
	})
	fmt.Println(string(out))
}
