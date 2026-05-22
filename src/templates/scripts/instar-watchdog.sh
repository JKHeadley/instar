#!/bin/bash
# Instar Fleet Watchdog
# Monitors all registered Instar agents and recovers them when they fail.
# Runs via launchd every 5 minutes.
#
# Recovery capabilities:
#   1. Reloads agents that launchd has unloaded entirely
#   2. Detects agents that are loaded but crash-looping (no PID, non-zero exit)
#   3. Self-heals common crash causes:
#      - Missing shadow install → reinstalls it (PATH-resolved npm, works under launchd)
#      - Missing node symlink → recreates it
#      - Stale lifeline locks → removes them
#   4. Force-reloads services after self-healing
#   5. Escalates to user via healthy peer agent's /attention endpoint when
#      self-heal fails N consecutive cycles for the same agent.
#
# Usage: ./instar-watchdog.sh [--dry-run] [--verbose]
#
# Source of truth: src/templates/scripts/instar-watchdog.sh in the instar repo.
# Installed/migrated by PostUpdateMigrator.migrateFleetWatchdog().

set -euo pipefail

# Paths can be overridden via env vars for testability. Defaults are production.
LAUNCH_AGENTS_DIR="${INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_FILE="${INSTAR_WATCHDOG_LOG_FILE:-$HOME/.instar/watchdog.log}"
HEAL_STATE_DIR="${INSTAR_WATCHDOG_STATE_DIR:-$HOME/.instar/watchdog-state}"
ESCALATE_AFTER_FAILS="${INSTAR_WATCHDOG_ESCALATE_AFTER:-3}"
DRY_RUN=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verbose) VERBOSE=true ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")" "$HEAL_STATE_DIR"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg" >> "$LOG_FILE"
  if $VERBOSE; then echo "$msg"; fi
}

# Resolve an executable node binary. PATH is often empty under launchd, so
# we cannot rely on `which` / `command -v` exclusively. Absolute paths first;
# fall back to PATH lookup so the script works on Linux/CI/non-macOS hosts
# where Homebrew paths don't exist. Caches result via global var to avoid
# re-probing.
RESOLVED_NODE=""
resolve_node() {
  [ -n "$RESOLVED_NODE" ] && { echo "$RESOLVED_NODE"; return 0; }
  # Explicit override always wins (used by tests and unusual deployments).
  if [ -n "${INSTAR_WATCHDOG_NODE_BIN:-}" ] && [ -x "${INSTAR_WATCHDOG_NODE_BIN}" ]; then
    RESOLVED_NODE="${INSTAR_WATCHDOG_NODE_BIN}"; echo "$RESOLVED_NODE"; return 0
  fi
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$cand" ]; then RESOLVED_NODE="$cand"; echo "$cand"; return 0; fi
  done
  # Last resort: ask the shell. May find nvm/asdf/system node.
  local p
  p=$(command -v node 2>/dev/null || true)
  if [ -n "$p" ] && [ -x "$p" ]; then RESOLVED_NODE="$p"; echo "$p"; return 0; fi
  return 1
}

# Resolve the npm-cli.js entry point so we can invoke it as `node npm-cli.js`,
# bypassing npm's `#!/usr/bin/env node` shebang (which fails under empty PATH).
# Same fallback order as resolve_node.
RESOLVED_NPM=""
resolve_npm() {
  [ -n "$RESOLVED_NPM" ] && { echo "$RESOLVED_NPM"; return 0; }
  if [ -n "${INSTAR_WATCHDOG_NPM_CLI:-}" ] && [ -r "${INSTAR_WATCHDOG_NPM_CLI}" ]; then
    RESOLVED_NPM="${INSTAR_WATCHDOG_NPM_CLI}"; echo "$RESOLVED_NPM"; return 0
  fi
  for cand in \
      /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js \
      /usr/local/lib/node_modules/npm/bin/npm-cli.js \
      /usr/lib/node_modules/npm/bin/npm-cli.js \
      /usr/share/npm/bin/npm-cli.js; do
    if [ -r "$cand" ]; then RESOLVED_NPM="$cand"; echo "$cand"; return 0; fi
  done
  # Last resort: derive from `which npm` (npm itself is a shell script that
  # exec's its own npm-cli.js — find that path).
  local p npm_real
  p=$(command -v npm 2>/dev/null || true)
  if [ -n "$p" ]; then
    # npm is usually a symlink to ../lib/node_modules/npm/bin/npm-cli.js
    npm_real=$(readlink -f "$p" 2>/dev/null || readlink "$p" 2>/dev/null || echo "$p")
    case "$npm_real" in
      *.js) [ -r "$npm_real" ] && RESOLVED_NPM="$npm_real" && echo "$npm_real" && return 0 ;;
      *)
        # npm wrapper points to a different script — try its sibling lib path.
        local guess="$(dirname "$p")/../lib/node_modules/npm/bin/npm-cli.js"
        if [ -r "$guess" ]; then
          RESOLVED_NPM=$(cd "$(dirname "$guess")" 2>/dev/null && pwd)/$(basename "$guess")
          echo "$RESOLVED_NPM"
          return 0
        fi
        ;;
    esac
  fi
  return 1
}

