# apps/encoder — KTX2 native-encode SIDECAR.
#
# WHY A SEPARATE IMAGE FROM apps/api: apps/api is a pure-Go (CGO_ENABLED=0) binary on
# gcr.io/distroless/static-debian12 — it has NO shell and CANNOT exec a native CLI. KTX2 encoding shells
# out to `toktx` (KhronosGroup/KTX-Software), so it MUST live in its own image on a base that carries the
# pinned native binary. This image is reached ONLY by apps/api over an internal docker network (see
# README + docker-compose); it is never bound to the host or tailnet.
#
# SECURITY POSTURE (load-bearing): runs as a NON-root user, expects a READ-ONLY root filesystem at
# runtime with a scratch tmpfs mounted at /tmp (the only writable path), holds NO secrets and NO DB.

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

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/ktx.deb \
      "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/${KTX_DEB}" \
 && echo "${KTX_SHA1}  /tmp/ktx.deb" | sha1sum -c - \
 && apt-get install -y --no-install-recommends /tmp/ktx.deb \
 # curl is build-time only; drop it so it is not present at runtime (smaller attack surface).
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/ktx.deb \
 # Prove toktx is present + record its version into the build log (deploy-time sanity check).
 && toktx --version \
 # Resolve the real install path (the .deb installs under /usr) and pin a STABLE absolute symlink so
 # TOKTX_PATH never depends on the .deb's internal layout. Fail the build loudly if toktx is missing.
 && ln -sf "$(command -v toktx)" /usr/local/bin/toktx \
 && test -x /usr/local/bin/toktx

# Non-root system user (no home, login shell disabled).
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin encoder

COPY --from=build /out/encoder /usr/local/bin/encoder

# Defaults: listen on the internal :8090, exec the system toktx, scratch temps under /tmp.
# /tmp MUST be a writable tmpfs at runtime; the rest of the FS is expected read-only (see compose).
ENV ADDR=:8090 \
    TOKTX_PATH=/usr/local/bin/toktx \
    TMP_DIR=/tmp

EXPOSE 8090
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/encoder"]
