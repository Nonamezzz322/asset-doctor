// apps/encoder — KTX2 native-encode SIDECAR. SEPARATE module + image from apps/api on purpose:
// apps/api is pure-Go on distroless/static (no shell, cannot exec a native CLI). This sidecar runs on a
// debian-slim base that carries the pinned `toktx` binary. It is reached ONLY by apps/api on an internal
// docker network — never bound to host/tailnet. Zero non-stdlib deps: smallest possible CVE surface.
module github.com/Nonamezzz322/asset-doctor/apps/encoder

go 1.25.0
