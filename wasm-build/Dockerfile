# A build environment for Lean 4 on wasm32, single-threaded.
#
#   docker build -t lean4-wasm-single-threaded .
#   docker run --rm -v "$PWD/out:/out" -v "$PWD/cache:/cache" lean4-wasm-single-threaded [1|2]
#
# See README.md for what each variant is and what "success" has to look like.
#
# Two decisions worth knowing, both arrived at by trying the obvious thing first:
#
# 1. **The toolchain comes from `emscripten/emsdk:4.0.22`, not from emsdk's installer.** emsdk's own
#    `install` fetches a 355 MB `wasm-binaries.tar.xz`, and on this network it arrived truncated twice —
#    at the right byte count, but corrupt, so `tar` reported `xz: Unexpected end of input` and the build
#    failed with what reads like a broken toolchain. Pre-downloading it with `curl --retry -C -` and
#    asserting the size did not help. The official image ships the same emsdk version already installed,
#    with a valid `EMSDK_NODE` and no download step at all. The trade is that this Dockerfile no longer
#    mirrors the fork's, it inherits a maintained one.
#
# 2. **CMake is installed on top and pinned below 4.** The image's CMake is 3.22 and Lean needs >= 3.25
#    for `block()`; `cmake>=3.28` alone now resolves to CMake 4.x, under which this build compiles
#    *stage0* with the Emscripten toolchain instead of the native 32-bit clang the CI asks for — and it
#    dies seconds into `make stage1` with `em++: error: passing any of -msse2 ... requires passing
#    -msimd128`, because the stage0 flags are native-x86 flags being handed to a wasm compiler.
#
# What the base image does not bring is the 32-bit multilib toolchain: stage0 is a native i386 `lean`
# used to compile the oleans and drive the cross-build, and `-m32 -msse2 -mfpmath=sse` is not optional
# there (lean.h rejects x87's FLT_EVAL_METHOD=2).
FROM emscripten/emsdk:4.0.22

ENV DEBIAN_FRONTEND=noninteractive

# `Acquire::Retries` because this network is demonstrably flaky: it has already served a truncated
# 355 MB download and failed container DNS twice mid-build. apt gives up on the first resolution failure.
RUN apt-get update -o Acquire::Retries=5 && apt-get install -y -o Acquire::Retries=5 \
    git \
    curl \
    wget \
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
    apt-get update -o Acquire::Retries=5 && apt-get install -y -o Acquire::Retries=5 \
    libuv1-dev:i386 \
    pkg-config \
    libc6-dev:i386 \
    libssl-dev:i386 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# pip installs into /usr/local/bin, which precedes /usr/bin on PATH, so this is the cmake that wins.
# An ENTRYPOINT of our own replaces the base image's; build.sh sources emsdk_env.sh, so nothing is lost.
RUN pip3 install --no-cache-dir 'cmake>=3.28,<4'

WORKDIR /build
COPY build.sh /build.sh
COPY patches /patches
RUN chmod +x /build.sh

# ENTRYPOINT, not CMD: `docker run <image> 2` replaces CMD outright, so with CMD the variant argument
# arrives as the command and the container tries to execute a file called `2`.
ENTRYPOINT ["/build.sh"]
CMD ["2"]
