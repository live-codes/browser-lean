# A build environment for Lean 4 on wasm32, single-threaded.
#
# Adapted from the fork's own `docker-wasm/Dockerfile` (cauli/lean4, Apache-2.0), which is the
# environment its CI uses. The details that are not guessable are kept exactly: emsdk 4.0.22 (the version
# the pinned build was made with), and the 32-bit multilib toolchain that stage0 needs — stage0 is a
# native i386 `lean` used to compile the oleans and drive the cross-build, and `-m32 -msse2 -mfpmath=sse`
# is not optional there (lean.h rejects x87's FLT_EVAL_METHOD=2).
#
#   docker build -t lean4-wasm-single-threaded .
#   docker run --rm -v "$PWD/out:/out" lean4-wasm-single-threaded [1|2]
#
# See README.md. Nothing here has been run yet; see the status note there.

ARG TARGETPLATFORM=linux/amd64
FROM --platform=$TARGETPLATFORM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    cmake \
    ninja-build \
    ccache \
    python3 \
    xz-utils \
    gcc-multilib \
    g++-multilib \
    clang \
    patch \
    libuv1-dev \
    && rm -rf /var/lib/apt/lists/*

# 32-bit support for stage0: libuv and libc for i386, plus pkg-config pointed at the i386 dir (build.sh).
RUN dpkg --add-architecture i386 && \
    apt-get update && apt-get install -y \
    libuv1-dev:i386 \
    pkg-config \
    libc6-dev:i386 \
    libssl-dev:i386 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 22.04 ships CMake 3.22 and current Lean needs >= 3.25 for block().
RUN pip3 install --no-cache-dir 'cmake>=3.28'

ENV EMSDK=/opt/emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git ${EMSDK} && \
    cd ${EMSDK} && \
    ./emsdk install 4.0.22 && \
    ./emsdk activate 4.0.22

ENV PATH="${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}"
ENV EMSDK_NODE="${EMSDK}/node/20.18.0_64bit/bin/node"

WORKDIR /build
COPY build.sh /build.sh
COPY patches /patches
RUN chmod +x /build.sh

CMD ["/build.sh", "2"]
