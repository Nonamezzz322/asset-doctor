package license

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// TokenVersion is bumped if the claim shape changes; the client rejects unknown versions.
const TokenVersion = 1

// Claims is the entitlement payload. Field order here is irrelevant to verification: the SIGNED
// message is the base64url of whatever JSON bytes the server emitted, and the verifier re-checks the
// signature over those exact bytes before parsing — so there is no canonical-JSON requirement and no
// cross-language ambiguity. The client only needs to base64url-decode and JSON-parse part[0].
type Claims struct {
	V    int    `json:"v"`    // token version
	Lic  string `json:"lic"`  // license key
	Dev  string `json:"dev"`  // device hash (opaque, client-generated random — NOT a fingerprint)
	Plan string `json:"plan"` // e.g. "pro"
	Iat  int64  `json:"iat"`  // issued-at (unix seconds)
	Exp  int64  `json:"exp"`  // expiry (unix seconds)
}

var b64 = base64.RawURLEncoding

// Sign produces a compact token: b64url(payloadJSON) + "." + b64url(ed25519-sig-over-that-b64url).
func Sign(priv ed25519.PrivateKey, c Claims) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	msg := b64.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(msg))
	return msg + "." + b64.EncodeToString(sig), nil
}

var (
	ErrTokenMalformed = errors.New("entitlement: malformed token")
	ErrTokenBadSig    = errors.New("entitlement: signature does not verify")
	ErrTokenVersion   = errors.New("entitlement: unsupported token version")
	ErrTokenExpired   = errors.New("entitlement: token expired")
)

// Verify checks the signature and version and returns the claims. Expiry is NOT enforced here
// (callers decide: the client allows a small skew / fail-soft window). Use Claims.Expired for that.
func Verify(pub ed25519.PublicKey, token string) (Claims, error) {
	var c Claims
	dot := -1
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			dot = i
			break
		}
	}
	if dot <= 0 || dot >= len(token)-1 {
		return c, ErrTokenMalformed
	}
	msg := token[:dot]
	sig, err := b64.DecodeString(token[dot+1:])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return c, ErrTokenMalformed
	}
	if !ed25519.Verify(pub, []byte(msg), sig) {
		return c, ErrTokenBadSig
	}
	payload, err := b64.DecodeString(msg)
	if err != nil {
		return c, ErrTokenMalformed
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return c, ErrTokenMalformed
	}
	if c.V != TokenVersion {
		return c, fmt.Errorf("%w: %d", ErrTokenVersion, c.V)
	}
	return c, nil
}

// Expired reports whether the token's exp is at or before `now`.
func (c Claims) Expired(now time.Time) bool {
	return now.Unix() >= c.Exp
}

// NewClaims builds a claim set valid for ttl starting at `now`.
func NewClaims(lic, dev, plan string, now time.Time, ttl time.Duration) Claims {
	return Claims{
		V:    TokenVersion,
		Lic:  lic,
		Dev:  dev,
		Plan: plan,
		Iat:  now.Unix(),
		Exp:  now.Add(ttl).Unix(),
	}
}
