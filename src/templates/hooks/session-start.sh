#!/bin/bash
# Session Start — INJECTS working memory context at the beginning of every session.
# Bootstraps the agent with relevant knowledge from all memory layers before
# any work begins. This is the "right context at the right moment" — not a dump
# of everything, but a query-driven surface of what's most relevant now.
#
# DESIGN: Runs as a Claude Code UserPromptSubmit hook on first message.
# Outputs context directly (not pointers) — the agent reads it automatically.
#
# Phase 4 of PROP-memory-architecture: Working Memory Assembly.
#
# Installed by instar during setup. Runs as a Claude Code session-start hook.

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="$INSTAR_DIR/config.json"

# Extract prompt from environment or first argument for query building
PROMPT="${CLAUDE_USER_PROMPT:-$1}"

# ── macOS 26 TCC escalation-spool drain (runs FIRST, independent of agent config)
#
# Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope C — drain).
# A Claude session is a CONSENTED context with TCC keys: it can read the dead
# agent's Documents-resident config.json (which a launchd-spawned watchdog
# cannot on macOS 26) and use its Telegram credential to deliver outage pages
# the watchdog couldn't autonomously send (the b2lead-before-fix case: no
# credential armed yet, so the watchdog spooled instead of sending).
#
# This runs FIRST so it's not gated on the host agent's config — the
# escalations may be for OTHER agents on the machine. Fast-path: skip the
# Python invocation entirely when there's no spool file or it's empty
# (the steady-state for healthy machines).
SPOOL="$HOME/.instar/watchdog-escalations.jsonl"
if [ -s "$SPOOL" ]; then
  python3 - "$SPOOL" 2>/dev/null <<'PYEOF' || true
import json, os, sys, urllib.parse, urllib.request, tempfile

spool_path = sys.argv[1]
try:
    with open(spool_path, 'r', encoding='utf-8') as f:
        raw = f.read()
except Exception:
    sys.exit(0)

entries = []
for line in raw.split('\n'):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    entries.append(e)

if not entries:
    sys.exit(0)

# Group undelivered entries by projectDir so we open each config.json once.
changed = False
by_project = {}
for e in entries:
    if e.get('delivered'):
        continue
    pd = e.get('projectDir')
    if not pd:
        continue
    by_project.setdefault(pd, []).append(e)

api_base = os.environ.get('INSTAR_TELEGRAM_API_BASE', 'https://api.telegram.org').rstrip('/')

