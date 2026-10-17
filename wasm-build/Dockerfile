# A build environment for Lean 4 on wasm32, single-threaded.
#
# Adapted from the fork's own `docker-wasm/Dockerfile` (cauli/lean4, Apache-2.0), which is the
# environment its CI uses. The details that are not guessable are kept exactly: emsdk 4.0.22 (the version
# the pinned build was made with), and the 32-bit multilib toolchain that stage0 needs — stage0 is a
# native i386 `lean` used to compile the oleans and drive the cross-build, and `-m32 -msse2 -mfpmath=sse`
# is not optional there (lean.h rejects x87's FLT_EVAL_METHOD=2).
#
# Layer order matters here. The emsdk layer is the expensive one (a 355 MB wasm-binaries download), so
# anything likely to be tweaked — the CMake pin, the build script, the patches — sits *after* it. Getting
# this wrong costs a quarter of an hour per edit.
#
#   docker build -t lean4-wasm-single-threaded .
#   docker run --rm -v "$PWD/out:/out" -v "$PWD/cache:/cache" lean4-wasm-single-threaded [1|2]
#
# See README.md for what each variant is and what "success" has to look like.

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

ENV EMSDK=/opt/emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git ${EMSDK} && \
    cd ${EMSDK} && \
    ./emsdk install 4.0.22 && \
    ./emsdk activate 4.0.22

ENV PATH="${EMSDK}:${EMSDK}/upstream/emscripten:${PATH}"
# Deliberately no `EMSDK_NODE`. The fork's Dockerfile pins it to the Node version *its* emsdk install
# happened to fetch (20.18.0), and emsdk 4.0.22 now fetches 24.19.0 — so the pin points at a path that
# does not exist, and `emcc` prefers `EMSDK_NODE` over `node` on `PATH` when it is set. `emsdk_env.sh`
# sets it correctly, and build.sh sources that.

# Ubuntu 22.04 ships CMake 3.22 and current Lean needs >= 3.25 for block().
#
# The upper bound is deliberate, and it is a real difference from the fork's Dockerfile: its
# `cmake>=3.28` now resolves to CMake 4.x, and under CMake 4 this build compiles *stage0* with the
# Emscripten toolchain instead of the native 32-bit clang that `-DSTAGE0_CMAKE_CXX_COMPILER=clang++` asks
# for. The symptom is `em++: error: passing any of -msse2 ... requires passing -msimd128` a few seconds
# into `make stage1`, because the stage0 flags are native-x86 flags (FINDINGS.md §9.1's environment).
RUN pip3 install --no-cache-dir 'cmake>=3.28,<4'

WORKDIR /build
COPY build.sh /build.sh
COPY patches /patches
RUN chmod +x /build.sh

# ENTRYPOINT, not CMD: `docker run <image> 2` replaces CMD outright, so with CMD the variant argument
# arrives as the command and the container tries to execute a file called `2`.
ENTRYPOINT ["/build.sh"]
CMD ["2"]
