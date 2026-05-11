#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="${CLAUDE_HOOK_MATCHER:-startup}"

# On compaction, delegate to the dedicated recovery hook
if [ "$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# TOPIC CONTEXT (loaded FIRST — highest priority context)
if [ -n "$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "$CONFIG_FILE" ]; then
    PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
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
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
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
      cat "$DISPATCH_FILE" | head -20
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
  PORT=$(grep -o '"port":[0-9]*' "$INSTAR_DIR/config.json" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('authToken',''))" 2>/dev/null)
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

# Active projects digest — file-first, no HTTP (PROJECT-SCOPE-SPEC Phase 1.9).
# Reads .instar/projects-digest.cache, written by the server on every
# project mutation. Re-sanitizes each line on read for defense in depth.
DIGEST_FILE="$INSTAR_DIR/projects-digest.cache"
echo ""
if [ -f "$DIGEST_FILE" ]; then
  PROJ_DIGEST=$(python3 - "$DIGEST_FILE" <<'PYEOF' 2>/dev/null
import json, re, sys
path = sys.argv[1]
try:
    with open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
    lines = d.get('digestLines') or []
    if not isinstance(lines, list):
        sys.exit(0)
    ctrl = re.compile(r'[\x00-\x1F\x7F]')
    cleaned = []
    for ln in lines[:5]:
        if not isinstance(ln, str):
            continue
        s = ctrl.sub(' ', ln)
        s = re.sub(r'\s+', ' ', s).strip()
        if not s:
            continue
        # 200-char hard cap on the rendered line (≥ 80-char title + framing)
        cleaned.append(s[:200])
    if not cleaned:
        print('Active projects: none')
    else:
        print('--- ACTIVE PROJECTS ---')
        for c in cleaned:
            print(c)
        truncated = bool(d.get('truncated'))
        total = d.get('totalActiveProjects')
        if truncated and isinstance(total, int) and total > len(cleaned):
            more = total - len(cleaned)
            print(f'+{more} more on dashboard.')
        print('--- END ACTIVE PROJECTS ---')
except Exception:
    sys.exit(0)
PYEOF
)
  if [ -n "$PROJ_DIGEST" ]; then
    echo "$PROJ_DIGEST"
  else
    echo "Active projects: state unavailable — run /project status when ready"
  fi
else
  echo "Active projects: state unavailable — run /project status when ready"
fi

echo "=== END SESSION START ==="
