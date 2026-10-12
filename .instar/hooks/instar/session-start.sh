#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="${CLAUDE_HOOK_MATCHER:-startup}"

# Machine-load assessment awareness (CMT-1703) — placed ABOVE the compact delegate
# so it is emitted on EVERY event INCLUDING compact (this stdout flushes before the
# 'exec' below replaces the process). This is what makes it survive compaction.
echo "--- MACHINE LOAD ---"
echo "To assess machine load, run .instar/scripts/load-assess.sh (--json to parse)."
echo "NEVER judge load from 'uptime' 1-min load average — spike-prone AND on macOS inflated by"
echo "Spotlight/mds disk I/O, so a high load average can coexist with a mostly-idle CPU."
echo ""

# On compaction, delegate to the dedicated recovery hook
if [ "$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/instar/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/instar/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# Auto-restart-on-MCP-inaccessible (DARK by default — config.mcpAutoRefresh.enabled).
# Backgrounded so it NEVER blocks boot: if an allowlisted MCP (default playwright)
# failed to register this boot, it self-/sessions/refresh ONCE (hard loop-guarded)
# so a missing MCP is auto-recovered instead of being a manual blocker.
if [ "$EVENT" != "compact" ] && [ -x "$INSTAR_DIR/hooks/instar/mcp-health-autorefresh.sh" ]; then
  bash "$INSTAR_DIR/hooks/instar/mcp-health-autorefresh.sh" >/dev/null 2>&1 &
fi

# Current wall-clock time — addresses Claude Code's "harness injects date, not
# time of day" blind spot. Without this, agents say things like "it's 2am" when
# it's actually 5:45am because they carry stale clock context from session
# history. Always fired, always fresh.
NOW=$(date +'%Y-%m-%d %H:%M:%S %z (%Z)' 2>/dev/null)
if [ -n "$NOW" ]; then
  echo ""
  echo "--- CURRENT TIME ---"
  echo "$NOW"
  echo "Wall-clock at hook fire. Quote this — do not carry stale clock times from prior context."
  echo "--- END CURRENT TIME ---"
fi

# TOPIC CONTEXT (loaded FIRST — highest priority context)
if [ -n "$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "$CONFIG_FILE" ]; then
    PORT=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
    if [ -n "$PORT" ]; then
      TOPIC_CTX=$(curl -s "http://localhost:${PORT}/topic/context/${TOPIC_ID}?recent=30" 2>/dev/null)
      if [ -n "$TOPIC_CTX" ] && echo "$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=$(echo "$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=$(echo "$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")
        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: ${TOPIC_NAME}, ${TOTAL} total messages) ---"
        echo ""
        SUMMARY=$(echo "$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "$SUMMARY"
          echo ""
        fi
        echo "RECENT MESSAGES:"
        echo "$TOPIC_CTX" | python3 -c "
import sys, json
def _localts(raw):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(raw).replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M %Z')
    except Exception:
        return str(raw)[:16].replace('T', ' ')
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = _localts(m.get('timestamp', ''))
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:${PORT}/topic/search?topic=${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# INTEGRATED-BEING LEDGER — cross-session observations (see docs/specs/integrated-being-ledger-v1.md)
# Fetches /shared-state/render and injects it if non-empty. Silent on absence /
# auth failure — endpoint returns 503 when disabled, empty body when enabled
# but has no entries. Either way we only echo when content is present.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  # Env first (set by SessionManager per-session) — survives secret-externalization.
  # Fallback grep: matches only a plaintext-string authToken. After externalization,
  # the value is the literal { "secret": true } placeholder which has no "..." form,
  # so the grep yields empty — we never send a bogus Bearer token.
  TOKEN="${INSTAR_AUTH_TOKEN:-$(grep -o '"authToken":"[^"]*"' "$INSTAR_DIR/config.json" | head -1 | sed 's/"authToken":"//;s/"$//')}"
  if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
    SHARED_STATE=$(curl -sf -H "Authorization: Bearer $TOKEN" "http://localhost:${PORT}/shared-state/render?limit=50" 2>/dev/null)
    if [ -n "$SHARED_STATE" ]; then
      echo ""
      echo "--- INTEGRATED-BEING (cross-session observations) ---"
      echo "$SHARED_STATE"
      echo "--- END INTEGRATED-BEING ---"
      echo ""
    fi
  fi
fi

# ORG-INTENT injection — Phase 2 of the ORG-INTENT runtime project.
# Fetches the parsed three-rule contract (constraints / goals / values /
# tradeoff hierarchy) from /intent/org/session-context and injects it at
# session-start so the agent reasons with the organizational intent from
# message one. The Coherence Gate (Phase 1) still enforces the same contract
# at outbound-message review time — this just brings the same intent into the
# agent's working context up front. Fail-open: route unreachable / absent
# ORG-INTENT.md / 503 → silent skip, session continues normally.
if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  ORG_INTENT_RESPONSE=$(curl -sf --max-time 4 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/intent/org/session-context" 2>/dev/null)
  if [ -n "$ORG_INTENT_RESPONSE" ]; then
    ORG_INTENT_BLOCK=$(echo "$ORG_INTENT_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$ORG_INTENT_BLOCK" ]; then
      echo ""
      echo "$ORG_INTENT_BLOCK"
      echo ""
    fi
  fi
fi

MEM_PORT="$PORT"; MEM_TOKEN="$TOKEN"; MEM_EVENT="$EVENT"
# JEV MEMORY PICKER — docs/specs/jev-memory-picker.md. MEMORY.md loads by
# position (the first ~25,000 characters); Jev ranks the entries past that cut
# against this session's topic. Shadow mode (the default) only logs on the
# server and prints nothing; inject mode prints the ranked entries. The index is
# keyed on the git root (Claude Code keys worktree sessions there too).
# Fail-open: route 503 (disabled) / unreachable / timeout -> silent skip.
if [ -n "$MEM_PORT" ] && [ -n "$MEM_TOKEN" ]; then
  MEM_PROJ="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  MEM_COMMON=$(git -C "$MEM_PROJ" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$MEM_COMMON" ] && [ "$(basename "$MEM_COMMON")" = ".git" ]; then
    MEM_PROJ=$(dirname "$MEM_COMMON")
  fi
  MEM_BODY=$(MEM_PROJ="$MEM_PROJ" MEM_CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" MEM_EVENT="$MEM_EVENT" python3 -c "
import json, os
print(json.dumps({'configDir': os.environ['MEM_CFG'], 'projectDir': os.environ['MEM_PROJ'], 'topicId': os.environ.get('INSTAR_TELEGRAM_TOPIC') or None, 'source': os.environ['MEM_EVENT']}))
" 2>/dev/null)
  if [ -n "$MEM_BODY" ]; then
    MEM_RESPONSE=$(curl -sf --max-time 4 -X POST -H "Authorization: Bearer $MEM_TOKEN" -H 'Content-Type: application/json' \
      -d "$MEM_BODY" "http://localhost:${MEM_PORT}/memory-picker/session-context" 2>/dev/null)
    if [ -n "$MEM_RESPONSE" ]; then
      MEM_BLOCK=$(echo "$MEM_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
      if [ -n "$MEM_BLOCK" ]; then
        echo ""
        echo "$MEM_BLOCK"
        echo ""
      fi
    fi
  fi
fi

# AUTO-LEARNED PREFERENCES injection — Correction & Preference Learning Sentinel
# (Slice 1a). Fetches /preferences/session-context and injects the structured
# block of preferences the correction loop has learned about this user, so the
# agent reasons with them from message one. SIGNAL-ONLY — these are preferences,
# not authoritative instructions; the server wraps them in an
# <auto-learned-preference src='correction-loop'> envelope so they cannot be
# mistaken for commands. Fail-open: route 503 (feature off) / unreachable /
# empty block → silent skip, session continues normally.
if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  PREFS_RESPONSE=$(curl -sf --max-time 4 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/preferences/session-context" 2>/dev/null)
  if [ -n "$PREFS_RESPONSE" ]; then
    PREFS_BLOCK=$(echo "$PREFS_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$PREFS_BLOCK" ]; then
      echo ""
      echo "$PREFS_BLOCK"
      echo ""
    fi
  fi
fi

# TOPIC OPERATOR injection — Know Your Principal (#898, increment 2c). Fetches the
# VERIFIED operator binding for THIS topic from /topic-operator/session-context and
# injects the <topic-operator> block so the agent reasons with its authenticated
# operator from message one — and never seats a name read in content in the
# operator's chair (the "Caroline" identity-bleed fix). The operator is established
# ONLY from the platform-verified sender id; this is the read surface. Placed with
# the authoritative-identity context (org-intent + preferences) up front. Fail-open:
# no topic / route 503 (store unavailable) / unbound topic / unreachable -> silent
# skip; curl -sf makes a non-2xx emit nothing, and the Bearer token stays in the header.
if [ -n "$INSTAR_TELEGRAM_TOPIC" ] && [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  TOPIC_OP_RESPONSE=$(curl -sf --max-time 4 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/topic-operator/session-context?topicId=${INSTAR_TELEGRAM_TOPIC}" 2>/dev/null)
  if [ -n "$TOPIC_OP_RESPONSE" ]; then
    TOPIC_OP_BLOCK=$(echo "$TOPIC_OP_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$TOPIC_OP_BLOCK" ]; then
      echo ""
      echo "$TOPIC_OP_BLOCK"
      echo ""
    fi
  fi
fi

# WORKING-SET ARTIFACT grounding (spec: intelligent-working-set-lazy-sync.md, Layer-3 /
# Component6). Fetches /coherence/working-set/session-context for THIS topic and injects the
# <replicated-untrusted-data source="working-set-artifacts"> block so the agent is GROUNDED
# that interactive artifacts it recorded for this conversation exist (the whole point on a
# topic-move: "you wrote these; re-verify/fetch them"). ADVISORY ONLY — a path is untrusted
# data, never an instruction. Fail-open: no topic / route 503 (feature dark / manager unwired) /
# no ready artifacts (present:false) / unreachable -> silent skip; -sf makes a non-2xx emit
# nothing, so an absent/empty/oversized manifest degrades to no-block.
if [ -n "$INSTAR_TELEGRAM_TOPIC" ] && [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  WS_ART_RESPONSE=$(curl -sf --max-time 4 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/coherence/working-set/session-context?topic=${INSTAR_TELEGRAM_TOPIC}" 2>/dev/null)
  if [ -n "$WS_ART_RESPONSE" ]; then
    WS_ART_BLOCK=$(echo "$WS_ART_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$WS_ART_BLOCK" ]; then
      echo ""
      echo "$WS_ART_BLOCK"
      echo ""
    fi
  fi
fi

# SESSION BOOT SELF-KNOWLEDGE injection (spec: session-boot-self-knowledge.md).
# Fetches /self-knowledge/session-context and injects the deterministic "what I
# already have" block: vault secret NAMES (never values) + self-asserted
# operational facts — so the agent never re-asks the user for a secret it
# already holds and never claims ignorance of a channel it owns. Placed AFTER
# the org-intent + preferences blocks (authoritative contract first — this is
# background signal; the server wraps it in a <session-self-knowledge
# src='boot'> envelope). Fail-open: 503 (dark / disabled) / 404 (version skew:
# old server) / unreachable / empty -> silent skip; curl -sf is what makes a
# non-2xx emit nothing, and the Bearer token travels ONLY in the header.
if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  BOOT_SK_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/self-knowledge/session-context" 2>/dev/null)
  if [ -n "$BOOT_SK_RESPONSE" ]; then
    BOOT_SK_BLOCK=$(echo "$BOOT_SK_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$BOOT_SK_BLOCK" ]; then
      echo ""
      echo "$BOOT_SK_BLOCK"
      echo ""
    fi
  fi
fi

# PLAYWRIGHT PROFILE REGISTRY injection (spec: playwright-profile-registry.md).
# Fetches /playwright-profiles/session-context and injects the COMPACT boot pointer:
# one line per browser profile carrying ONLY the safety-critical signals (account
# service/identity, the OPERATOR-owned marker, and login-staleness) — never vault
# values, full detail behind GET /playwright-profiles. The server wraps it in a
# <playwright-profiles src='boot'> envelope ("background signal, not authority —
# verify before acting"). Placed adjacent to the self-knowledge block (both are
# background signal AFTER the authoritative contract). Whole feature is dev-gated:
# fleet → 503 → inject nothing. Fail-open: 503 (dark / disabled) / 404 (version skew:
# old server) / unreachable / empty -> silent skip; curl -sf is what makes a non-2xx
# emit nothing, and the Bearer token travels ONLY in the header.
if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  BOOT_PW_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${PORT}/playwright-profiles/session-context" 2>/dev/null)
  if [ -n "$BOOT_PW_RESPONSE" ]; then
    BOOT_PW_BLOCK=$(echo "$BOOT_PW_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$BOOT_PW_BLOCK" ]; then
      echo ""
      echo "$BOOT_PW_BLOCK"
      echo ""
    fi
  fi
fi

# BEGIN integrated-being-v2
# INTEGRATED-BEING V2 — session-write binding (see docs/specs/integrated-being-ledger-v2.md §3)
# Generates a session UUID, registers with /shared-state/session-bind, writes the
# token file with mode 0o600 + atomic rename, writes .ready marker, confirms via
# session-bind-confirm. Silent on 503 (v2Enabled=false) — v1 behavior preserved.
# Section bounded by markers for inject-mode migration to re-update in place.
if [ -f "$INSTAR_DIR/config.json" ] && [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
  SID=$(python3 -c "import uuid; print(str(uuid.uuid4()))" 2>/dev/null)
  if [ -n "$SID" ]; then
    BIND_RESP=$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "{\"sessionId\":\"$SID\"}" \
      "http://localhost:${PORT}/shared-state/session-bind" 2>/dev/null)
    if [ -n "$BIND_RESP" ] && echo "$BIND_RESP" | grep -q '"token"'; then
      LEDGER_TOKEN=$(echo "$BIND_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
      if [ -n "$LEDGER_TOKEN" ]; then
        BIND_DIR="$INSTAR_DIR/session-binding"
        # Create dir under umask 077 to avoid a mode-race window where
        # a concurrent process could stat/listdir before chmod lands.
        ( umask 077; mkdir -p "$BIND_DIR" )
        chmod 0700 "$BIND_DIR" 2>/dev/null
        TOK_FILE="$BIND_DIR/${SID}.token"
        TMP_FILE="${TOK_FILE}.tmp.$$"
        # Atomic write: umask-safe 0o600 mode, explicit chmod, fsync, rename.
        ( umask 077; printf '%s' "$LEDGER_TOKEN" > "$TMP_FILE" )
        chmod 0600 "$TMP_FILE" 2>/dev/null
        python3 -c "import os,sys; fd=os.open('$TMP_FILE', os.O_RDONLY); os.fsync(fd); os.close(fd)" 2>/dev/null
        mv "$TMP_FILE" "$TOK_FILE"
        chmod 0600 "$TOK_FILE" 2>/dev/null
        # Mode verification — fail-CLOSED on anything other than 0600.
        MODE=$(python3 -c "import os,stat; print(oct(stat.S_IMODE(os.stat('$TOK_FILE').st_mode))[-4:])" 2>/dev/null)
        if [ "$MODE" = "0600" ]; then
          touch "$BIND_DIR/${SID}.ready"
          chmod 0600 "$BIND_DIR/${SID}.ready" 2>/dev/null
          curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            -d "{\"sessionId\":\"$SID\"}" \
            "http://localhost:${PORT}/shared-state/session-bind-confirm" -o /dev/null 2>/dev/null || true
          export INSTAR_LEDGER_SESSION_ID="$SID"
          export INSTAR_LEDGER_TOKEN_PATH="$TOK_FILE"
        else
          # Mode mismatch → deny for this session's lifetime, clean up evidence.
          echo "[integrated-being-v2] token file mode $MODE != 0600; denying session-write for this session" >&2
          rm -f "$TOK_FILE"
        fi
      fi
    fi
  fi
fi
# END integrated-being-v2

# Identity summary (first 20 lines of AGENT.md — enough for name + role)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  AGENT_NAME=$(head -1 "$INSTAR_DIR/AGENT.md" | sed 's/^# //')
  echo "Identity: $AGENT_NAME"
  # Output personality and principles sections
  sed -n '/^## Personality/,/^## [^P]/p' "$INSTAR_DIR/AGENT.md" 2>/dev/null | head -10
fi

# PROJECT MAP — spatial awareness of the working environment
if [ -f "$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('$INSTAR_DIR/project-map.json'))
    print(f'Project: {m["projectName"]} ({m["projectType"]})')
    print(f'Path: {m["projectDir"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(", ").join(t)}')
    d = m.get('directories', [])
    print(f'Files: {m["totalFiles"]} across {len(d)} directories')
    for dd in d[:6]:
        print(f'  {dd["name"]}/ ({dd["fileCount"]}) — {dd["description"]}')
    if len(d) > 6: print(f'  ... and {len(d) - 6} more')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# COHERENCE SCOPE — before ANY high-risk action, verify alignment
if [ -f "$INSTAR_DIR/config.json" ]; then
  echo ""
  echo "--- COHERENCE SCOPE ---"
  echo "BEFORE deploying, pushing, or modifying files outside this project:"
  echo "  1. Verify you are in the RIGHT project for the current topic/task"
  echo "  2. Check: curl -X POST http://localhost:${PORT:-4040}/coherence/check \\"
  echo "       -H 'Content-Type: application/json' \\"
  echo "       -d '{"action":"deploy","context":{"topicId":N}}'"
  echo "  3. If the check says BLOCK — STOP. You may be in the wrong project."
  echo "  4. Read the full reflection: POST /coherence/reflect"
  echo "--- END COHERENCE SCOPE ---"
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"
[ -f "$INSTAR_DIR/project-map.md" ] && echo "  .instar/project-map.md — Project structure map"

# Relationship count
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "$REL_COUNT" -gt "0" ] && echo "  ${REL_COUNT} tracked relationships in .instar/relationships/"
fi

# Server status + self-discovery + feature awareness
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
  if [ "$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port ${PORT}"
    # Reset scope coherence state — prevents accumulated counts from prior sessions
    # leaking into this session and causing false-positive hook triggers.
    # Endpoint: POST /scope-coherence/reset (routes.ts)
    curl -s -X POST "http://localhost:${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true
    # Load full capabilities for tunnel + feature guide
    CAPS=$(curl -s "http://localhost:${PORT}/capabilities" 2>/dev/null)
    TUNNEL_URL=$(echo "$CAPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tunnel',{}).get('url',''))" 2>/dev/null)
    [ -n "$TUNNEL_URL" ] && echo "Cloudflare Tunnel active: $TUNNEL_URL"
    # Inject feature guide — proactive capability awareness at every session start
    if echo "$CAPS" | grep -q '"featureGuide"'; then
      echo ""
      echo "--- YOUR CAPABILITIES (use these proactively when context matches) ---"
      echo "$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    triggers = guide.get('triggers', [])
    if triggers:
        for t in triggers:
            print(f'  When: {t["context"]}')
            print(f'  Do:   {t["action"]}')
            print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, look at Y" routing
    # Structure > Willpower: instead of burying this in a 600-line CLAUDE.md,
    # inject it at session start so the agent sees it before doing anything.
    DISPATCH_FILE="$INSTAR_DIR/context/DISPATCH.md"
    if [ -f "$DISPATCH_FILE" ]; then
      echo ""
      echo "--- CONTEXT DISPATCH (when X arises, read Y) ---"
      cat "$DISPATCH_FILE"
      echo "--- END CONTEXT DISPATCH ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port ${PORT})"
  fi
fi

echo ""
echo "IMPORTANT: To report bugs or request features, use POST /feedback on your local server."

# Working Memory — surface relevant knowledge from SemanticMemory + EpisodicMemory
# Right context at the right moment: query-driven, not a full dump.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)
  if [ -n "$PORT" ]; then
    # Resolve auth token: env first (set by SessionManager for every spawned
    # session), legacy plaintext-config fallback with string-type guard so the
    # { "secret": true } placeholder produced by SecretMigrator never leaks
    # through as a bogus Bearer token.
    AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
    if [ -z "$AUTH_TOKEN" ]; then
      AUTH_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
    fi
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
    if [ "$HEALTH" = "200" ]; then
      # Build query from available context signals
      QUERY_PARTS=""
      [ -n "$INSTAR_TELEGRAM_TOPIC" ] && QUERY_PARTS="topic:${INSTAR_TELEGRAM_TOPIC} "
      WM_PROMPT=$(echo "${QUERY_PARTS}${CLAUDE_SESSION_GOAL:-session-start}" | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()[:300].strip()))" 2>/dev/null)
      WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}"         "http://localhost:${PORT}/context/working-memory?prompt=${WM_PROMPT}&limit=8" 2>/dev/null)
      if [ -n "$WORKING_MEM" ]; then
        WM_CONTEXT=$(echo "$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s["count"]} {s["name"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "$WM_CONTEXT" ]; then
          echo ""
          echo "--- WORKING MEMORY (relevant knowledge for this session) ---"
          echo "$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
        fi
      fi
    fi
  fi
fi

# Telegram relay instructions (structural — ensures EVERY Telegram session knows how to respond)
if [ -n "$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  [ -f "$INSTAR_DIR/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  [ -z "$RELAY_SCRIPT" ] && [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  echo ""
  echo "--- TELEGRAM SESSION (topic ${TOPIC_ID}) ---"
  echo "MANDATORY: After EVERY response, relay conversational text back to Telegram:"
  echo "  cat <<'EOF' | ${RELAY_SCRIPT:-'.instar/scripts/telegram-reply.sh'} ${TOPIC_ID}"
  echo "  Your response text here"
  echo "  EOF"
  echo "Strip the [telegram:${TOPIC_ID}] prefix before interpreting messages."
  echo "If a thread history file is referenced, READ IT FIRST before responding."
  echo "--- END TELEGRAM SESSION ---"
fi

# Pending upgrade guide — inject knowledge from the latest update
GUIDE_FILE="$INSTAR_DIR/state/pending-upgrade-guide.md"
if [ -f "$GUIDE_FILE" ]; then
  echo ""
  echo "=== UPGRADE GUIDE (ACTION REQUIRED) ==="
  echo ""
  echo "A new version of Instar was installed with upgrade instructions."
  echo "You MUST do the following:"
  echo ""
  echo "1. Read the full upgrade guide below"
  echo "2. Take any suggested actions that apply to YOUR situation"
  echo "3. MESSAGE YOUR USER about what's new:"
  echo "   - Compose a brief, personalized message highlighting the features"
  echo "     that matter most to THEM and their specific use case"
  echo "   - Explain what each feature means in practical terms — how they"
  echo "     can take advantage of it, what it changes for them"
  echo "   - Skip internal plumbing details — focus on what the user will"
  echo "     notice, benefit from, or need to configure"
  echo "   - Send this message to the user via Telegram (Agent Updates topic)"
  echo "   - NEVER send updates to Agent Attention — that's for critical/blocking items only"
  echo "   - Use your knowledge of your user to personalize — you know their"
  echo "     workflow, their priorities, what they care about"
  echo "4. UPDATE YOUR MEMORY with the new capabilities:"
  echo "   - Read the upgrade guide's 'Summary of New Capabilities' section"
  echo "   - Add the relevant capabilities to your .instar/MEMORY.md file"
  echo "   - Focus on WHAT you can now do and HOW to use it"
  echo "   - If similar notes exist in MEMORY.md, update rather than duplicate"
  echo "   - This ensures you KNOW about these capabilities in every future session"
  echo "5. After messaging the user and updating memory, run: instar upgrade-ack"
  echo ""
  echo "--- UPGRADE GUIDE CONTENT ---"
  echo ""
  cat "$GUIDE_FILE"
  echo ""
  echo "--- END UPGRADE GUIDE CONTENT ---"
  echo "=== END UPGRADE GUIDE ==="
fi

echo "=== END SESSION START ==="