# Extract the WorkingDirectory (project dir) from a launchd plist.
# macOS: PlistBuddy is fast and authoritative.
# Linux/CI: falls back to python3 XML parsing, then crude grep.
get_project_dir() {
  local plist="$1"
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$plist" 2>/dev/null || true
    return
  fi
  if command -v python3 &>/dev/null; then
    python3 - "$plist" 2>/dev/null <<'PYEOF' || true
import sys, xml.etree.ElementTree as ET
d = ET.parse(sys.argv[1]).getroot().find('dict')
els = list(d)
for i, el in enumerate(els):
    if el.tag == 'key' and el.text == 'WorkingDirectory' and i + 1 < len(els):
        print(els[i + 1].text)
        break
PYEOF
    return
  fi
  grep -A1 '<key>WorkingDirectory</key>' "$plist" 2>/dev/null \
    | grep '<string>' | sed 's|.*<string>\(.*\)</string>.*|\1|' || true
}

# Try to fix common issues that prevent an agent from starting.
# Returns 0 if a fix was applied, 1 if nothing actionable.
try_self_heal() {
  local project_dir="$1"
  local label="$2"
  local healed=1

  if [ -z "$project_dir" ] || [ ! -d "$project_dir" ]; then
    log "HEAL-SKIP: $label — project dir not found or empty"
    return 1
  fi

  local state_dir="$project_dir/.instar"

  # Heal 1: Missing shadow install
  local shadow_dir="$state_dir/shadow-install"
  local shadow_cli="$shadow_dir/node_modules/instar/dist/cli.js"
  if [ ! -f "$shadow_cli" ]; then
    log "HEAL: $label — shadow install missing, reinstalling"
    if ! $DRY_RUN; then
      local node_bin npm_cli
      node_bin=$(resolve_node || true)
      npm_cli=$(resolve_npm || true)

      if [ -z "$node_bin" ] || [ -z "$npm_cli" ]; then
        log "HEAL-FAIL: $label — no node/npm binary found (node='$node_bin' npm='$npm_cli')"
      else
        mkdir -p "$shadow_dir"
        if [ ! -f "$shadow_dir/package.json" ]; then
          cat > "$shadow_dir/package.json" <<'PKGEOF'
{
  "name": "instar-shadow",
  "private": true,
  "dependencies": { "instar": "latest" }
}
PKGEOF
        fi
        if "$node_bin" "$npm_cli" install --no-audit --no-fund --silent --prefix "$shadow_dir" >> "$LOG_FILE" 2>&1; then
          if [ -f "$shadow_cli" ]; then
            log "HEAL-OK: $label — shadow install restored"
            healed=0
          else
            log "HEAL-FAIL: $label — npm install ran but CLI still missing"
          fi
        else
          log "HEAL-FAIL: $label — npm install exited non-zero"
        fi
      fi
    else
      log "DRY-RUN: Would reinstall shadow for $label"
      healed=0
    fi
  fi

  # Heal 2: Missing or broken node symlink
  local node_symlink="$state_dir/bin/node"
  if [ ! -x "$node_symlink" ] || ! "$node_symlink" --version &>/dev/null; then
    log "HEAL: $label — node symlink missing or broken"
    if ! $DRY_RUN; then
      mkdir -p "$state_dir/bin"
      local node_path
      node_path=$(resolve_node || true)
      if [ -n "$node_path" ]; then
        ln -sf "$node_path" "$node_symlink"
        log "HEAL-OK: $label — node symlink → $node_path"
        healed=0
      else
        log "HEAL-FAIL: $label — no node binary found for symlink"
      fi
    else
      log "DRY-RUN: Would fix node symlink for $label"
      healed=0
    fi
  fi

  # Heal 3: Stale lifeline lock
  local lock_file="$state_dir/lifeline.lock"
  if [ -f "$lock_file" ]; then
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -gt 600 ]; then
      log "HEAL: $label — stale lifeline lock (${lock_age}s old)"
      if ! $DRY_RUN; then
        rm -f "$lock_file"
        log "HEAL-OK: $label — lock removed"
        healed=0
      else
        log "DRY-RUN: Would remove stale lock for $label"
        healed=0
      fi
    fi
  fi

  # Heal 4: Last-error context for diagnostics
  local err_log="$state_dir/logs/lifeline-launchd.err"
  if [ -f "$err_log" ] && [ "$healed" -ne 0 ]; then
    local last_err
    last_err=$(tail -1 "$err_log" 2>/dev/null || true)
    if [ -n "$last_err" ]; then
      log "HEAL-INFO: $label — last error: $last_err"
    fi
  fi

  return $healed
}

