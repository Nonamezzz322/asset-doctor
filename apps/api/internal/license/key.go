// Package license mints public license keys and signs short-lived entitlement tokens.
//
// Two distinct credentials:
//   - License KEY  — an opaque, crypto-random string the buyer keeps (pasted into the app to activate).
//     It is a lookup handle, not a secret algorithm; possession is checked server-side against the DB.
//   - Entitlement TOKEN — an ed25519-signed claim ({lic,dev,plan,exp}) the client verifies OFFLINE with
//     an embedded public key. Short-lived, so a revoked license stops refreshing and self-expires.
package license

import (
	"crypto/rand"
	"strings"
)

// Crockford base32 alphabet (no I, L, O, U — avoids look-alikes and accidental words).
const keyAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewKey returns a key like "AD-7Q9K-2M4X-8WZ3-5RT6" — a prefix plus 16 random base32 chars (80 bits).
func NewKey() (string, error) {
	const n = 16
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("AD")
	for i := 0; i < n; i++ {
		if i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(keyAlphabet[int(buf[i])%len(keyAlphabet)])
	}
	return b.String(), nil
}

// NormalizeKey upper-cases and strips spaces so user paste variations match what we stored.
func NormalizeKey(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}
