package license

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestEntitlementFixtureRoundTrips guards the cross-language contract from the Go side: the committed
// fixture (also verified by apps/web via WebCrypto) must still verify with the fixture's public key and
// decode to the fixture's claims. If the token encoding changes, regenerate with `go run ./tools/fixturegen`
// AND update the web side — this test breaking is the signal.
func TestEntitlementFixtureRoundTrips(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "fixtures", "license", "entitlement-fixture.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("fixture not found (%v) — run `go run ./tools/fixturegen`", err)
	}
	var fx struct {
		PublicKey string `json:"publicKeyBase64"`
		Token     string `json:"token"`
		Claims    Claims `json:"claims"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	pub, err := base64.StdEncoding.DecodeString(fx.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(pub, fx.Token)
	if err != nil {
		t.Fatalf("fixture token does not verify: %v", err)
	}
	if got != fx.Claims {
		t.Fatalf("claims mismatch:\n got %+v\nwant %+v", got, fx.Claims)
	}
}