# Rate-limit overall heal attempts per agent (in addition to the boot-wrapper's
# own 5-min debounce). Default: one attempt per 30 minutes.
should_attempt_heal() {
  local label="$1"
  local state_file="$HEAL_STATE_DIR/$label.last-heal"
  [ ! -f "$state_file" ] && return 0
  local last_heal
  last_heal=$(cat "$state_file" 2>/dev/null || echo 0)
  local now elapsed
  now=$(date +%s)
  elapsed=$(( now - last_heal ))
  [ "$elapsed" -gt 1800 ] && return 0
  return 1
}

mark_heal_attempt() {
  local label="$1"
  date +%s > "$HEAL_STATE_DIR/$label.last-heal"
}

# Increment consecutive-fail counter; return new value via stdout.
bump_fail_counter() {
  local label="$1"
  local fail_file="$HEAL_STATE_DIR/$label.consecutive-heal-fails"
  local current=0
  [ -r "$fail_file" ] && current=$(cat "$fail_file" 2>/dev/null || echo 0)
  current=$((current + 1))
  echo "$current" > "$fail_file"
  echo "$current"
}

reset_fail_counter() {
  local label="$1"
  rm -f "$HEAL_STATE_DIR/$label.consecutive-heal-fails" 2>/dev/null || true
  rm -f "$HEAL_STATE_DIR/$label.bind-fail-conflict" 2>/dev/null || true
}

