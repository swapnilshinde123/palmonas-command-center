#!/usr/bin/env bash
# One-command local launcher (macOS Apple Silicon/Intel, Linux).
# Needs no Homebrew and no admin password: if Docker isn't running, it downloads Node 22 and a
# self-contained Postgres 16 into ./.local and runs everything from there.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

# System tools first: /usr/local/bin can hold Intel-only binaries that fail on Apple Silicon
# without Rosetta ("Bad CPU type in executable").
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

NODE_VERSION=22.23.4
PG_PKG_VERSION=16.15.0-beta.19
PG_PORT=54329
APP_PORT=3000
LOCAL="$ROOT/.local"

say() { printf '\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
runs() { "$@" >/dev/null 2>&1; }
open_url() { if [ "$(uname -s)" = "Darwin" ]; then open "$1" || true; else echo "Open $1 in your browser."; fi; }
wait_for_app() {
  for _ in $(seq 1 120); do curl -sf -o /dev/null "http://localhost:$APP_PORT/login" && return 0; sleep 2; done
  die "The app didn't start. Check the messages above."
}

if [ ! -f .env ]; then
  SECRET=$(head -c 32 /dev/urandom | base64)
  cat > .env <<ENV
DATABASE_URL=postgresql://palmonas:palmonas-local@localhost:5432/palmonas
DIRECT_URL=postgresql://palmonas:palmonas-local@localhost:5432/palmonas
POSTGRES_PASSWORD=palmonas-local
NEXTAUTH_URL=http://localhost:$APP_PORT
NEXTAUTH_SECRET=$SECRET
APP_BASE_URL=http://localhost:$APP_PORT
SEED_SAMPLE=true
SMTP_HOST=
ENV
  say "Created .env with a fresh secret."
fi
set -a; source .env; set +a

# Port 3000 may be taken by another app. Reuse it only if it's this app; otherwise pick a free port.
is_ours() { curl -s --max-time 3 "http://localhost:$1/login" 2>/dev/null | grep -q "Palmonas Command Center"; }
port_busy() { curl -s -o /dev/null --max-time 2 "http://localhost:$1/" 2>/dev/null || (command -v lsof >/dev/null && lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1); }
if is_ours "$APP_PORT"; then
  say "The app is already running on port $APP_PORT; opening it."
  open_url "http://localhost:$APP_PORT"; exit 0
fi
if port_busy "$APP_PORT"; then
  for p in 3100 3200 3300 3400 3500 4000 4100; do
    if is_ours "$p"; then say "The app is already running on port $p; opening it."; open_url "http://localhost:$p"; exit 0; fi
    if ! port_busy "$p"; then say "Port $APP_PORT is used by another program; using port $p instead."; APP_PORT=$p; break; fi
  done
  port_busy "$APP_PORT" && die "No free port found. Close other local servers and retry."
fi
# Sign-in links must match the port actually used.
export NEXTAUTH_URL="http://localhost:$APP_PORT" APP_BASE_URL="http://localhost:$APP_PORT"

# ---------- Option 1: Docker Desktop ----------
# Opt-in only (USE_DOCKER=1): the portable setup below is the tested default.
if [ "${USE_DOCKER:-0}" = "1" ] && runs docker info; then
  say "Docker is running: starting Postgres and the app in containers…"
  docker compose up --build -d
  wait_for_app
  open_url "http://localhost:$APP_PORT"
  echo "✔ http://localhost:$APP_PORT. Sign in: owner@example.com / ChangeMe123 (demo team password: Password123). Stop with: docker compose down"
  exit 0
fi

# ---------- Option 2: portable Node + Postgres in ./.local ----------
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) die "Unsupported OS: $(uname -s)" ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) die "Unsupported CPU: $(uname -m)" ;; esac
mkdir -p "$LOCAL"

NODE_DIR="$LOCAL/node-v$NODE_VERSION-$OS-$ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "Downloading Node $NODE_VERSION ($OS-$ARCH)…"
  T="node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  curl -fL --progress-bar -o "$LOCAL/$T" "https://nodejs.org/dist/v$NODE_VERSION/$T"
  curl -fsSL -o "$LOCAL/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$LOCAL" && grep " $T\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || die "Node download failed its checksum. Delete .local and retry."
  tar -xzf "$LOCAL/$T" -C "$LOCAL" && rm -f "$LOCAL/$T"
fi
export PATH="$NODE_DIR/bin:$PATH"
runs node -v || die "The downloaded Node won't run on this machine."

PG_DIR="$LOCAL/pg-$PG_PKG_VERSION-$OS-$ARCH"
if [ ! -x "$PG_DIR/native/bin/postgres" ]; then
  say "Downloading Postgres 16 ($OS-$ARCH)…"
  rm -rf "$PG_DIR" && mkdir -p "$PG_DIR"
  TGZ=$(cd "$LOCAL" && npm pack --silent "@embedded-postgres/$OS-$ARCH@$PG_PKG_VERSION")
  tar -xzf "$LOCAL/$TGZ" -C "$PG_DIR" --strip-components=1 && rm -f "$LOCAL/$TGZ"
  (cd "$PG_DIR" && node scripts/hydrate-symlinks.js >/dev/null)
fi
PG_BIN="$PG_DIR/native/bin"
runs "$PG_BIN/postgres" --version || die "The downloaded Postgres won't run on this machine."

PG_DATA="$LOCAL/pgdata"
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
  say "Creating the local database…"
  "$PG_BIN/initdb" -D "$PG_DATA" -U palmonas --auth=trust -E UTF8 --no-locale >/dev/null
fi
if ! "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$LOCAL/postgres.log" -o "-p $PG_PORT -k $LOCAL -c listen_addresses=localhost" -w start >/dev/null \
    || die "Postgres didn't start. See $LOCAL/postgres.log"
fi
# Local-only database on its own port, so it never clashes with another Postgres on this machine.
export DATABASE_URL="postgresql://palmonas@localhost:$PG_PORT/postgres"
export DIRECT_URL="$DATABASE_URL"

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

say "Installing dependencies (first run takes a few minutes)…"
# Reinstall whenever package-lock.json changes, so versions always match what was tested.
LOCK_SUM=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
if [ ! -x node_modules/.bin/next ] || [ "$(cat "$LOCAL/deps.sha" 2>/dev/null)" != "$LOCK_SUM" ]; then
  npm ci --include=dev --no-audit --no-fund
  echo "$LOCK_SUM" > "$LOCAL/deps.sha"
  rm -rf .next
fi
# Local binaries only: never let npx fetch a different (newer) version.
BIN="$ROOT/node_modules/.bin"
"$BIN/prisma" migrate deploy
"$BIN/tsx" prisma/seed.ts
[ -f .next/BUILD_ID ] || npm run build
say "Starting the app…"
"$BIN/next" start -p "$APP_PORT" &
APP_PID=$!
wait_for_app
open_url "http://localhost:$APP_PORT"
echo
echo "✔ Running at http://localhost:$APP_PORT"
echo "  Sign in: owner@example.com / ChangeMe123"
echo "  Demo team (password Password123): harsh@ (Admin, L2), dilip@ (Leadership, L3), ritesh@ (L1), pragati@ … @example.com"
echo "  Press Ctrl+C to stop (the database stops too; your data is kept in .local)."
wait "$APP_PID"
