// Package encode defines the KTX2 encoding seam. The Encoder interface is the mockable boundary:
// production wires toktxEncoder (shells to the pinned `toktx` binary); tests inject a fake so the whole
// HTTP/caps/error-mapping surface is unit-testable WITHOUT toktx installed (gate runs build+vet+test
// with no native binary present).
package encode

import (
	"context"
	"errors"
)

// Profile is a pinned, named set of toktx flags. Deterministic bytes require a fixed profile + a pinned
// toktx version (recorded in the Dockerfile and the receipt). v1 ships exactly one profile.
type Profile string

const (
	// ProfileUASTCZstdMip: UASTC (LDR 4x4) + Zstd supercompression + a full mip chain. This is the one
	// honest GPU-VRAM win: a block-compressed texture is ~1 byte/px WORST-CASE (ASTC/BC7), never w*h*4.
	ProfileUASTCZstdMip Profile = "uastc-zstd-mip"
)

// Op names the requested native operation. v1 has exactly one: ktx2 encode.
type Op string

const KTX2 Op = "ktx2"

// Request is one decoded process request. PNG holds the raw uploaded image bytes (never logged).
type Request struct {
	PNG     []byte
	W       int
	H       int
	Op      Op
	Profile Profile
}

// Errors surfaced by encoders are classified so the HTTP layer can map them to stable status codes
// without ever leaking image bytes or a native stderr blob to the client.
var (
	// ErrUnsupported → 415: an op/profile we don't implement.
	ErrUnsupported = errors.New("unsupported op or profile")
	// ErrEncodeFailed → 502/500: toktx ran but failed (bad input, crash). The detailed stderr is logged
	// server-side WITHOUT the image bytes; the client gets a generic code.
	ErrEncodeFailed = errors.New("encode failed")
)

// Encoder turns a Request into KTX2 bytes. The single method keeps the mock trivial.
type Encoder interface {
	Encode(ctx context.Context, req Request) (ktx2 []byte, err error)
}

// SupportedProfiles is the closed allowlist the HTTP layer validates against (closed set → no surprise
// flag injection). Keep in sync with whatever ProfileUASTCZstdMip maps to in toktxEncoder.
var SupportedProfiles = map[Profile]bool{
	ProfileUASTCZstdMip: true,
}
