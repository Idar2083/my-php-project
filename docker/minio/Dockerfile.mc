# linux/amd64 manifest of Docker Official Image golang:alpine (Go 1.27.3).
FROM golang:alpine@sha256:bff16a94c0b4b6d9642581e2a3aa81beb3edb940b2f5a3aac1d22c6a68cb7747 AS build

ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
WORKDIR /src
RUN test "$TARGETOS/$TARGETARCH" = linux/amd64 \
 && test "$(go env GOVERSION)" = go1.27.3 \
 && apk add --no-cache git ca-certificates \
 && git init . \
 && git remote add origin https://github.com/minio/mc.git \
 && git fetch --depth=1 origin 7394ce0dd2a80935aded936b09fa12cbb3cb8096 \
 && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = 7394ce0dd2a80935aded936b09fa12cbb3cb8096
RUN go mod download \
 && go mod verify \
 && mc_ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go 2025-08-13T08:35:41Z)" \
 && go build -trimpath -buildvcs=false -tags kqueue \
    -ldflags "$mc_ldflags" \
    -o /out/mc . \
 && git diff --exit-code -- go.mod go.sum

# BusyBox supplies /bin/sh for the existing Compose bucket-init entrypoint.
FROM alpine:3.22@sha256:dc92f017beea8e7f43263073d717f7bc011228c95d5312e440deb4d035bb4eec
RUN apk add --no-cache ca-certificates
ENV HOME=/tmp
COPY --from=build /out/mc /usr/bin/mc
COPY --from=build /src/LICENSE /src/CREDITS /licenses/
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      org.opencontainers.image.version="RELEASE.2025-08-13T08-35-41Z" \
      org.opencontainers.image.vendor="pizza-backend (community source build)" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENTRYPOINT ["mc"]
