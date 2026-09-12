#!/usr/bin/env bash
# Cross-build static musl binaries for OpenWrt with zig.
#
# Produces (in target/<triple>/release/):
#   daed  - the Rust-native dae core + product layer daemon
#   dae   - the Rust-native dae CLI / diagnostics binary
#
# Usage:
#   ARCH=x86_64  ./crossbuild/build-musl.sh     # OpenWrt x86/64
#   ARCH=aarch64 ./crossbuild/build-musl.sh     # OpenWrt arm64 (Cortex-A53 etc.)
#
# Requirements: zig (>= 0.14) in $ZIG_BIN_DIR or $HOME/zig, rustup target
# <triple> installed, nightly + rust-src + bpf-linker for the embedded eBPF
# object, cmake/clang/perl/libelf-dev for BoringSSL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${ARCH:-x86_64}"
JOBS="${JOBS:-2}"

case "$ARCH" in
    x86_64)
        RUST_TARGET=x86_64-unknown-linux-musl
        ZIG_TARGET=x86_64-linux-musl
        CPU_FLAG=x86-64
        ;;
    aarch64)
        RUST_TARGET=aarch64-unknown-linux-musl
        ZIG_TARGET=aarch64-linux-musl
        CPU_FLAG=generic
        ;;
    *)
        echo "build-musl: unsupported ARCH=$ARCH (use x86_64 or aarch64)" >&2
        exit 1
        ;;
esac

TARGET_ENV="$(printf '%s' "$RUST_TARGET" | tr '-' '_')"
TARGET_UPPER="$(printf '%s' "$RUST_TARGET" | tr 'a-z-' 'A-Z_')"
ZIG_BIN="${ZIG_BIN_DIR:-$HOME/zig}"

if [ ! -x "$ZIG_BIN/zig" ]; then
    echo "build-musl: zig not found at $ZIG_BIN/zig (set ZIG_BIN_DIR)" >&2
    exit 1
fi

BINDGEN_ARGS="$(PATH="$ZIG_BIN:$PATH" "$ROOT/crossbuild/zig-bindgen-env" "$ZIG_TARGET")"
echo "build-musl: target=$RUST_TARGET zig=$ZIG_TARGET cpu=$CPU_FLAG jobs=$JOBS"
echo "build-musl: bindgen args=$BINDGEN_ARGS"

exec env \
    PATH="$ZIG_BIN:$PATH" \
    ZIGCC_TARGET="$ZIG_TARGET" \
    "CC_${TARGET_ENV}=$ROOT/crossbuild/zigcc" \
    "CXX_${TARGET_ENV}=$ROOT/crossbuild/zigcxx" \
    "AR_${TARGET_ENV}=llvm-ar" \
    "CARGO_TARGET_${TARGET_UPPER}_LINKER=$ROOT/crossbuild/zigcc" \
    "CARGO_TARGET_${TARGET_UPPER}_RUSTFLAGS=-C link-self-contained=no -C target-cpu=$CPU_FLAG" \
    "BINDGEN_EXTRA_CLANG_ARGS=$BINDGEN_ARGS" \
    cargo build --locked --release -j"$JOBS" \
        --target "$RUST_TARGET" \
        -p dae-daemon --bin daed \
        -p dae-cli --bin dae
