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

	// ProfilePngQuant256: pngquant lossy-indexed PNG (256 colors, Floyd–Steinberg dithering), with a
	// quality FLOOR so a page that can't hit the floor declines (exit 99 → ErrQualityFloor → kept original)
	// instead of emitting an ugly result. DISK-ONLY: a quantized PNG still decodes to full RGBA8888 on the
	// GPU ⇒ ZERO VRAM change. This profile NEVER claims a GPU win — the saving is a smaller download only.
	ProfilePngQuant256 Profile = "pngquant-256-fs"

	// ProfileVipsLanczos3: libvips lanczos3 resample (round24-libvips-lanczos3-resample-op-sidecar.md). The
	// op downscales a FULL-RES source PNG to the request's target W/H with a high-quality lanczos3 kernel —
	// the one downscale kernel the browser canvas resampler can't be steered to. DISK/QUALITY-ONLY: the
	// produced PNG decodes to full RGBA8888 on the GPU ⇒ ZERO VRAM change, and the file is the SAME tier
	// dimensions the browser would have emitted ⇒ NO disk-saving claim either. The ONLY thing it carries is a
	// MEASURED high-frequency-energy retention delta (computed client-side); this profile NEVER claims VRAM.
	ProfileVipsLanczos3 Profile = "vips-lanczos3"
)

// Op names the requested native operation (round13-pngquant-backend.md). The set is CLOSED (SupportedOps):
//   - ktx2     : GPU-texture encode (toktx). The honest VRAM win.
//   - pngquant : lossy-indexed PNG re-compression. DISK-ONLY (decodes to full RGBA on the GPU).
//   - resample : libvips lanczos3 downscale (round24). DISK/QUALITY-ONLY (a tier-dimensioned PNG; NO VRAM).
//                ASYMMETRY (load-bearing): for ktx2/pngquant the Request W/H DESCRIBE the input page; for
//                resample they are the OUTPUT target the source is downscaled TO (the source is full-res).
type Op string

const (
	KTX2     Op = "ktx2"
	PngQuant Op = "pngquant"
	Resample Op = "resample"
)

// SupportedOps is the closed allowlist of ops the HTTP layer validates against (closed set → no surprise
// dispatch). Keep in sync with the Dispatcher's switch and opProfiles.
var SupportedOps = map[Op]bool{
	KTX2:     true,
	PngQuant: true,
	Resample: true,
}

// opProfiles pins the ONE profile each op requires. The HTTP layer rejects any other op×profile pairing
// (e.g. {pngquant, uastc-zstd-mip}) with 415 via RequiredProfile, so a request can never smuggle a toktx
// profile into the pngquant path (or vice versa).
var opProfiles = map[Op]Profile{
	KTX2:     ProfileUASTCZstdMip,
	PngQuant: ProfilePngQuant256,
	Resample: ProfileVipsLanczos3,
}

// RequiredProfile returns the single profile an op accepts, and whether the op is known. The HTTP layer
// uses it to enforce op×profile compatibility (415 on a mismatch) without a hard-coded table at the seam.
func RequiredProfile(op Op) (Profile, bool) {
	p, ok := opProfiles[op]
	return p, ok
}

// Request is one decoded process request. PNG holds the raw uploaded image bytes (never logged).
// W/H ASYMMETRY (round24): for ktx2/pngquant they DESCRIBE the input page; for resample they are the
// OUTPUT target the full-res source PNG is downscaled TO.
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
	// ErrEncodeFailed → 502/500: the native tool ran but failed (bad input, crash). The detailed stderr is
	// logged server-side WITHOUT the image bytes; the client gets a generic code.
	ErrEncodeFailed = errors.New("encode failed")
	// ErrQualityFloor → 422 (M1): pngquant could not meet the pinned quality FLOOR (it exits 99). This is
	// NOT a failure — it is an HONEST DECLINE. The HTTP layer maps it to a distinct 422/quality_floor that
	// the client treats as "kept the original page", so it never pollutes the receipt's `failed` count.
	ErrQualityFloor = errors.New("quality floor not met")
)

// Encoder turns a Request into output bytes (KTX2 for the toktx op, a re-compressed PNG for pngquant).
// The single method keeps the mock trivial. The Dispatcher (dispatch.go) routes a Request to the right
// concrete Encoder by Op.
type Encoder interface {
	Encode(ctx context.Context, req Request) (out []byte, err error)
}

// SupportedProfiles is the closed allowlist the HTTP layer validates against (closed set → no surprise
// flag injection). Keep in sync with whatever each profile maps to in its encoder (flagsFor / pngQuantFlags).
var SupportedProfiles = map[Profile]bool{
	ProfileUASTCZstdMip: true,
	ProfilePngQuant256:  true,
	ProfileVipsLanczos3: true,
}