# Escalate via a healthy peer agent's /attention endpoint.
# The dead agent has no Telegram bot connection by definition; SOME peer's
# server has to make the actual Telegram call. We discover a peer by scanning
# launchctl labels for ai.instar.* and probing /health on each agent's port.
#
# The payload uses category="degradation" which triggers the isHealthAlert
# branch in routes.ts → MessagingToneGate with B12-B14 ruleset. If the gate
# blocks our message it falls back to SAFE_HEALTH_ALERT_TEMPLATE — either way
# the user gets a clean Telegram alert.
escalate_via_peer() {
  local dead_label="$1"
  local fail_count="$2"
  local minutes_down=$((fail_count * 5))

  # Strip ai.instar. prefix for the user-facing name
  local dead_name="${dead_label#ai.instar.}"

  # If the BIND-FAIL path stashed a conflicting-project hint, use it to build
  # a more specific summary. Falls back to the generic "offline" copy.
  local conflict_file="$HEAL_STATE_DIR/$dead_label.bind-fail-conflict"
  local conflict_name=""
  if [ -r "$conflict_file" ]; then
    conflict_name=$(cat "$conflict_file" 2>/dev/null || true)
  fi
  local summary_text
  if [ -n "$conflict_name" ] && [ "$conflict_name" != "$dead_name" ]; then
    summary_text="${dead_name} hasn't been able to start its server because ${conflict_name} is using its port. My repair attempts haven't fixed it."
  else
    summary_text="${dead_name} has been offline for about ${minutes_down} minutes and my repair attempts aren't working."
  fi

  # Find a healthy peer
  local peer_plist peer_label peer_dir peer_port peer_auth health_code
  for peer_plist in "$LAUNCH_AGENTS_DIR"/ai.instar.*.plist; do
    [ -f "$peer_plist" ] || continue
    case "$peer_plist" in *.DISABLED) continue ;; esac
    peer_label=$(basename "$peer_plist" .plist)
    [ "$peer_label" = "$dead_label" ] && continue
    [ "$peer_label" = "ai.instar.watchdog" ] && continue

    peer_dir=$(get_project_dir "$peer_plist")
    [ -z "$peer_dir" ] && continue
    [ ! -r "$peer_dir/.instar/config.json" ] && continue

    # Read peer port + auth via node. Pass config path as argv (process.argv[1])
    # rather than interpolating into the source string — defends against any
    # weird character ever appearing in HOME or project paths.
    local node_bin
    node_bin=$(resolve_node || true)
    [ -z "$node_bin" ] && continue
    local peer_meta
    peer_meta=$("$node_bin" -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write((c.port||'')+'\t'+(c.authToken||''))" "$peer_dir/.instar/config.json" 2>/dev/null || true)
    peer_port="${peer_meta%%	*}"
    peer_auth="${peer_meta##*	}"
    [ -z "$peer_port" ] && continue

    health_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${peer_port}/health" 2>/dev/null || echo "000")
    if [ "$health_code" = "200" ]; then
      log "ESCALATE: $dead_label — via peer $peer_label (port $peer_port)"
      if ! $DRY_RUN; then
        # First attempt: our specific payload. If the tone gate (B12-B14)
        # blocks it (422), createAttentionItem is NOT called — no Telegram
        # topic, no user alert. We MUST retry with the canonical safe
        # template to guarantee the user is paged.
        local payload safe_payload resp_code
        payload=$(cat <<JSONEOF
{
  "id": "fleet-watchdog-heal-fail-${dead_label}-${fail_count}",
  "title": "${dead_name} is offline",
  "summary": "${summary_text}",
  "description": "Want me to dig in?",
  "category": "degradation",
  "priority": "HIGH"
}
JSONEOF
)
        resp_code=$(curl -s -o /dev/null -w "%{http_code}" \
          -X POST "http://localhost:${peer_port}/attention" \
          -H "Authorization: Bearer $peer_auth" \
          -H "Content-Type: application/json" \
          -H "X-Instar-Request: 1" \
          -d "$payload" 2>/dev/null || echo "000")
        log "ESCALATE-RESULT: $dead_label — peer responded $resp_code"

        if [ "$resp_code" = "201" ]; then
          reset_fail_counter "$dead_label"
          return 0
        fi

        if [ "$resp_code" = "422" ]; then
          # Tone gate blocked our specific copy. Retry with canonical safe
          # template — same wording as the in-process DegradationReporter
          # fallback so it MUST pass the gate (or the gate itself is broken).
          log "ESCALATE-RETRY: $dead_label — retrying with safe template"
          safe_payload=$(cat <<JSONEOF
{
  "id": "fleet-watchdog-heal-fail-${dead_label}-${fail_count}-safe",
  "title": "Something stopped working",
  "summary": "Something on my end stopped working and I haven't been able to fix it on my own.",
  "description": "Want me to dig in?",
  "category": "degradation",
  "priority": "HIGH"
}
JSONEOF
)
          resp_code=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST "http://localhost:${peer_port}/attention" \
            -H "Authorization: Bearer $peer_auth" \
            -H "Content-Type: application/json" \
            -H "X-Instar-Request: 1" \
            -d "$safe_payload" 2>/dev/null || echo "000")
          log "ESCALATE-RETRY-RESULT: $dead_label — peer responded $resp_code"
          if [ "$resp_code" = "201" ]; then
            reset_fail_counter "$dead_label"
            return 0
          fi
        fi

        # Any other response: counter STAYS. We will retry next cycle.
        log "ESCALATE-INCOMPLETE: $dead_label — counter preserved for next cycle"
        return 1
      else
        log "DRY-RUN: Would POST attention to $peer_label for $dead_label"
        return 0
      fi
    fi
  done
  log "ESCALATE-FAIL: $dead_label — no healthy peer found to relay alert"
  return 1
}

