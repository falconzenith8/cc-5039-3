#!/usr/bin/env bash
# Provision the arm64 headless Chromium and its shared libraries without root.
# Idempotent: skips work that already exists. Requires network + apt (download only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLAYWRIGHT_VERSION="1.49.1"
HEADLESS_DIR="chromium_headless_shell-1148"

# 1. playwright-core provides the launcher and browser downloader.
if [ ! -d "$ROOT/vendor/node_modules/playwright-core" ]; then
  npm install --prefix "$ROOT/vendor" "playwright-core@${PLAYWRIGHT_VERSION}"
fi

SHELL_BIN="$HOME/.cache/ms-playwright/$HEADLESS_DIR/chrome-linux/headless_shell"
if [ ! -x "$SHELL_BIN" ]; then
  node "$ROOT/vendor/node_modules/playwright-core/cli.js" install chromium-headless-shell || true
fi
[ -x "$SHELL_BIN" ] || { echo "headless_shell missing at $SHELL_BIN" >&2; exit 1; }

# 2. Download runtime .deb packages into a rootless prefix and extract them.
LIB_ROOT="$ROOT/vendor/chromelibs/root"
if ldd "$SHELL_BIN" 2>/dev/null | grep -q "not found"; then
  APTROOT="$(mktemp -d)"
  trap 'rm -rf "$APTROOT"' EXIT
  mkdir -p "$APTROOT/lists/partial" "$APTROOT/archives/partial"
  cat > "$APTROOT/sources.list" <<'EOF'
deb [trusted=yes] http://deb.debian.org/debian bookworm main
deb [trusted=yes] http://deb.debian.org/debian-security bookworm-security main
EOF
  cat > "$APTROOT/apt.conf" <<EOF
Dir::State::Lists "$APTROOT/lists";
Dir::Cache "$APTROOT/cache";
Dir::Cache::Archives "$APTROOT/archives";
Dir::Etc::sourcelist "$APTROOT/sources.list";
Dir::Etc::sourceparts "/dev/null";
Dir::Etc::main "/dev/null";
APT::Get::List-Cleanup "0";
EOF
  export APT_CONFIG="$APTROOT/apt.conf"
  apt-get update
  PKGS="libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libdrm2 libxkbcommon0 \
libasound2 libcups2 libpango-1.0-0 libcairo2 libxi6 libwayland-server0"
  ( cd "$APTROOT" && apt-get download $PKGS )
  mkdir -p "$LIB_ROOT"
  for d in "$APTROOT"/*.deb; do dpkg-deb -x "$d" "$LIB_ROOT"; done
fi

# 3. Verify every shared library now resolves.
LIBP="$LIB_ROOT/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo aarch64-linux-gnu):$LIB_ROOT/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo aarch64-linux-gnu)"
if LD_LIBRARY_PATH="$LIBP" ldd "$SHELL_BIN" 2>/dev/null | grep -q "not found"; then
  echo "unresolved libraries remain:" >&2
  LD_LIBRARY_PATH="$LIBP" ldd "$SHELL_BIN" | grep "not found" >&2
  exit 1
fi
echo "browser ready: $SHELL_BIN"
