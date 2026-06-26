// Command fixturegen writes fixtures/license/entitlement-fixture.json from a FIXED, test-only ed25519
// seed. The fixture is the cross-language contract: the Go side signs it, and the web side
// (apps/web, WebCrypto Ed25519) must verify the exact same token bytes with the exact same public key.
// If either side's encoding drifts, the cross-language test breaks. Regenerate with:
//
//	go run ./tools/fixturegen
//
// The seed here is NOT a production key — never sign real entitlements with it.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
)

// deterministic 32-byte test seed (0x01..0x20)
func testSeed() []byte {
	s := make([]byte, ed25519.SeedSize)
	for i := range s {
		s[i] = byte(i + 1)
	}
	return s
}

type fixture struct {
	Note      string         `json:"_note"`
	Alg       string         `json:"alg"`
	PublicKey string         `json:"publicKeyBase64"`
	Token     string         `json:"token"`
	Claims    license.Claims `json:"claims"`
}

func main() {
	priv := ed25519.NewKeyFromSeed(testSeed())
	pub := priv.Public().(ed25519.PublicKey)

	claims := license.Claims{
		V:    license.TokenVersion,
		Lic:  "AD-FIXT-URE0-TEST-0001",
		Dev:  "device-fixture-abc",
		Plan: "pro",
		Iat:  1_700_000_000,
		Exp:  1_700_604_800,
	}
	tok, err := license.Sign(priv, claims)
	if err != nil {
		panic(err)
	}

	fx := fixture{
		Note:      "test-only ed25519 fixture; the web client must verify this token via WebCrypto. Do NOT use this key in production.",
		Alg:       "ed25519",
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Token:     tok,
		Claims:    claims,
	}
	out, _ := json.MarshalIndent(fx, "", "  ")
	out = append(out, '\n')

	// repo-root/fixtures/license/entitlement-fixture.json  (run from apps/api)
	path := filepath.Join("..", "..", "fixtures", "license", "entitlement-fixture.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(path, out, 0o644); err != nil {
		panic(err)
	}
	println("wrote", path)
}
