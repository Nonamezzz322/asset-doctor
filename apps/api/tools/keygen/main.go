// Command keygen prints a fresh ed25519 keypair for license signing:
//   - LICENSE_SIGNING_SEED  (base64, 32-byte seed) → set as a server SECRET (Fly secret / env). NEVER commit.
//   - publicKey             (base64, 32 bytes)     → embed in the web client to verify entitlements offline.
//
// Usage: go run ./tools/keygen
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

func main() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	seed := priv.Seed() // 32 bytes
	fmt.Println("# Server secret (set as env, keep private):")
	fmt.Printf("LICENSE_SIGNING_SEED=%s\n\n", base64.StdEncoding.EncodeToString(seed))
	fmt.Println("# Public key (embed in the web client — apps/web .env VITE_LICENSE_PUBKEY):")
	fmt.Printf("VITE_LICENSE_PUBKEY=%s\n", base64.StdEncoding.EncodeToString(pub))
}
