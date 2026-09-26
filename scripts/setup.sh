#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
TOOLS_DIR="$(pwd)/.tools"
LOCAL_NODE="$TOOLS_DIR/node/bin/node"
DIST_URL="https://nodejs.org/dist/$NODE_VERSION"

node_is_recent() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)' 2>/dev/null
}

platform_name() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "Unsupported OS $(uname -s); install Node.js >= 20.6 yourself." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) echo "Unsupported CPU $(uname -m); install Node.js >= 20.6 yourself." >&2; exit 1 ;;
  esac
  echo "$os-$arch"
}

download() {
  if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -q "$1" -O "$2"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_local_node() {
  local archive="node-$NODE_VERSION-$(platform_name).tar.gz"
  local work="$TOOLS_DIR/download"
  echo "Node.js >= 20.6 not found; installing $NODE_VERSION into .tools/node"
  rm -rf "$work" && mkdir -p "$work"
  download "$DIST_URL/SHASUMS256.txt" "$work/SHASUMS256.txt"
  download "$DIST_URL/$archive" "$work/$archive"
  local expected actual
  expected="$(grep " $archive\$" "$work/SHASUMS256.txt" | cut -d' ' -f1)"
  actual="$(sha256_of "$work/$archive")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "SHA-256 check failed for $archive; not installing." >&2
    exit 1
  fi
  echo "SHA-256 OK for $archive"
  tar -xzf "$work/$archive" -C "$work"
  rm -rf "$TOOLS_DIR/node"
  mv "$work/${archive%.tar.gz}" "$TOOLS_DIR/node"
  rm -rf "$work"
}

if [ -x "$LOCAL_NODE" ] && node_is_recent "$LOCAL_NODE"; then
  echo "Node.js $("$LOCAL_NODE" --version) OK (.tools/node)"
elif command -v node >/dev/null && node_is_recent node; then
  echo "Node.js $(node --version) OK"
else
  install_local_node
  echo "Node.js $("$LOCAL_NODE" --version) OK (.tools/node)"
fi

if command -v rg >/dev/null; then echo "ripgrep found"; else echo "ripgrep not found; search uses the built-in fallback"; fi
if [ -z "${AI_API_KEY:-}" ] && ! grep -qs '^AI_API_KEY=.' .env; then echo "Note: AI_API_KEY is not set yet; export it before make run."; fi