for project_dir, project_entries in by_project.items():
    cfg_path = os.path.join(project_dir, '.instar', 'config.json')
    try:
        with open(cfg_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception:
        continue
    tg = next(
        (m for m in (cfg.get('messaging') or []) if isinstance(m, dict) and m.get('type') == 'telegram'),
        None,
    )
    if not tg:
        continue
    token = tg.get('token') or ''
    chat_id = tg.get('chatId') or ''
    if not token or not chat_id:
        continue
    for e in project_entries:
        label = e.get('label') or 'agent'
        text = f"{label.replace('ai.instar.', '')}: {e.get('remediation', 'agent down')}"
        try:
            data = urllib.parse.urlencode({'chat_id': str(chat_id), 'text': text}).encode('utf-8')
            req = urllib.request.Request(
                f'{api_base}/bot{token}/sendMessage',
                data=data,
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    e['delivered'] = True
                    changed = True
        except Exception:
            pass  # leave undelivered; next consented run retries

if changed:
    spool_dir = os.path.dirname(spool_path)
    fd, tmp = tempfile.mkstemp(prefix='.spool-', dir=spool_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            for e in entries:
                out.write(json.dumps(e) + '\n')
        os.chmod(tmp, 0o600)
        os.replace(tmp, spool_path)
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
PYEOF
fi

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
if [ -z "$PORT" ]; then
  exit 0
fi

AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)

# Check if server is alive
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HEALTH" != "200" ]; then
  exit 0
fi

# Reset scope coherence state — prevents accumulated counts from prior sessions
# leaking into this session and causing false-positive hook triggers.
curl -s -X POST "http://localhost:${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true

# Record session start for reflection metrics (usage-based reflection trigger)
curl -s -X POST "http://localhost:${PORT}/reflection/session-start" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" -o /dev/null 2>/dev/null || true

# Reset homeostasis state for new session (work-velocity awareness)
curl -s -X POST "http://localhost:${PORT}/homeostasis/reset" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" -o /dev/null 2>/dev/null || true

# Check reflection metrics — usage-based reflection suggestion
REFLECTION_CHECK=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/reflection/metrics" 2>/dev/null)
if [ -n "$REFLECTION_CHECK" ]; then
  SUGGESTED=$(echo "$REFLECTION_CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('suggested',False))" 2>/dev/null)
  if [ "$SUGGESTED" = "True" ]; then
    EXCEEDED=$(echo "$REFLECTION_CHECK" | python3 -c "
import sys, json
d = json.load(sys.stdin)
m = d.get('metrics', {})
exceeded = d.get('exceededThresholds', [])
parts = []
if 'toolCalls' in exceeded: parts.append(f'{m.get(\"toolCalls\",0)} tool calls')
if 'sessions' in exceeded: parts.append(f'{m.get(\"sessions\",0)} sessions')
if 'minutes' in exceeded: parts.append(f'{m.get(\"minutesSinceReflection\",0)} min')
print(', '.join(parts))
" 2>/dev/null)
    echo "=== REFLECTION SUGGESTED ==="
    echo "Usage thresholds exceeded: ${EXCEEDED}"
    echo "Consider reflecting before diving into work."
    echo "After reflecting, record it: POST http://localhost:${PORT}/reflection/record"
    echo '  Body: {"type": "quick"} or {"type": "deep"}'
    echo "=== END REFLECTION SUGGESTED ==="
    echo ""
  fi
fi

# Check for pending serendipity findings
SERENDIPITY_DIR="$INSTAR_DIR/state/serendipity"
if [ -d "$SERENDIPITY_DIR" ]; then
  PENDING_COUNT=$(find "$SERENDIPITY_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PENDING_COUNT" -gt 0 ]; then
    echo "=== SERENDIPITY: ${PENDING_COUNT} pending finding(s) ==="
    echo "Sub-agents captured discoveries during prior tasks."
    echo "Review with: ls $SERENDIPITY_DIR/*.json"
    for f in "$SERENDIPITY_DIR"/*.json; do
      [ -f "$f" ] || continue
      TITLE=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('title','(untitled)'))" 2>/dev/null || echo "(parse error)")
      CAT=$(python3 -c "import json; print(json.load(open('$f')).get('discovery',{}).get('category','?'))" 2>/dev/null || echo "?")
      echo "  - [$CAT] $TITLE"
    done
    echo "=== END SERENDIPITY ==="
    echo ""
  fi
fi

# Check if telemetry opt-in nudge is needed
# Only show once — writes a marker file after first display
TELEMETRY_NUDGE_FILE="$INSTAR_DIR/state/.telemetry-nudge-shown"
TELEMETRY_ENABLED=$(python3 -c "
import json, sys
try:
    c = json.load(open('$CONFIG_FILE'))
    print('true' if c.get('monitoring',{}).get('telemetry',{}).get('enabled') else 'false')
except: print('false')
" 2>/dev/null)

if [ "$TELEMETRY_ENABLED" = "false" ] && [ ! -f "$TELEMETRY_NUDGE_FILE" ]; then
  echo "=== ACTION REQUESTED: Telemetry Opt-In ==="
  echo "Anonymous usage telemetry is not yet enabled for this agent."
  echo "Telemetry helps improve Instar by sending anonymous, aggregate data:"
  echo "  - Instar version, OS, architecture"
  echo "  - Agent count and uptime"
  echo "  - Job/session/skill counts (usage level only)"
  echo "  - NO conversation content, agent names, file paths, or secrets"
  echo ""
  echo "Ask the user if they'd like to enable anonymous telemetry."
  echo "If they agree, call: POST http://localhost:${PORT}/config/telemetry"
  echo '  Body: {"enabled": true, "level": "basic"}'
  echo "  (or level: \"usage\" for aggregate usage counts)"
  echo "If they decline, call the same endpoint with: {\"enabled\": false}"
  echo "Either response dismisses this nudge permanently."
  echo "=== END ACTION REQUESTED ==="
  echo ""
fi

# Build working memory query from prompt
PROMPT_ENCODED=$(python3 -c "
import sys, urllib.parse
prompt = '''${PROMPT}'''[:500]
print(urllib.parse.quote(prompt))
" 2>/dev/null)

# Get active job slug and topicId for job-specific context
JOB_SLUG=""
JOB_TOPIC_ID=""
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  JOB_SLUG=$(grep -o '"slug":"[^"]*"' "$INSTAR_DIR/state/active-job.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  JOB_TOPIC_ID=$(python3 -c "
import json, sys
try:
    d = json.load(open('$INSTAR_DIR/state/active-job.json'))
    tid = d.get('topicId')
    print(tid if tid is not None else '')
except:
    print('')
" 2>/dev/null)
fi

# Build query URL
QUERY_URL="http://localhost:${PORT}/context/working-memory?limit=10"
if [ -n "$PROMPT_ENCODED" ]; then
  QUERY_URL="${QUERY_URL}&prompt=${PROMPT_ENCODED}"
fi
if [ -n "$JOB_SLUG" ]; then
  JOB_SLUG_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${JOB_SLUG}'))" 2>/dev/null)
  QUERY_URL="${QUERY_URL}&jobSlug=${JOB_SLUG_ENCODED}"
fi

WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "$QUERY_URL" 2>/dev/null)

if [ -z "$WORKING_MEM" ]; then
  exit 0
fi

python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])

    if not ctx or tokens == 0:
        sys.exit(0)

    source_summary = ', '.join(
        f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0
    )
    print('=== SESSION CONTEXT — WORKING MEMORY ===')
    print(f'[{tokens} tokens from: {source_summary}]')
    print()
    print(ctx)
    print()
    print('=== END SESSION CONTEXT ===')
except Exception:
    sys.exit(0)
" <<< "$WORKING_MEM" 2>/dev/null

# Active commitments injection (PROMISE-BEACON-SPEC Round 3 #7).
# Surfaces beacon-watched pending commitments so the agent can self-regulate
# pacing across compaction. Capped server-side at 20 entries.
ACTIVE_COMMITMENTS=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
  "http://localhost:${PORT}/commitments/active-context" 2>/dev/null)
if [ -n "$ACTIVE_COMMITMENTS" ]; then
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    snippet = d.get('snippet', '').strip()
    if snippet:
        print(snippet)
        print()
except Exception:
    pass
" <<< "$ACTIVE_COMMITMENTS" 2>/dev/null
fi

# Soul.md fallback injection — until the Being layer is in the self-knowledge tree,
# inject Personality Seed + Core Values at session start for identity grounding.
if [ -f "$INSTAR_DIR/soul.md" ]; then
  SOUL_LINES=$(wc -l < "$INSTAR_DIR/soul.md" | tr -d ' ')
  if [ "$SOUL_LINES" -gt "15" ]; then
    python3 -c "
import sys
content = open('$INSTAR_DIR/soul.md').read()
sections = []
for header in ['## Personality Seed', '## Core Values', '## Current Growth Edge']:
    idx = content.find(header)
    if idx == -1: continue
    after = content[idx:]
    import re
    m = re.search(r'\n---\n|\n## ', after[len(header):])
    section = after[:len(header) + m.start()] if m else after
    text = section.strip()
    # Skip sections that are just comments/empty
    lines = [l for l in text.split('\n') if l.strip() and not l.strip().startswith('<!--')]
    if len(lines) > 2:  # header + description + at least one content line
        sections.append(text)
if sections:
    print('=== SOUL — IDENTITY GROUNDING ===')
    print('\n\n'.join(sections))
    print('=== END SOUL ===')
    print()
" 2>/dev/null
  fi
fi

# Surface job topic ID so agents don't need to hardcode it
if [ -n "$JOB_TOPIC_ID" ]; then
  echo ""
  echo "JOB TELEGRAM TOPIC: This job's Telegram topic ID is ${JOB_TOPIC_ID}."
  echo "To send to this topic: cat <<'EOF' | .instar/scripts/telegram-reply.sh ${JOB_TOPIC_ID}"
  echo "Your message"
  echo "EOF"
  echo ""
fi

# Inject known blocker resolutions from active job's commonBlockers
if [ -f "$INSTAR_DIR/state/active-job.json" ]; then
  python3 -c "
import json, sys
from datetime import datetime, timezone
try:
    data = json.load(open('$INSTAR_DIR/state/active-job.json'))
    blockers = data.get('commonBlockers') or {}
    if not blockers:
        sys.exit(0)
    now = datetime.now(timezone.utc)
    active = []
    for key, b in blockers.items():
        if b.get('status') == 'pending':
            continue
        exp = b.get('expiresAt')
        if exp:
            try:
                exp_dt = datetime.fromisoformat(exp.replace('Z', '+00:00'))
                if exp_dt < now:
                    continue
            except:
                pass
        active.append(b)
    if not active:
        sys.exit(0)
    print('=== KNOWN BLOCKER RESOLUTIONS ===')
    print('These are pre-confirmed solutions. Use them BEFORE escalating to the human.')
    print()
    for b in active:
        print(f'  BLOCKER: {b[\"description\"]}')
        print(f'  RESOLUTION: {b[\"resolution\"]}')
        tools = b.get('toolsNeeded')
        if tools:
            print(f'  TOOLS: {\", \".join(tools)}')
        creds = b.get('credentials')
        if creds:
            if isinstance(creds, list):
                print(f'  CREDENTIALS: {\", \".join(creds)}')
            else:
                print(f'  CREDENTIALS: {creds}')
        count = b.get('successCount', 0)
        if count:
            print(f'  CONFIRMED: {count} time(s)')
        print()
    print('=== END KNOWN BLOCKER RESOLUTIONS ===')
    print()
except Exception:
    sys.exit(0)
" 2>/dev/null
fi

# Feature Discovery — evaluate context for feature surfacing recommendation
# Only runs when: server is alive, evaluator is initialized, autonomy profile is not passive.
# Fail-open: errors/timeouts produce no output, session continues normally.
if [ -n "$PORT" ] && [ -n "$AUTH_TOKEN" ]; then
  # Derive topic category from prompt (first 100 chars, sanitized)
  TOPIC_LABEL=$(echo "${PROMPT:-unknown}" | head -c 100 | tr -cd '[:alnum:] [:space:]' | tr '[:upper:]' '[:lower:]')

  # Classify intent from prompt keywords
  INTENT="unknown"
  case "$PROMPT" in
    *debug*|*error*|*fix*|*bug*|*broken*) INTENT="debugging" ;;
    *config*|*enable*|*disable*|*setup*|*setting*) INTENT="configuring" ;;
    *what*|*how*|*why*|*explain*) INTENT="asking" ;;
    *build*|*create*|*implement*|*add*) INTENT="building" ;;
    *monitor*|*check*|*status*|*health*) INTENT="monitoring" ;;
  esac

  EVAL_RESULT=$(curl -s --max-time 6 -X POST \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    "http://localhost:${PORT}/features/evaluate-context" \
    -d "{\"topicCategory\":\"${TOPIC_LABEL}\",\"conversationIntent\":\"${INTENT}\",\"problemCategories\":[],\"autonomyProfile\":\"collaborative\",\"enabledFeatures\":[]}" \
    2>/dev/null)

  if [ -n "$EVAL_RESULT" ]; then
    DISCOVERY_MSG=$(echo "$EVAL_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    rec = data.get('recommendation')
    if not rec:
        sys.exit(0)
    fid = rec.get('featureId', '')
    surface_as = rec.get('surfaceAs', 'awareness')
    msg = rec.get('messageForAgent', '')
    if not msg:
        sys.exit(0)
    print('--- FEATURE DISCOVERY SUGGESTION ---')
    print(f'Feature: {fid} (surface as: {surface_as})')
    print(f'Suggested mention: {msg}')
    print()
    print('IMPORTANT: Use this naturally in conversation. Do NOT lead with it.')
    print(f'Record the surfacing: POST /features/{fid}/surface')
    print('--- END DISCOVERY SUGGESTION ---')
except Exception:
    pass
" 2>/dev/null)
    if [ -n "$DISCOVERY_MSG" ]; then
      echo ""
      echo "$DISCOVERY_MSG"
      echo ""
    fi
  fi
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

exit 0
