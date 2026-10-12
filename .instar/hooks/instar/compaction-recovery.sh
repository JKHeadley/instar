#!/bin/bash
# Compaction recovery — re-injects identity AND topic context when Claude's context compresses.
# Born from Dawn's 164th Lesson: "Advisory hooks get ignored. Automatic content
# injection removes the compliance gap entirely."
#
# This hook OUTPUTS identity content directly into context rather than just
# pointing to files. After compaction, the agent needs to KNOW who it is
# AND what conversation it's in — not be told where to look.
#
# Context priority (same as session-start):
#   1. Topic context (summary + recent messages) — what are we working on?
#   2. Identity (AGENT.md) — who am I?
#   3. Memory (MEMORY.md) — what have I learned?
#   4. Telegram relay — how do I respond?
#   5. Capabilities — what can I do?
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== IDENTITY RECOVERY (post-compaction) ==="

# ── 1. TOPIC CONTEXT (highest priority — what are we working on?) ──
# After compaction, the conversation history is lost. Re-inject it from TopicMemory.
if [ -n "$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "$CONFIG_FILE" ]; then
    PORT=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
    if [ -n "$PORT" ]; then
      # Restore the temporal awareness projection before the ordinary topic
      # summary. Compaction may occur without another UserPromptSubmit, so this
      # is a distinct delivery seam rather than a duplicate convenience.
      AWARENESS_TOKEN="${INSTAR_AUTH_TOKEN:-}"
      if [ -z "$AWARENESS_TOKEN" ]; then
        AWARENESS_TOKEN=$(python3 -c "import json; v=json.load(open('$CONFIG_FILE')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
      fi
      AWARENESS_AGENT_ID="${INSTAR_AGENT_ID:-}"
      if [ -z "$AWARENESS_AGENT_ID" ]; then
        AWARENESS_AGENT_ID=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('projectName',''))" 2>/dev/null)
      fi
      if [ -n "$AWARENESS_TOKEN" ]; then
        TOPIC_BRIEFING=$(curl -sf --max-time 2 \
          -H "Authorization: Bearer ${AWARENESS_TOKEN}" \
          -H "X-Instar-AgentId: ${AWARENESS_AGENT_ID}" \
          "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
      else
        TOPIC_BRIEFING=$(curl -sf --max-time 2 \
          "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
      fi
      if [ -n "$TOPIC_BRIEFING" ]; then
        echo "$TOPIC_BRIEFING"
        echo ""
      fi

      if [ -n "$AWARENESS_TOKEN" ]; then
        TOPIC_CTX=$(curl -sf --max-time 2 \
          -H "Authorization: Bearer ${AWARENESS_TOKEN}" \
          -H "X-Instar-AgentId: ${AWARENESS_AGENT_ID}" \
          "http://localhost:${PORT}/topic/context/${TOPIC_ID}?recent=20" 2>/dev/null)
      else
        TOPIC_CTX=$(curl -sf --max-time 2 \
          "http://localhost:${PORT}/topic/context/${TOPIC_ID}?recent=20" 2>/dev/null)
      fi
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
msgs = d.get('recentMessages', [])
for m in msgs:
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = _localts(m.get('timestamp', ''))
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')

# Detect unanswered user messages
pending_user = []
for m in msgs:
    text = m.get('text', '').strip()
    if not text:
        continue
    if m.get('fromUser'):
        pending_user.append(m)
    else:
        pending_user = []

if pending_user:
    print()
    print('!' * 60)
    print('UNANSWERED MESSAGE(S) FROM USER:')
    for pm in pending_user:
        pm_text = pm.get('text', '')[:200]
        pm_ts = _localts(pm.get('timestamp', ''))
        print(f'  [{pm_ts}] \"{pm_text}\"')
    print()
    print('You MUST address these messages substantively. Do NOT respond')
    print('with just a greeting or generic reply. If the latest message')
    print('is a follow-up like \"hello?\" or \"please respond\", address')
    print('the EARLIER unanswered message — that is what the user is')
    print('waiting for.')
    print('!' * 60)
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:${PORT}/topic/search?topic=${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# ── 2. IDENTITY (full AGENT.md — who am I?) ──
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  echo "--- Your Identity (from .instar/AGENT.md) ---"
  cat "$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- End Identity ---"
fi

# ── 2b. PROJECT CONTEXT (where am I working?) ──
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
    print(f'Files: {m["totalFiles"]} across {len(m.get("directories", []))} directories')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# ── 3. MEMORY (first 50 lines — what have I learned?) ──
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  LINES=$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  echo ""
  echo "--- Your Memory (.instar/MEMORY.md — ${LINES} lines, showing first 50) ---"
  head -50 "$INSTAR_DIR/MEMORY.md"
  if [ "$LINES" -gt 50 ]; then
    echo "... ($((LINES - 50)) more lines — read full file if needed)"
  fi
  echo "--- End Memory ---"
fi

# ── 4. TELEGRAM RELAY (how do I respond?) ──
if [ -n "$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  if [ -f "$INSTAR_DIR/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  elif [ -f "${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  fi

  echo ""
  echo "--- TELEGRAM SESSION (topic ${TOPIC_ID}) ---"
  echo "This session is connected to Telegram topic ${TOPIC_ID}."
  echo "Messages arrive prefixed with [telegram:${TOPIC_ID}]. Strip prefix before interpreting."
  echo "After EVERY response, relay your text back:"
  if [ -n "$RELAY_SCRIPT" ]; then
    echo "  cat <<'EOF' | ${RELAY_SCRIPT} ${TOPIC_ID}"
  else
    echo "  cat <<'EOF' | .instar/scripts/telegram-reply.sh ${TOPIC_ID}"
  fi
  echo "  Your response text here"
  echo "  EOF"
  echo "--- END TELEGRAM SESSION ---"
fi

# ── 5. SERVER STATUS + CAPABILITIES ──
CONFIG_FILE="$INSTAR_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
  if [ "$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port ${PORT}"
    CAPS=$(curl -s "http://localhost:${PORT}/capabilities" 2>/dev/null)
    if echo "$CAPS" | grep -q '"featureGuide"' 2>/dev/null; then
      echo ""
      echo "--- YOUR CAPABILITIES ---"
      echo "$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    for t in guide.get('triggers', []):
        print(f'  When: {t["context"]}')
        print(f'  Do:   {t["action"]}')
        print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, read Y" routing
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

# Working Memory — surface relevant knowledge after compaction
# This restores what you knew before compaction that's relevant now.
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
      WM_QUERY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('compaction-recovery context-restoration'))" 2>/dev/null)
      WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}"         "http://localhost:${PORT}/context/working-memory?prompt=${WM_QUERY}&limit=6" 2>/dev/null)
      if [ -n "$WORKING_MEM" ]; then
        WM_CONTEXT=$(echo "$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "$WM_CONTEXT" ]; then
          echo "--- WORKING MEMORY RESTORED ---"
          echo "$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
          echo ""
        fi
      fi
    fi
  fi
fi

# SESSION BOOT SELF-KNOWLEDGE re-injection (spec: session-boot-self-knowledge.md).
# A days-long session compacts; the boot block injected at session start only
# survives if the compaction summary happens to carry it — willpower, not
# structure. Re-fetching here makes the block durable across compaction AND
# fresher than the original: a secret stored mid-session appears in the
# post-compaction context. Same fail-open contract as the boot fetch: dark /
# unreachable / version-skew -> silent skip, header-only Bearer.
if [ -f "$INSTAR_DIR/config.json" ]; then
  BOOT_SK_PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  BOOT_SK_TOKEN="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$BOOT_SK_TOKEN" ]; then
    BOOT_SK_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -n "$BOOT_SK_PORT" ] && [ -n "$BOOT_SK_TOKEN" ]; then
    BOOT_SK_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $BOOT_SK_TOKEN"       "http://localhost:${BOOT_SK_PORT}/self-knowledge/session-context" 2>/dev/null)
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
fi

# PLAYWRIGHT PROFILE REGISTRY re-injection (spec: playwright-profile-registry.md —
# Compaction Parity twin of the session-start boot pointer). The compact "browser
# profiles on this machine + the accounts each holds" pointer injected at session
# start only survives a compaction if the summary happens to carry it. Re-fetching
# here makes it durable across compaction. Same fail-open contract as the boot fetch:
# dark (503) / unreachable / version-skew -> silent skip, header-only Bearer.
if [ -f "$INSTAR_DIR/config.json" ]; then
  BOOT_PW_PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  BOOT_PW_TOKEN="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$BOOT_PW_TOKEN" ]; then
    BOOT_PW_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -n "$BOOT_PW_PORT" ] && [ -n "$BOOT_PW_TOKEN" ]; then
    BOOT_PW_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $BOOT_PW_TOKEN"       "http://localhost:${BOOT_PW_PORT}/playwright-profiles/session-context" 2>/dev/null)
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
fi

# TOPIC OPERATOR re-injection (Know Your Principal #898, increment 2c — Compaction
# Parity twin of the session-start block). The verified operator binding injected at
# session start only survives a compaction if the summary happens to carry it —
# willpower, not structure. Re-fetching here makes the agent re-learn WHO its
# verified operator is after a context reset; losing that awareness post-compaction
# is exactly the identity gap this feature closes. Same fail-open contract as the
# boot fetch: no topic / unbound / store-503 / unreachable -> silent skip,
# header-only Bearer.
if [ -n "$INSTAR_TELEGRAM_TOPIC" ] && [ -f "$INSTAR_DIR/config.json" ]; then
  TOPIC_OP_PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  TOPIC_OP_TOKEN="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$TOPIC_OP_TOKEN" ]; then
    TOPIC_OP_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -n "$TOPIC_OP_PORT" ] && [ -n "$TOPIC_OP_TOKEN" ]; then
    TOPIC_OP_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $TOPIC_OP_TOKEN" \
      "http://localhost:${TOPIC_OP_PORT}/topic-operator/session-context?topicId=${INSTAR_TELEGRAM_TOPIC}" 2>/dev/null)
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
fi

