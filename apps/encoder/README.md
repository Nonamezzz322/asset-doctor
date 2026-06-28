# apps/encoder — KTX2 native-encode sidecar

A tiny Go HTTP service that turns a PNG into a **KTX2** (UASTC + Zstd supercompression + baked mips)
texture by shelling out to the pinned [`toktx`](https://github.com/KhronosGroup/KTX-Software) binary.

This is the **opt-in backend** half of Asset Doctor's fix engine. It exists because the browser cannot
produce GPU block-compressed textures, and the pure-Go `apps/api` (distroless/static, no shell) cannot exec
a native CLI. So native-only encoding lives here, in a separate image, reached **only** by `apps/api`.

> **Default OFF.** This service is dead weight unless the web client explicitly enables the backend path
> for a run. With `FixOptions.backend` absent, the browser does the entire fix locally and the output zip
> is byte-identical to today — assets never leave the device. The backend is an **opt-in fallback** that
> requires explicit per-run user consent ("these images are sent to the server"), a valid license token
> (verified upstream in `apps/api`), and is rate-limited + quota-capped.

## Why a separate service (not part of `apps/api`)

`apps/api` is `CGO_ENABLED=0` Go on `gcr.io/distroless/static-debian12` — **no shell, no libc, cannot exec
`toktx`**. Fattening that image to carry a native CLI would also bloat the billing service's CVE surface.
So `apps/api` stays thin and acts as the **gateway**: it verifies the license entitlement, applies
per-license quota + a body-size cap, then **reverse-proxies** the request to this sidecar over an
**internal docker network**. This sidecar is never bound to the host or tailnet.

```
browser ──▶ apps/api  (license-verify + quota + proxy)  ──internal──▶ apps/encoder ──▶ toktx
```

## External dependency: `toktx` (KTX-Software)

- **Pinned version:** `v4.4.2` (the KTX2 reference writer). Pinned in the `Dockerfile` via `KTX_VERSION`
  + a verified `sha1` of the official `KTX-Software-4.4.2-Linux-x86_64.deb`.
- **Why pinned:** the encode profile (`uastc-zstd-mip`) + a fixed `toktx` version ⇒ **deterministic output
  bytes**. Bumping `toktx` is a deliberate change — re-verify the sha1 (published as the asset's
  `.deb.sha1`) and expect output bytes to change (which changes any "determinism" claim in the fix receipt).
- **The build does NOT require `toktx` locally.** `go build`/`go vet`/`go test` are all green with no native
  binary present — the exec is behind the `encode.Encoder` interface, mocked in tests. `toktx` is only
  needed at **runtime / in the Docker image** (and for a live KTX2 end-to-end check).

### Installing `toktx` for a local live test (optional)

```
# Debian/Ubuntu, x86_64
curl -fsSL -o /tmp/ktx.deb \
  https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.deb
echo "b7d4a0833a5aff570f01f56413e40ea8db291212  /tmp/ktx.deb" | sha1sum -c -
sudo apt-get install -y /tmp/ktx.deb
toktx --version
```

## Endpoints

### `GET /healthz`
Liveness/readiness. `200 {"status":"ok"}`. Deliberately leaks nothing about the binary inventory.

### `POST /process`  (internal — gateway only)
JSON body:

```json
{ "png": "<base64 PNG bytes>", "w": 2048, "h": 2048, "op": "ktx2", "profile": "uastc-zstd-mip" }
```

On success: `200 application/octet-stream` with the raw `.ktx2` bytes. Errors are structured JSON
`{ "error": "...", "code": "..." }` (the same shape `apps/api` uses, so the gateway passes it through):

| Status | `code`                    | When |
|--------|---------------------------|------|
| 400    | `bad_request`             | malformed JSON, unknown field, bad base64, empty png |
| 413    | `payload_too_large`       | body or decoded PNG exceeds the size cap |
| 415    | `unsupported_op`          | `op` is not `ktx2` |
| 415    | `unsupported_profile`     | `profile` not in the closed allowlist |
| 415    | `dimensions_out_of_range` | `w`/`h` ≤ 0 or > `MAX_DIM` |
| 415    | `too_many_pixels`         | `w*h` > `MAX_PIXELS` |
| 503    | `busy`                    | concurrency cap reached (`Retry-After` set) |
| 502    | `encode_failed`           | `toktx` ran but failed |
| 500    | `internal`                | unexpected |

## Privacy & safety guarantees (load-bearing)

- **No persistence.** Temp-in/temp-out files are created in a scratch tmpfs and **unlinked in a `finally`**
  (deferred), success or failure. An **orphan-temp sweeper** is the backstop for a hard crash that skips
  the defers (it only ever deletes files matching the encoder's own `enc-in-`/`enc-out-` prefixes, older
  than an age that exceeds the exec timeout, so it never races a live encode).
- **No image-byte logging.** Image bytes never appear in any log line or in any error returned to the
  client (covered by a test). `toktx` stderr (dimensions/flags/errors — never pixels) is logged
  server-side only, trimmed.
- **No secrets here.** No DB, no signing seed, no Stripe keys. Entitlement is verified upstream in
  `apps/api` before a request reaches this service.
- **Hardened container.** Non-root user, read-only root FS, dropped capabilities, `no-new-privileges`, a
  size-bounded `noexec,nosuid` tmpfs as the only writable path.
- **Caps everywhere.** Size (413), dimension/pixel (415), concurrency (503), per-exec timeout.

## Honest VRAM (the moat)

A KTX2/block-compressed texture is **NOT** `w·h·4`. Its resident VRAM is a **worst-case ceiling of
~1 byte/px** (ASTC-4x4 / BC7); on GPUs that transcode UASTC down to BC1/ETC1 it is ~0.5 byte/px, so the
real footprint is **≤** the charged number. The `×4/3` mip overhead is added **only** because this profile
bakes mips. The fix receipt must surface this as a **ceiling with a fallback caveat** (raster `w·h·4` on
GPUs without block-compression support) — never as an exact value and never faked. The receipt must also
disclose that the zip gets **larger** (it ships both `.ktx2` and the raster fallback) and that the game
must add the Pixi KTX2 transcoder (`import 'pixi.js/ktx2'`) + a loader.

## Configuration (env)

| Var              | Default        | Meaning |
|------------------|----------------|---------|
| `ADDR`           | `:8090`        | listen address (internal network only) |
| `TOKTX_PATH`     | `toktx`        | path to the pinned binary (image sets `/usr/local/bin/toktx`) |
| `TMP_DIR`        | OS temp        | scratch dir (a tmpfs in the image) |
| `MAX_BODY_BYTES` | `33554432`     | 32 MiB decoded-PNG cap → 413 |
| `MAX_DIM`        | `8192`         | per-side cap → 415 |
| `MAX_PIXELS`     | `67108864`     | `w*h` cap → 415 |
| `MAX_CONCURRENT` | `2`            | simultaneous encodes → 503 when full |
| `EXEC_TIMEOUT`   | `120s`         | per-`toktx`-exec wall |
| `SWEEP_INTERVAL` | `5m`           | orphan-temp sweep cadence |
| `SWEEP_MAX_AGE`  | `10m`          | orphan age before deletion (must exceed `EXEC_TIMEOUT`) |

## Build / test

```
cd apps/encoder
go build ./...   # no toktx needed
go vet ./...
go test ./...    # exec is mocked behind encode.Encoder
```

## Run on this PC (docker-compose)

See [`docker-compose.example.yml`](./docker-compose.example.yml). It puts `apps/api` on the edge network
(host `8088` → container `8080`, reachable over the tailnet) and `apps/encoder` on an **internal-only**
network with **no published port**, so only `apps/api` can reach it at `http://encoder:8090`. The gateway
is told where to proxy via `ENCODER_URL`.

```
cp docker-compose.example.yml docker-compose.yml
docker compose build
docker compose up -d
# the encoder is NOT reachable from the host — verify via the gateway, not directly.
docker compose exec encoder /usr/local/bin/toktx --version   # sanity: toktx present in the sidecar
```

> The matching `apps/api` gateway changes (entitlement middleware, quota, the reverse proxy + `ENCODER_URL`
> config) are tracked separately (T7–T11 in `docs/improvements/round12-backend-processing.md`). This
> README + service cover the sidecar half (T4–T6); the gateway forwards to it.
