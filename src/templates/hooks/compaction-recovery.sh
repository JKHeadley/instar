#!/bin/bash
# Compaction recovery — INJECTS identity when Claude's context compresses.
# Without this, the agent loses its identity every 30-60 minutes.
#
# CRITICAL DESIGN: This hook OUTPUTS file content directly, not pointers.
# After compaction, the agent is confused — asking it to read files is
# asking the confused agent to help itself. Structure > Willpower:
# the hook does the work, not the agent.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a Claude Code Notification hook
# matched on "compaction".

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== COMPACTION RECOVERY — IDENTITY RESTORATION ==="
echo ""

# Phase A: Core Identity (inject AGENT.md content directly)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo "--- YOUR IDENTITY (from .instar/AGENT.md) ---"
  cat "$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- END IDENTITY ---"
  echo ""
fi

# Phase A.5: Soul (inject Personality Seed + Core Values from soul.md)
# Only inject compact identity sections, not full history.
# Integrity-verified: if soul.md was tampered with, fall back to init snapshot.
if [ -f "$INSTAR_DIR/soul.md" ]; then
  SOUL_LINES=$(wc -l < "$INSTAR_DIR/soul.md" | tr -d ' ')
  if [ "$SOUL_LINES" -gt "10" ]; then
    # Check integrity via server if available
    SOUL_INTEGRITY="valid"
    if [ -n "$PORT" ] && [ -n "$AUTH_TOKEN" ]; then
      INTEGRITY_CHECK=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
        "http://localhost:${PORT}/identity/soul/integrity" 2>/dev/null)
      SOUL_INTEGRITY=$(echo "$INTEGRITY_CHECK" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('valid' if d.get('valid') else 'invalid')
except: print('valid')
" 2>/dev/null)
    fi

    if [ "$SOUL_INTEGRITY" = "valid" ]; then
      # Extract Personality Seed and Core Values sections only
      echo "--- YOUR SOUL (from .instar/soul.md — Personality Seed + Core Values) ---"
      python3 -c "
import sys
content = open('$INSTAR_DIR/soul.md').read()
sections = []
for header in ['## Personality Seed', '## Core Values']:
    idx = content.find(header)
    if idx == -1: continue
    after = content[idx:]
    # Find next section boundary
    import re
    m = re.search(r'\n---\n|\n## ', after[len(header):])
    section = after[:len(header) + m.start()] if m else after
    sections.append(section.strip())
if sections:
    print('\n\n'.join(sections))
" 2>/dev/null
      echo ""
      echo "--- END SOUL ---"
      echo ""
    else
      # Fall back to init snapshot
      if [ -f "$INSTAR_DIR/state/soul.init.md" ]; then
        echo "--- YOUR SOUL (from init snapshot — integrity check failed) ---"
        python3 -c "
content = open('$INSTAR_DIR/state/soul.init.md').read()
idx = content.find('## Personality Seed')
if idx >= 0:
    import re
    after = content[idx:]
    m = re.search(r'\n---\n|\n## ', after[len('## Personality Seed'):])
    section = after[:len('## Personality Seed') + m.start()] if m else after
    print(section.strip())
" 2>/dev/null
        echo ""
        echo "WARNING: soul.md integrity check failed. Only Personality Seed from init snapshot injected."
        echo "--- END SOUL ---"
        echo ""
      fi
    fi
  fi
fi

# Phase B: Memory (inject MEMORY.md content directly)
if [ -f "$INSTAR_DIR/MEMORY.md" ]; then
  # Only inject if MEMORY.md has actual content (more than the template skeleton)
  MEMORY_LINES=$(wc -l < "$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  if [ "$MEMORY_LINES" -gt "15" ]; then
    echo "--- YOUR MEMORY (from .instar/MEMORY.md) ---"
    cat "$INSTAR_DIR/MEMORY.md"
    echo ""
    echo "--- END MEMORY ---"
    echo ""
  else
    echo "Memory file exists at .instar/MEMORY.md (minimal content — check if needed)."
    echo ""
  fi
fi

# Phase C: User context (inject USER.md content directly)
if [ -f "$INSTAR_DIR/USER.md" ]; then
  echo "--- YOUR USER (from .instar/USER.md) ---"
  cat "$INSTAR_DIR/USER.md"
  echo ""
  echo "--- END USER ---"
  echo ""
fi

# Phase D: Active dispatch context (behavioral lessons from Dawn)
if [ -f "$INSTAR_DIR/state/dispatch-context.md" ]; then
  DISPATCH_LINES=$(wc -l < "$INSTAR_DIR/state/dispatch-context.md" | tr -d ' ')
  if [ "$DISPATCH_LINES" -gt "2" ]; then
    echo "--- ACTIVE DISPATCHES (behavioral lessons) ---"
    cat "$INSTAR_DIR/state/dispatch-context.md"
    echo ""
    echo "--- END DISPATCHES ---"
    echo ""
  fi
fi

# Phase E: Job-specific grounding (if a job slug is detectable)
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
  if [ -n "$JOB_SLUG" ]; then
    if [ -f "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md" ]; then
      echo "--- JOB CONTEXT: ${JOB_SLUG} ---"
      cat "$INSTAR_DIR/grounding/jobs/${JOB_SLUG}.md"
      echo ""
      echo "--- END JOB CONTEXT ---"
      echo ""
    fi
    # Surface the job's Telegram topic ID so agents don't hardcode it
    if [ -n "$JOB_TOPIC_ID" ]; then
      echo "JOB TELEGRAM TOPIC: This job's Telegram topic ID is ${JOB_TOPIC_ID}."
      echo "Use: cat <<'EOF' | .instar/scripts/telegram-reply.sh ${JOB_TOPIC_ID}"
      echo "Your message here"
      echo "EOF"
      echo ""
    fi
  fi
fi

# Phase F: Core cognitive principles (universal, survive compaction)
echo "--- COGNITIVE PRINCIPLES (always active) ---"
echo "1. SUBSTANCE OVER LABELS: Identity is content, not metadata. Different titles/IDs/statuses can hide identical content. Always verify at the content level."
echo "2. CONTRADICTION = NEW CHECK: When a human contradicts your data, run a DIFFERENT kind of check, not the same one again. The human has information you don't."
echo "3. CONFIDENCE INVERSION: The more obvious something feels, the more it needs verification. High confidence is where errors hide."
echo "4. INHERITED CLAIMS: Handoff notes and previous session logs are CLAIMS TO VERIFY, not facts. Any claim about external state (repo, deployment, service, file) requires a verification command in THIS session. No command, no claim."
echo "5. DISMISSAL WITHOUT INVESTIGATION: Never resolve a bug report or feedback item based on the title alone. Trace the reporter's actual code path first. If your resolution says 'this theoretically can't happen' — you haven't investigated."
echo "--- END PRINCIPLES ---"
echo ""

# Phase F.5: Discovery state (prevents re-surfacing features already mentioned this session)
# Resolves Open Question #5 from the Consent & Discovery Framework spec:
# lastSurfacedAt timestamps persist in SQLite regardless of context state.
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
    FEATURES_JSON=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:${PORT}/features/summary" 2>/dev/null)
    if [ -n "$FEATURES_JSON" ]; then
      DISCOVERY_STATE=$(echo "$FEATURES_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    features = data.get('features', [])
    if not features:
        sys.exit(0)
    enabled = [f['name'] for f in features if f.get('discoveryState') == 'enabled']
    undiscovered = [f['name'] for f in features if f.get('discoveryState') == 'undiscovered']
    aware = [f['name'] for f in features if f.get('discoveryState') in ('aware', 'interested', 'deferred')]
    if enabled:
        print(f'Enabled features: {\", \".join(enabled)}')
    if undiscovered:
        print(f'Undiscovered (available to surface): {\", \".join(undiscovered)}')
    if aware:
        print(f'User is aware of: {\", \".join(aware)}')
    print()
    print('IMPORTANT: Do NOT re-surface features already mentioned this session.')
    print('Check POST /features/:id/surface timestamps before surfacing.')
    print('Max 1 feature per conversation turn. Never during user frustration.')
except Exception:
    pass
" 2>/dev/null)
      if [ -n "$DISCOVERY_STATE" ]; then
        echo "--- FEATURE DISCOVERY STATE (compaction-safe) ---"
        echo "$DISCOVERY_STATE"
        echo "--- END DISCOVERY STATE ---"
        echo ""
      fi
    fi
  fi
fi

# Relationships summary
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REL_COUNT" -gt "0" ]; then
    echo "You have ${REL_COUNT} tracked relationships in .instar/relationships/."
    echo ""
  fi
fi

# Serendipity findings status
SERENDIPITY_DIR="$INSTAR_DIR/state/serendipity"
if [ -d "$SERENDIPITY_DIR" ]; then
  PENDING_COUNT=$(find "$SERENDIPITY_DIR" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PENDING_COUNT" -gt "0" ]; then
    echo "${PENDING_COUNT} pending serendipity finding(s) in .instar/state/serendipity/ — triage when current task completes."
    echo ""
  fi
fi

# Server health reminder + recent Telegram context
CONFIG_FILE="$INSTAR_DIR/config.json"
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    echo "Server: curl http://localhost:${PORT}/health | Capabilities: curl http://localhost:${PORT}/capabilities"

    # Inject recent conversation context after compaction — thread context is often
    # the first thing lost in compaction; re-injecting it immediately restores continuity.
    # Supports both Telegram topics and Slack channels via their respective env vars.
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
    if [ "$HEALTH" = "200" ]; then
      # Slack channel context — if INSTAR_SLACK_CHANNEL is set, this is a Slack session
      SLACK_CHANNEL="${INSTAR_SLACK_CHANNEL:-}"
      if [ -n "$SLACK_CHANNEL" ]; then
        AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
        SLACK_MSGS=$(curl -s \
          -H "Authorization: Bearer ${AUTH_TOKEN}" \
          "http://localhost:${PORT}/slack/channels/${SLACK_CHANNEL}/messages?limit=20" 2>/dev/null)

        echo "$SLACK_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print()
    print('CONTINUATION — You are resuming an EXISTING Slack conversation. Read the context below and pick up where you left off. Do NOT ask what was being discussed.')
    print()
    print('--- RECENT SLACK CONTEXT (restoring after compaction, last %d messages) ---' % len(msgs))

    for m in msgs:
        ts = m.get('ts', '')
        try:
            from datetime import datetime
            dt = datetime.fromtimestamp(float(ts))
            time_str = dt.strftime('%H:%M:%S')
        except:
            time_str = ts[:8] if ts else '??:??:??'
        user = m.get('user', 'unknown')
        bot_id = m.get('bot_id', '')
        label = 'Agent' if bot_id else user
        text = m.get('text', '').strip()
        if len(text) > 300:
            text = text[:297] + '...'
        print(f'[{time_str}] {label}: {text}')

    # Detect unanswered user messages
    pending_user = []
    for m in msgs:
        text = m.get('text', '').strip()
        if not text:
            continue
        is_bot = bool(m.get('bot_id'))
        if not is_bot:
            pending_user.append(m)
        else:
            pending_user = []

    if pending_user:
        print()
        print('!' * 60)
        print('UNANSWERED MESSAGE(S) FROM USER:')
        for pm in pending_user:
            pm_text = pm.get('text', '')[:200]
            print(f'  \"{pm_text}\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond')
        print('with just a greeting or generic reply.')
        print('!' * 60)
    print()
    print('--- END SLACK CONTEXT ---')
    import os
    ch = os.environ.get('INSTAR_SLACK_CHANNEL', '')
    print()
    print('CRITICAL: Relay your response back to Slack:')
    print('cat <<\"SLACKEOF\" | .claude/scripts/slack-reply.sh ' + ch)
    print('Your response text here')
    print('SLACKEOF')
except Exception:
    pass
" 2>/dev/null
      fi

      # Skip Telegram context if this is a Slack session (already injected above)
      if [ -n "$SLACK_CHANNEL" ]; then
        TOPIC_FOR_CONTEXT=""
      else
        TOPIC_FOR_CONTEXT="${INSTAR_TELEGRAM_TOPIC:-}"
      fi

      # Fall back to lifeline topic if no session topic set
      if [ -z "$TOPIC_FOR_CONTEXT" ]; then
        TOPIC_FOR_CONTEXT=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$CONFIG_FILE'))
    for m in cfg.get('messaging', []):
        if m.get('type') == 'telegram':
            tid = m.get('config', {}).get('lifelineTopicId')
            if tid:
                print(tid)
                sys.exit(0)
    tid = cfg.get('telegram', {}).get('lifelineTopicId')
    if tid:
        print(tid)
except Exception:
    pass
" 2>/dev/null)
      fi

      if [ -n "$TOPIC_FOR_CONTEXT" ]; then
        AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
        if [ -n "$AUTH_TOKEN" ]; then
          RECENT_MSGS=$(curl -s \
            -H "Authorization: Bearer ${AUTH_TOKEN}" \
            "http://localhost:${PORT}/telegram/topics/${TOPIC_FOR_CONTEXT}/messages?limit=15" 2>/dev/null)
        else
          RECENT_MSGS=$(curl -s \
            "http://localhost:${PORT}/telegram/topics/${TOPIC_FOR_CONTEXT}/messages?limit=15" 2>/dev/null)
        fi

        # Format messages and detect unanswered user messages
        echo "$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print()
    print('--- RECENT TELEGRAM CONTEXT (restoring after compaction, last %d messages) ---' % len(msgs))

    for m in msgs:
        ts = m.get('timestamp', '')[:16].replace('T', ' ')
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        text = m.get('text', '').strip()
        sender = 'User' if from_user else 'Agent'
        if len(text) > 300:
            text = text[:297] + '...'
        print(f'[{ts}] {sender}: {text}')

    # Detect unanswered user messages
    pending_user = []
    for m in msgs:
        text = m.get('text', '').strip()
        if not text:
            continue
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        if from_user:
            pending_user.append(m)
        else:
            pending_user = []

    if pending_user:
        print()
        print('!' * 60)
        print('UNANSWERED MESSAGE(S) FROM USER:')
        for pm in pending_user:
            pm_text = pm.get('text', '')[:200]
            pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
            print(f'  [{pm_ts}] \"{pm_text}\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond')
        print('with just a greeting or generic reply. If the latest message')
        print('is a follow-up like \"hello?\" or \"please respond\", address')
        print('the EARLIER unanswered message — that is what the user is')
        print('waiting for.')
        print('!' * 60)
    print()
    print('--- END TELEGRAM CONTEXT ---')
except Exception:
    pass
" 2>/dev/null
      fi
    fi
  fi
fi

# Phase G: Working Memory Assembly — inject relevant semantic knowledge after compaction
# This surfaces what you already know that's relevant to the current context,
# preventing you from re-deriving knowledge you've already accumulated.
if [ -f "$CONFIG_FILE" ]; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  if [ -n "$PORT" ]; then
    AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
    WORKING_MEM=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
      "http://localhost:${PORT}/context/working-memory?prompt=compaction-recovery&limit=5" 2>/dev/null)
    if [ -n "$WORKING_MEM" ]; then
      CONTEXT=$(echo "$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '')
    tokens = data.get('estimatedTokens', 0)
    if ctx and tokens > 0:
        print(f'[{tokens} tokens assembled from memory]')
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
      if [ -n "$CONTEXT" ]; then
        echo ""
        echo "--- WORKING MEMORY (relevant knowledge restored after compaction) ---"
        echo "$CONTEXT"
        echo "--- END WORKING MEMORY ---"
      fi
    fi
  fi
fi

# Phase H: Trigger server-side compaction-resume — third independent recovery path.
# Even if the SessionWatchdog poller and the PreCompact hook event handler are
# both unavailable for any reason, this hook ALWAYS runs after a real compaction,
# so it gives us a guaranteed signal. The server will check for unanswered user
# messages and re-inject them shortly after this hook completes.
if [ -f "$CONFIG_FILE" ] && command -v tmux >/dev/null 2>&1; then
  PORT=$(grep -o '"port":[0-9]*' "$CONFIG_FILE" | head -1 | cut -d':' -f2)
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
  if [ -n "$PORT" ] && [ -n "$TMUX_SESSION" ]; then
    AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('authToken',''))" 2>/dev/null)
    curl -s -m 2 -X POST \
      -H "Authorization: Bearer ${AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"sessionName\":\"${TMUX_SESSION}\"}" \
      "http://localhost:${PORT}/internal/compaction-resume" >/dev/null 2>&1 &
  fi
fi

echo ""
echo "=== RECOVERY COMPLETE — You are grounded. Continue your work. ==="