# Probe whether an agent's lifeline-managed server actually owns its configured
# port. Used to catch the failure mode where the lifeline (and launchd) report
# healthy but the server itself is locked out — e.g. by a port collision with
# another agent.
#
# Inputs:
#   $1 = project_dir (e.g. /Users/x/Documents/Projects/ai-guy)
#   $2 = label (e.g. ai.instar.ai-guy)
#
# Returns:
#   0 — server reachable and identifies as the expected project (or no port
#       configured, treat as lifeline-only and skip).
#   2 — BIND-FAIL: port held by a different project.
#   3 — BIND-FAIL: port unreachable while lifeline alive.
#
# Side-effects: writes a log line on BIND-FAIL. Stdout (single line):
#   "<kind>\t<conflicting-project-or-empty>"  on BIND-FAIL.
#   Empty otherwise.
probe_server_identity() {
  local project_dir="$1"
  local label="$2"

  [ -z "$project_dir" ] || [ ! -d "$project_dir" ] && return 0
  local config_file="$project_dir/.instar/config.json"
  [ ! -r "$config_file" ] && return 0

  local node_bin port auth_token
  node_bin=$(resolve_node || true)
  [ -z "$node_bin" ] && return 0

  # Read port + authToken in one node invocation. The authToken is required
  # because /health gates the `project` field behind authentication — without
  # it the probe can't verify identity and would silently fail-open.
  local meta
  meta=$("$node_bin" -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(c.port||'')+'\t'+String(c.authToken||''))" "$config_file" 2>/dev/null || true)
  port="${meta%%	*}"
  auth_token="${meta##*	}"
  # Lifeline-only agents have no port; treat as healthy from probe POV.
  [ -z "$port" ] && return 0

  # Probe /health with a short timeout. Short is critical — the watchdog runs
  # every 5 minutes and must not stall on an unresponsive server.
  # Authorization header included so the response carries the `project` field
  # (gated server-side; see routes.ts /health handler).
  local resp http_code body project_field auth_args
  auth_args=()
  if [ -n "$auth_token" ]; then
    auth_args=(-H "Authorization: Bearer $auth_token")
  fi
  resp=$(curl -sS --max-time 5 -w '\n%{http_code}' "${auth_args[@]}" "http://localhost:${port}/health" 2>/dev/null || echo $'\n000')
  http_code=$(echo "$resp" | tail -n1)
  body=$(echo "$resp" | sed '$d')

  if [ "$http_code" != "200" ]; then
    log "BIND-FAIL: $label — port $port unreachable while lifeline alive (http=$http_code)"
    printf 'unreachable\t\n'
    return 3
  fi

  # Extract the project field from the JSON response.
  project_field=$("$node_bin" -e "try{const j=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(String(j.project||''))}catch(_){}" <<<"$body" 2>/dev/null || true)

  # Derive expected name: strip ai.instar. prefix from label.
  local expected="${label#ai.instar.}"

  if [ -z "$project_field" ]; then
    # Server is responding but doesn't expose its project — can't verify.
    # Treat as healthy (don't false-alarm); old instar versions don't return this field.
    return 0
  fi

  if [ "$project_field" != "$expected" ]; then
    log "BIND-FAIL: $label — port $port owned by $project_field (expected $expected)"
    printf 'wrong-project\t%s\n' "$project_field"
    return 2
  fi

  return 0
}

