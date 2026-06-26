package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"
)

func newKP(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv := newKP(t)
	now := time.Unix(1_700_000_000, 0)
	c := NewClaims("AD-7Q9K-2M4X-8WZ3-5RT6", "dev-abc", "pro", now, 7*24*time.Hour)
	tok, err := Sign(priv, c)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(pub, tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.Lic != c.Lic || got.Dev != c.Dev || got.Plan != "pro" || got.V != TokenVersion {
		t.Fatalf("claims round-trip mismatch: %+v", got)
	}
	if got.Exp != now.Add(7*24*time.Hour).Unix() {
		t.Fatalf("exp mismatch: %d", got.Exp)
	}
	if got.Expired(now) || !got.Expired(now.Add(8*24*time.Hour)) {
		t.Fatal("expiry boundary wrong")
	}
}

func TestVerifyRejectsTamper(t *testing.T) {
	pub, priv := newKP(t)
	tok, _ := Sign(priv, NewClaims("AD-X", "d", "pro", time.Unix(1, 0), time.Hour))

	// flip one char in the payload segment → signature must fail
	bad := []byte(tok)
	bad[0] ^= 0x01 // first char of payload
	if _, err := Verify(pub, string(bad)); err == nil {
		t.Fatal("tampered payload accepted")
	}

	// wrong public key
	otherPub, _ := newKP(t)
	if _, err := Verify(otherPub, tok); err != ErrTokenBadSig {
		t.Fatalf("wrong key: want ErrTokenBadSig, got %v", err)
	}
}

func TestVerifyMalformed(t *testing.T) {
	pub, _ := newKP(t)
	for _, s := range []string{"", "nodot", ".x", "x.", "a.b", strings.Repeat("a", 10) + "." + strings.Repeat("!", 4)} {
		if _, err := Verify(pub, s); err == nil {
			t.Fatalf("malformed %q accepted", s)
		}
	}
}

func TestVerifyVersionGate(t *testing.T) {
	pub, priv := newKP(t)
	c := NewClaims("AD-X", "d", "pro", time.Unix(1, 0), time.Hour)
	c.V = 999
	tok, _ := Sign(priv, c)
	if _, err := Verify(pub, tok); err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("want version error, got %v", err)
	}
}

func TestKeyShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		k, err := NewKey()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(k, "AD-") || len(k) != 22 { // AD + 4*("-"+4)
			t.Fatalf("bad shape: %q (len %d)", k, len(k))
		}
		if seen[k] {
			t.Fatalf("collision: %q", k)
		}
		seen[k] = true
		if NormalizeKey("  "+strings.ToLower(k)+" ") != k {
			t.Fatalf("normalize mismatch for %q", k)
		}
	}
}
