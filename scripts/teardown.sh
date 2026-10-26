#!/usr/bin/env bash
# teardown.sh — stop every process serving this repo's service ports.
#
# Usage:
#   npm run teardown                # host processes only
#   npm run teardown -- --docker    # docker compose down, then host processes
#
# Env overrides:
#   TEARDOWN_PORTS    (default: "3000 8000 8001 8002 8003 8004")
#   TEARDOWN_TIMEOUT  (default: 8) seconds to wait between SIGTERM and SIGKILL
#
# Only processes owned by this checkout are touched: a port held by anything
# else (another app, a container) is reported and the script exits 1 without
# killing it. `predev`/`prestart` run this script, so a stale stack can never
# cause EADDRINUSE.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORTS="${TEARDOWN_PORTS:-3000 8000 8001 8002 8003 8004}"
TIMEOUT="${TEARDOWN_TIMEOUT:-8}"

log() { printf 'teardown: %s\n' "$*"; }
proc_comm() { ps -o comm= -p "$1" 2>/dev/null | tr -d ' ' ; }

if [[ "${1:-}" == "--docker" ]]; then
  if command -v docker >/dev/null 2>&1 && [[ -f "$ROOT/docker-compose.yml" || -f "$ROOT/compose.yml" ]]; then
    (cd "$ROOT" && docker compose down) || log "warn: docker compose down failed (daemon not running?)"
  else
    log "warn: docker/compose not available; skipping --docker"
  fi
fi

# True when the PID demonstrably belongs to this checkout: working directory
# under the repo, or an argv that references it. Unverifiable PIDs are never
# touched (next-server's argv carries no path — cwd is the tell).
ours() {
  local pid="$1" cwd
  [[ -d "/proc/$pid" ]] || return 1
  [[ "$pid" == "$$" ]] && return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$ROOT"|"$ROOT"/*) return 0 ;;
  esac
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$ROOT"
}

# PIDs listening on a port. "UNVERIFIED" = something is bound but not
# identifiable from here (root-owned); callers treat it as foreign.
listener_pids() {
  local port="$1" raw="" out=""
  if command -v ss >/dev/null 2>&1; then
    raw="$(ss -ltnpH "sport = :$port" 2>/dev/null || true)"
    out="$(printf '%s\n' "$raw" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
    if [[ -n "${raw//[$'\n' ]/}" && -z "$out" ]]; then
      printf '%s\n' "UNVERIFIED"
      return
    fi
  fi
  if [[ -z "$out" ]] && command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  fi
  printf '%s\n' "$out" | sort -un
}

declare -A TARGETS=()

# 1) PIDs currently listening on the service ports.
for port in $PORTS; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if ours "$pid"; then
      TARGETS["$pid"]="listener :$port"
    fi
  done < <(listener_pids "$port")
done

# 2) Dev runner processes (concurrently / next / tsx) started from this checkout.
while read -r pid; do
  [[ -n "$pid" ]] || continue
  [[ "$pid" == "$$" ]] && continue
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$ROOT/node_modules/.bin/"; then
    TARGETS["$pid"]="runner"
  fi
done < <(pgrep -f "node_modules/.bin/" 2>/dev/null || true)

# 3) next-server orphans whose listener is not (yet) visible in ss.
while read -r pid; do
  [[ -n "$pid" ]] || continue
  [[ "$pid" == "$$" ]] && continue
  if ours "$pid"; then
    TARGETS["$pid"]="next-server"
  fi
done < <(pgrep -f "^next-server" 2>/dev/null || true)

if [[ ${#TARGETS[@]} -gt 0 ]]; then
  log "stopping ${#TARGETS[@]} process(es):"
  for pid in "${!TARGETS[@]}"; do
    printf '  pid %-7s %s\n' "$pid" "${TARGETS[$pid]}"
    kill -TERM "$pid" 2>/dev/null || true
  done

  deadline=$((SECONDS + TIMEOUT))
  while (( SECONDS < deadline )); do
    alive=0
    for pid in "${!TARGETS[@]}"; do [[ -d "/proc/$pid" ]] && alive=1; done
    (( alive == 0 )) && break
    sleep 0.5
  done

  for pid in "${!TARGETS[@]}"; do
    [[ -d "/proc/$pid" ]] || continue
    ours "$pid" || continue
    log "pid $pid ignored SIGTERM — sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 0.3
else
  log "no repository processes found"
fi

rc=0
for port in $PORTS; do
  found=0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    found=1
    rc=1
    if [[ "$pid" == "UNVERIFIED" ]]; then
      log "ERROR: :$port is bound by a process that cannot be identified — not killed"
    elif ours "$pid"; then
      log "ERROR: :$port still bound after cleanup (pid $pid)"
    else
      log "ERROR: :$port held by foreign pid $pid ($(proc_comm "$pid")) — not killed"
      log "        another app or container owns it; stop it (e.g. 'docker compose down') and retry"
    fi
  done < <(listener_pids "$port")
  (( found == 0 )) && log ":$port free"
done

exit "$rc"
