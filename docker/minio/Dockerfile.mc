# linux/amd64 manifest of Docker Official Image golang:alpine (Go 1.27.3).
FROM golang:alpine@sha256:bff16a94c0b4b6d9642581e2a3aa81beb3edb940b2f5a3aac1d22c6a68cb7747 AS build

ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOTOOLCHAIN=local GOFLAGS=-mod=readonly GOPROXY=off GOSUMDB=off
WORKDIR /src
COPY --from=mc-source /mc-source.tar /tmp/mc-source.tar
COPY --from=mc-git / /src/.git/
COPY --from=gomodcache / /go/pkg/mod/
COPY --from=apk-build / /tmp/apks/
RUN --network=none test "$TARGETOS/$TARGETARCH" = linux/amd64 \
 && test "$(go env GOVERSION)" = go1.27.3 \
 && echo '65a15435c1df05f82a3ac168759772ccac8aa01660a3d3bc23dd4c70dad442b1  /tmp/apks/SHA256SUMS' | sha256sum -c - \
 && (cd /tmp/apks && sha256sum -c SHA256SUMS) \
 && apk --repositories-file /dev/null add --no-cache --no-network /tmp/apks/*.apk \
 && rm -rf /tmp/apks \
 && test "$(sha256sum /tmp/mc-source.tar | cut -d' ' -f1)" = 3a4e9b4b48ad0cd5ce87e6d0a2e67959e44e47f576a52c2837179ddff9e814e2 \
 && tar -xf /tmp/mc-source.tar -C /src \
 && rm /tmp/mc-source.tar \
 && test "$(git log --format=%H -n1)" = 7394ce0dd2a80935aded936b09fa12cbb3cb8096 \
 && test "$(sha256sum go.mod | cut -d' ' -f1)" = 76dbbad8795627d32a7d1a271d0b6a16a6bd4c0956262467a3b54d36ae67d622 \
 && test "$(sha256sum go.sum | cut -d' ' -f1)" = 1592c97fca12c8ccb99f3bf1a3dc3627f4449e3b29ae78c3ff84e33e2acc8bf9 \
 && git diff --exit-code -- go.mod go.sum
RUN --network=none go mod download \
 && go mod verify \
 && mc_ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go 2025-08-13T08:35:41Z)" \
 && go build -trimpath -buildvcs=false -tags kqueue \
    -ldflags "$mc_ldflags" \
    -o /out/mc . \
 && test "$(sha256sum go.mod | cut -d' ' -f1)" = 76dbbad8795627d32a7d1a271d0b6a16a6bd4c0956262467a3b54d36ae67d622 \
 && test "$(sha256sum go.sum | cut -d' ' -f1)" = 1592c97fca12c8ccb99f3bf1a3dc3627f4449e3b29ae78c3ff84e33e2acc8bf9

# BusyBox supplies /bin/sh for the existing Compose bucket-init entrypoint.
FROM alpine:3.22@sha256:dc92f017beea8e7f43263073d717f7bc011228c95d5312e440deb4d035bb4eec
COPY --from=apk-runtime / /tmp/apks/
RUN --network=none echo '0ed36d748bb1743b92ba9c45b7426bda58d2423d1fa638535945aa4fb9757dd6  /tmp/apks/SHA256SUMS' | sha256sum -c - \
 && (cd /tmp/apks && sha256sum -c SHA256SUMS) \
 && apk --repositories-file /dev/null add --no-cache --no-network /tmp/apks/*.apk \
 && rm -rf /tmp/apks
ENV HOME=/tmp
COPY --from=build /out/mc /usr/bin/mc
COPY --from=build /src/LICENSE /src/CREDITS /src/NOTICE /licenses/
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="7394ce0dd2a80935aded936b09fa12cbb3cb8096" \
      org.opencontainers.image.version="RELEASE.2025-08-13T08-35-41Z" \
      org.opencontainers.image.vendor="pizza-backend (community source build)" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENTRYPOINT ["mc"]
