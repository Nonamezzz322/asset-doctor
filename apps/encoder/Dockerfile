# apps/encoder — native-encode SIDECAR (KTX2 via toktx + lossy-indexed PNG via pngquant + lanczos3 resample
# via libvips).
#
# WHY A SEPARATE IMAGE FROM apps/api: apps/api is a pure-Go (CGO_ENABLED=0) binary on
# gcr.io/distroless/static-debian12 — it has NO shell and CANNOT exec a native CLI. KTX2 encoding shells
# out to `toktx` (KhronosGroup/KTX-Software), lossy-PNG to `pngquant`, and lanczos3 downscale to `vips`
# (libvips-tools), so they MUST live in their own image on a base that carries the pinned native binaries.
# This image is reached ONLY by apps/api over an internal docker network (see README + docker-compose); it is
# never bound to the host or tailnet.
#
# SECURITY POSTURE (load-bearing): runs as a NON-root user, expects a READ-ONLY root filesystem at
# runtime with a scratch tmpfs mounted at /tmp (the only writable path), holds NO secrets and NO DB.
# pngquant (round13) and vips (round24) read PNG from STDIN and write to STDOUT — they need NO writable path
# of their own.

# ---- Stage 1: build the Go binary (static, no cgo) ----
FROM golang:1.26-bookworm AS build
WORKDIR /src
# Zero non-stdlib deps → no go.sum, nothing to download. Copy the module file then sources.
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/encoder ./cmd/encoder

# ---- Stage 2: runtime — debian-slim carrying the pinned toktx ----
# debian-slim (NOT distroless) because toktx is a DYNAMICALLY-linked native binary needing libc + a few
# shared libs; installing the official .deb pulls its declared runtime deps in.
#
# PIN: KTX-Software v4.4.2 (the KTX2 reference writer). Bumping the version is DELIBERATE — re-verify the
# sha1 when you do, because changing the toktx version changes output bytes and breaks the receipt's
# determinism claim. The sha1 below is published alongside the asset
# (KTX-Software-4.4.2-Linux-x86_64.deb.sha1).
FROM debian:bookworm-slim AS runtime
ARG KTX_VERSION=4.4.2
ARG KTX_DEB=KTX-Software-${KTX_VERSION}-Linux-x86_64.deb
ARG KTX_SHA1=b7d4a0833a5aff570f01f56413e40ea8db291212

# PIN: pngquant from the Debian bookworm repo. Pinning the exact apt version keeps OUTPUT BYTES stable —
# pngquant is built against libimagequant, and a point-release can change dithering bytes, so a bump is
# DELIBERATE: re-run the determinism golden (round13 M3) when you change this. Override at build time with
# --build-arg PNGQUANT_VERSION=… if the repo moves. IMAGE-SIZE (honest): pngquant pulls libpng16-16 +
# libimagequant0 (both small; libpng is usually already pulled by the base/toktx deps), so the net add is a
# single-digit-MB binary + at most one small lib — NO new network capability, posture unchanged.
ARG PNGQUANT_VERSION=2.17.0-1

# PIN: libvips-tools from the Debian bookworm repo (round24 lanczos3 resample). Pinning the exact apt
# version keeps OUTPUT BYTES stable — a libvips point-release can change the lanczos3 reducer's bytes, so a
# bump is DELIBERATE: re-run the determinism golden when you change this. Override at build time with
# --build-arg VIPS_VERSION=… if the repo moves. IMAGE-SIZE (honest): libvips-tools pulls libvips42 + a few
# image-codec libs (libpng/libjpeg/libwebp — most already present via the base/pngquant deps), so the net add
# is libvips42 + the `vips` CLI — NO new network capability, posture unchanged (stdin/stdout, no temp files).
ARG VIPS_VERSION=8.14.1-3+deb12u1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 # pngquant: pinned apt package (round13). Fails the build loudly if the pinned version is unavailable.
 && apt-get install -y --no-install-recommends "pngquant=${PNGQUANT_VERSION}" \
 # libvips-tools: pinned apt package (round24). Provides the `vips` CLI for the lanczos3 resample op. Fails
 # the build loudly if the pinned version is unavailable.
 && apt-get install -y --no-install-recommends "libvips-tools=${VIPS_VERSION}" \
 && curl -fsSL -o /tmp/ktx.deb \
      "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/${KTX_DEB}" \
 && echo "${KTX_SHA1}  /tmp/ktx.deb" | sha1sum -c - \
 && apt-get install -y --no-install-recommends /tmp/ktx.deb \
 # curl is build-time only; drop it so it is not present at runtime (smaller attack surface).
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/ktx.deb \
 # Prove all native tools are present + record their versions into the build log (deploy-time sanity check
 # + the determinism-pin discipline: a version line in the log to compare against on a bump).
 && toktx --version \
 && pngquant --version \
 && vips --version \
 # Resolve the real install paths and pin STABLE absolute symlinks so TOKTX_PATH/PNGQUANT_PATH/VIPS_PATH never
 # depend on a package's internal layout. Fail the build loudly if any binary is missing.
 && ln -sf "$(command -v toktx)" /usr/local/bin/toktx \
 && test -x /usr/local/bin/toktx \
 && ln -sf "$(command -v pngquant)" /usr/local/bin/pngquant \
 && test -x /usr/local/bin/pngquant \
 && ln -sf "$(command -v vips)" /usr/local/bin/vips \
 && test -x /usr/local/bin/vips

# Non-root system user (no home, login shell disabled).
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin encoder

COPY --from=build /out/encoder /usr/local/bin/encoder

# Defaults: listen on the internal :8090, exec the system toktx + pngquant + vips, scratch temps under /tmp.
# /tmp MUST be a writable tmpfs at runtime; the rest of the FS is expected read-only (see compose).
# pngquant + vips stream via stdin/stdout (vips uses /dev/stdin → /dev/stdout) so they do not write to /tmp —
# only toktx does.
ENV ADDR=:8090 \
    TOKTX_PATH=/usr/local/bin/toktx \
    PNGQUANT_PATH=/usr/local/bin/pngquant \
    VIPS_PATH=/usr/local/bin/vips \
    TMP_DIR=/tmp

EXPOSE 8090
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/encoder"]
