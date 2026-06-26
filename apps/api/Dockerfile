# Pure-Go build (modernc.org/sqlite → no cgo) → static binary → distroless. Tiny, no shell, no libc.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /data
COPY --from=build /out/api /api
ENV ADDR=:8080 DB_PATH=/data/asset-doctor.db ENV=production
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/api"]