# Run the heal + escalate pipeline for a BIND-FAIL detection. Reuses the
# same machinery as crash-loop detection so we have ONE escalation path.
#
# Inputs:
#   $1 = label
#   $2 = project_dir
#   $3 = plist
#   $4 = probe stdout (kind\tconflicting-project)
handle_bind_fail() {
  local label="$1"
  local project_dir="$2"
  local plist="$3"
  local probe_out="$4"
  local kind conflict
  kind="${probe_out%%	*}"
  conflict="${probe_out#*	}"
  conflict="${conflict%$'\n'}"

  if ! should_attempt_heal "$label"; then
    $VERBOSE && log "BIND-FAIL: $label — heal attempted recently, waiting"
    return 0
  fi

  if try_self_heal "$project_dir" "$label"; then
    log "RECOVERING: $label — self-heal applied for bind-fail, reloading"
    if ! $DRY_RUN; then
      mark_heal_attempt "$label"
      launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
      sleep 1
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist" 2>/dev/null || true
      reset_fail_counter "$label"
      log "RELOADED: $label (after bind-fail self-heal)"
    else
      log "DRY-RUN: Would reload $label after bind-fail self-heal"
    fi
    return 0
  fi

  # Heal can't fix it. Bump counter; escalate at threshold.
  log "BIND-FAIL: $label — no fixable issues found ($kind${conflict:+, conflict=$conflict})"
  mark_heal_attempt "$label"
  local fail_count
  fail_count=$(bump_fail_counter "$label")
  if [ "$fail_count" -ge "$ESCALATE_AFTER_FAILS" ]; then
    # Stash the bind-fail context so escalate_via_peer can pick it up.
    if [ -n "$conflict" ]; then
      echo "$conflict" > "$HEAL_STATE_DIR/$label.bind-fail-conflict"
    fi
    escalate_via_peer "$label" "$fail_count" || true
  else
    $VERBOSE && log "FAIL-COUNT: $label — ${fail_count}/${ESCALATE_AFTER_FAILS}"
  fi
}

# Out-of-process channel for the coordinated lifeline-restart signal.
# When AutoUpdater / server-426 / PostUpdateMigrator writes
# state/lifeline-restart-requested.json, the lifeline's own tick loop is the
# primary consumer. But if that loop is wedged, only an external process can
# break it. This watchdog runs under its own launchd job (separate process),
# so it can force-restart a stuck lifeline that can't read its own signal.
#
# We act ONLY if the signal is >60s old (giving the in-process consumer first
# crack) and not expired. On match: bootout/bootstrap the agent's launchd job
# and delete the signal.
#
# Returns 0 if a restart was performed, 1 otherwise.
check_stale_lifeline_signal() {
  local project_dir="$1"
  local label="$2"
  local plist="$3"

  [ -z "$project_dir" ] || [ ! -d "$project_dir" ] && return 1
  local signal_file="$project_dir/.instar/state/lifeline-restart-requested.json"
  [ ! -r "$signal_file" ] && return 1

  local node_bin
  node_bin=$(resolve_node || true)
  [ -z "$node_bin" ] && return 1

  # Parse: emit "actionable" if expiresAt>now AND requestedAt < now-60s.
  local verdict
  verdict=$("$node_bin" -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const now = Date.now();
      const exp = Date.parse(s.expiresAt);
      const req = Date.parse(s.requestedAt);
      if (!Number.isFinite(exp) || exp <= now) { process.stdout.write("expired"); }
      else if (Number.isFinite(req) && req < now - 60000) { process.stdout.write("actionable"); }
      else { process.stdout.write("too-fresh"); }
    } catch (_) { process.stdout.write("unreadable"); }
  ' "$signal_file" 2>/dev/null || echo "unreadable")

  case "$verdict" in
    actionable)
      log "LIFELINE-SIGNAL: $label — stale coordinated-restart signal (>60s, lifeline did not self-restart), forcing"
      if ! $DRY_RUN; then
        launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
        sleep 1
        launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist" 2>/dev/null || true
        # Delete the signal so the next cycle (and the respawned lifeline)
        # doesn't re-fire on it.
        rm -f "$signal_file" 2>/dev/null || true
        log "RELOADED: $label (forced via stale lifeline-restart signal)"
        return 0
      else
        log "DRY-RUN: Would force-restart $label (stale lifeline-restart signal)"
        return 0
      fi
      ;;
    expired)
      # Clean up expired signal so it doesn't accumulate.
      rm -f "$signal_file" 2>/dev/null || true
      ;;
  esac
  return 1
}