# JEV MEMORY PICKER twin (Compaction Parity). MEMORY.md is loaded again after a
# compaction, so the picker ranks again for the post-compaction context.
if [ -f "$INSTAR_DIR/config.json" ]; then
  MEM_PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  MEM_TOKEN="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$MEM_TOKEN" ]; then
    MEM_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  MEM_EVENT="compact"
fi
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


# WORKING-SET ARTIFACT grounding twin (Compaction Parity — intelligent-working-set-lazy-sync
# Layer-3). Mirrors the session-start injection so after a compaction the agent is RE-grounded
# on the interactive artifacts it recorded for this conversation. ADVISORY only (a path is
# untrusted data). Fail-open: no topic / 503 (feature dark) / no ready artifacts / unreachable -> skip.
if [ -n "$INSTAR_TELEGRAM_TOPIC" ] && [ -f "$INSTAR_DIR/config.json" ]; then
  WS_ART_PORT=${PORT:-$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  WS_ART_TOKEN="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$WS_ART_TOKEN" ]; then
    WS_ART_TOKEN=$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -n "$WS_ART_PORT" ] && [ -n "$WS_ART_TOKEN" ]; then
    WS_ART_RESPONSE=$(curl -sf --max-time 4 --connect-timeout 1 -H "Authorization: Bearer $WS_ART_TOKEN" \
      "http://localhost:${WS_ART_PORT}/coherence/working-set/session-context?topic=${INSTAR_TELEGRAM_TOPIC}" 2>/dev/null)
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
fi

echo "=== END IDENTITY RECOVERY ==="