recovered=0
checked=0
for plist in "$LAUNCH_AGENTS_DIR"/ai.instar.*.plist; do
  [ -f "$plist" ] || continue
  case "$plist" in *.DISABLED) continue ;; esac

  label=$(basename "$plist" .plist)
  # Don't watchdog the watchdog
  [ "$label" = "ai.instar.watchdog" ] && continue
  checked=$((checked + 1))

  if launchctl list "$label" &>/dev/null; then
    pid=$(launchctl list "$label" 2>/dev/null | grep '"PID"' | grep -o '[0-9]*' || true)
    exit_status=$(launchctl list "$label" 2>/dev/null | grep '"LastExitStatus"' | grep -o '[0-9]*' || true)

    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      # Lifeline-level healthy. But the lifeline can be alive while either
      # (a) its server is locked out of its port (port collision), or (b) it
      # has a stale coordinated-restart signal pending that its own tick
      # loop failed to act on. Check both before declaring OK.
      project_dir=$(get_project_dir "$plist")

      # First: stale coordinated-restart signal. If the lifeline didn't read
      # its own signal within 60s, force a restart from out-of-process. This
      # is the third channel (alongside the in-process tick reader and the
      # ServerSupervisor) — runs in a separate launchd job so it can break
      # a wedged event loop the others can't.
      if check_stale_lifeline_signal "$project_dir" "$label" "$plist"; then
        recovered=$((recovered + 1))
        continue
      fi

      # Second: bind-probe (port collision / server-locked-out case).
      probe_out=$(probe_server_identity "$project_dir" "$label")
      probe_rc=$?
      if [ "$probe_rc" -eq 0 ]; then
        # Truly healthy — clear heal state
        rm -f "$HEAL_STATE_DIR/$label.last-heal" 2>/dev/null || true
        rm -f "$HEAL_STATE_DIR/$label.bind-fail-conflict" 2>/dev/null || true
        reset_fail_counter "$label"
        $VERBOSE && log "OK: $label (PID $pid)"
      else
        handle_bind_fail "$label" "$project_dir" "$plist" "$probe_out"
      fi
    elif [ -n "$exit_status" ] && [ "$exit_status" != "0" ]; then
      log "CRASH-LOOP: $label (exit $exit_status, no PID)"

      if should_attempt_heal "$label"; then
        project_dir=$(get_project_dir "$plist")
        if try_self_heal "$project_dir" "$label"; then
          log "RECOVERING: $label — self-heal applied, reloading"
          if ! $DRY_RUN; then
            mark_heal_attempt "$label"
            launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
            sleep 1
            launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist" 2>/dev/null || true
            recovered=$((recovered + 1))
            reset_fail_counter "$label"
            log "RELOADED: $label (after self-heal)"
          else
            log "DRY-RUN: Would reload $label after self-heal"
          fi
        else
          log "CRASH-LOOP: $label — no fixable issues found"
          mark_heal_attempt "$label"
          fail_count=$(bump_fail_counter "$label")
          if [ "$fail_count" -ge "$ESCALATE_AFTER_FAILS" ]; then
            escalate_via_peer "$label" "$fail_count" || true
          else
            $VERBOSE && log "FAIL-COUNT: $label — ${fail_count}/${ESCALATE_AFTER_FAILS}"
          fi
        fi
      else
        $VERBOSE && log "CRASH-LOOP: $label — heal attempted recently, waiting"
      fi
    else
      $VERBOSE && log "LOADED-IDLE: $label (no PID, exit=$exit_status)"
    fi
  else
    log "RECOVERING: $label (not loaded, reloading)"
    if ! $DRY_RUN; then
      project_dir=$(get_project_dir "$plist")
      if [ -n "$project_dir" ]; then
        try_self_heal "$project_dir" "$label" || true
      fi
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist" 2>/dev/null || true
      recovered=$((recovered + 1))
      log "RELOADED: $label"
    else
      log "DRY-RUN: Would reload $label"
    fi
  fi
done

if [ "$recovered" -gt 0 ]; then
  log "Watchdog complete: $checked checked, $recovered recovered"
elif $VERBOSE; then
  log "Watchdog complete: $checked checked, all healthy"
fi

# Trim log file
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 1000 ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp"
  mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

# Trim heal state files older than 24 hours
# Trim heal-state files older than 24 hours. Covers all per-label markers:
# *.last-heal, *.consecutive-heal-fails, *.bind-fail-conflict — so state from
# uninstalled agents doesn't accumulate indefinitely.
find "$HEAL_STATE_DIR" \( -name "*.last-heal" -o -name "*.consecutive-heal-fails" -o -name "*.bind-fail-conflict" \) -mmin +1440 -delete 2>/dev/null || true
