#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   ./telegram-reply.sh TOPIC_ID "message text"
#   ./telegram-reply.sh --format markdown TOPIC_ID "**bold**"
#   echo "message text" | ./telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | ./telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF
#
# Flags:
#   --format <mode>   Override server-side format mode for this send.
#                     Valid: plain, code, markdown, legacy-passthrough
#                     ('html' is reserved for trusted internal callers.)
#                     When absent, the server's configured default applies.
#
# Port resolution (in order):
#   1. INSTAR_PORT environment variable (explicit operator override).
#   2. `port` field in .instar/config.json (the canonical agent-local truth).
#   3. Hardcoded fallback to 4040, with a stderr warning. This is the path
#      that historically caused cross-tenant misroutes on multi-agent hosts.
#
# Auth:
#   Sends `Authorization: Bearer <authToken>` AND `X-Instar-AgentId: <projectName>`
#   (both read from .instar/config.json). The agent-id header lets the server
#   reject auth-bearing requests that hit the wrong agent's port BEFORE token
#   comparison — a token sent to the wrong server is structurally inert.

FORMAT=""

# Parse leading flags before positional args.
while [ $# -gt 0 ]; do
  case "$1" in
    --format)
      FORMAT="$2"
      shift 2
      ;;
    --format=*)
      FORMAT="${1#--format=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

TOPIC_ID="$1"
shift

if [ -z "$TOPIC_ID" ]; then
  echo "Usage: telegram-reply.sh [--format MODE] TOPIC_ID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

# Resolve config-derived values from .instar/config.json (single python3
# invocation). Env > config > 4040-warn for port; config-only for authToken
# and agentId.
AUTH_TOKEN=""
AGENT_ID=""
CONFIG_PORT=""
if [ -f ".instar/config.json" ]; then
  CONFIG_VALUES=$(python3 -c "
import json, sys
try:
    c = json.load(open('.instar/config.json'))
except Exception:
    sys.exit(0)
print(c.get('authToken', ''))
print(c.get('projectName', ''))
print(c.get('port', ''))
" 2>/dev/null)
  AUTH_TOKEN=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '1p')
  AGENT_ID=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '2p')
  CONFIG_PORT=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '3p')
fi

if [ -n "$INSTAR_PORT" ]; then
  PORT="$INSTAR_PORT"
elif [ -n "$CONFIG_PORT" ]; then
  PORT="$CONFIG_PORT"
else
  PORT=4040
  echo "WARN: telegram-reply.sh — no INSTAR_PORT env and no port in .instar/config.json; falling back to 4040" >&2
fi

# Build JSON body (text + optional format).
JSON_BODY=$(python3 -c '
import sys, json
msg = sys.argv[1]
fmt = sys.argv[2]
body = {"text": msg}
if fmt:
    body["format"] = fmt
print(json.dumps(body))
' "$MSG" "$FORMAT" 2>/dev/null)

if [ -z "$JSON_BODY" ]; then
  # Fallback if python3 not available: basic escape, no format override.
  ESCAPED=$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')
  JSON_BODY="{\"text\":\"${ESCAPED}\"}"
fi

# Assemble curl args. Always include X-Instar-AgentId when we can resolve it
# from config — the server uses it to reject wrong-port requests before
# evaluating the token.
CURL_ARGS=(-s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/reply/${TOPIC_ID}"
  -H 'Content-Type: application/json'
  -d "$JSON_BODY")
if [ -n "$AUTH_TOKEN" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi
if [ -n "$AGENT_ID" ]; then
  CURL_ARGS+=(-H "X-Instar-AgentId: ${AGENT_ID}")
fi

RESPONSE=$(curl "${CURL_ARGS[@]}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + Telegram API)
  # exceeded the route's budget. The actual send may have completed anyway, because
  # the handler's async work continues after the middleware fires 408. Treating this
  # as a hard failure (exit 1) causes the agent to regenerate and retry, which
  # double-sends the message. Instead report the outcome as AMBIGUOUS and exit 0 —
  # the agent should check the conversation before retrying.
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the conversation to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
elif [ "$HTTP_CODE" = "422" ]; then
  # Tone gate blocked the message — surface the issue + suggestion to the agent
  ISSUE=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("issue","unknown"))' 2>/dev/null || echo "unknown")
  SUGGESTION=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))' 2>/dev/null || echo "")
  echo "BLOCKED by tone gate — message not sent to user." >&2
  echo "  Issue: $ISSUE" >&2
  if [ -n "$SUGGESTION" ]; then
    echo "  Suggestion: $SUGGESTION" >&2
  fi
  echo "  Revise the message (remove CLI commands, file paths, config syntax, API endpoints) and retry." >&2
  exit 1
else
  # Recoverable-class detection (spec § Layer 2b).
  #
  # The classification table below is the entire decision matrix. Codes
  # marked recoverable get enqueued in the per-agent SQLite queue and a
  # best-effort POST /events/delivery-failed is sent so the in-process
  # Layer 3 sentinel can react in <1s. Anything not in the recoverable
  # set is terminal (default-deny on unknown 403s, per spec round-2
  # resolution).
  #
  # Recoverable:
  #   - 5xx, conn-refused (HTTP_CODE=000), DNS failure (also 000)
  #   - 403 with structured `agent_id_mismatch`
  #   - 403 with structured `rate_limited` (sentinel honors Retry-After)
  # NOT recoverable here (already handled above or terminal):
  #   - 200 (success), 408 (ambiguous), 422 (tone gate)
  #   - 400, 403/revoked, 403 unstructured
  RECOVERABLE=0
  if [ "$HTTP_CODE" = "000" ] || \
     ( [ "$HTTP_CODE" -ge 500 ] 2>/dev/null && [ "$HTTP_CODE" -le 599 ] 2>/dev/null ); then
    RECOVERABLE=1
  elif [ "$HTTP_CODE" = "403" ]; then
    # Inspect the structured error code in the body. Unstructured 403 is
    # default-deny per spec § 2b.
    ERROR_CODE=$(echo "$BODY" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin).get("error",""))
except Exception:
  print("")' 2>/dev/null)
    case "$ERROR_CODE" in
      agent_id_mismatch|rate_limited)
        RECOVERABLE=1
        ;;
      *)
        RECOVERABLE=0
        ;;
    esac
  fi

  if [ "$RECOVERABLE" = "1" ]; then
    # Enqueue (spec § Layer 2b). Path: <stateDir>/state/pending-relay.<agentId>.sqlite
    # Mode 0600 enforced by the Node-side store; the CLI inherits umask, so
    # we explicitly chmod after first create as well.
    QUEUE_DIR=".instar/state"
    mkdir -p "$QUEUE_DIR" 2>/dev/null
    # Sanitize agent-id for filename (mirrors src/messaging/pending-relay-store.ts).
    SAFE_AGENT_ID=$(printf '%s' "${AGENT_ID:-unknown}" | tr -c 'A-Za-z0-9._-' '_')
    QUEUE_DB="${QUEUE_DIR}/pending-relay.${SAFE_AGENT_ID}.sqlite"

    # delivery_id — UUIDv4 via python3 (already a hard dep above).
    DELIVERY_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)
    if [ -z "$DELIVERY_ID" ]; then
      echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
      echo "  (also: failed to generate delivery_id; queue write skipped)" >&2
      exit 1
    fi

    # text_hash — SHA-256 of the raw text. Whitespace normalization is the
    # job of higher layers; for dedup-window we just need byte-stable hashing.
    TEXT_HASH=$(printf '%s' "$MSG" | shasum -a 256 2>/dev/null | awk '{print $1}')
    if [ -z "$TEXT_HASH" ]; then
      TEXT_HASH=$(printf '%s' "$MSG" | python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())' 2>/dev/null)
    fi

    # 32KB text cap (spec § 2b step 3).
    MSG_BYTES=$(printf '%s' "$MSG" | wc -c | tr -d ' ')
    TRUNCATED=0
    QUEUE_TEXT="$MSG"
    if [ "$MSG_BYTES" -gt 32768 ] 2>/dev/null; then
      QUEUE_TEXT=$(printf '%s' "$MSG" | head -c 32768)
      TRUNCATED=1
    fi

    ATTEMPTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    NOW_EPOCH=$(date -u +%s)

    # Run the queue write through python3's stdlib sqlite3 module — it
    # owns schema creation, the 5s dedup window, parameterized inserts,
    # and 0600-mode enforcement. python3 is already a hard dependency
    # of this script (see config-parsing block above) and Python's
    # stdlib sqlite3 module is universally available — more so than
    # the `sqlite3` CLI binary or a node module that requires resolution
    # against an installed `instar` package's node_modules. The DB file
    # produced is byte-identical to one produced by `better-sqlite3`
    # (same SQLite engine on disk).
    #
    # We pass values via environment variables; the message text comes
    # via stdin so it's never escaped through a shell layer.
    # Env vars must be set on `python3` (the consumer of stdin), not on
    # `printf` — in `VAR=x cmd1 | cmd2`, VAR is exported only to cmd1.
    printf '%s' "$QUEUE_TEXT" | \
      Q_DELIVERY_ID="$DELIVERY_ID" \
      Q_TOPIC_ID="$TOPIC_ID" \
      Q_TEXT_HASH="$TEXT_HASH" \
      Q_FORMAT="$FORMAT" \
      Q_HTTP_CODE="$HTTP_CODE" \
      Q_ERROR_BODY="$BODY" \
      Q_PORT="$PORT" \
      Q_ATTEMPTED_AT="$ATTEMPTED_AT" \
      Q_TRUNCATED="$TRUNCATED" \
      Q_DB_PATH="$QUEUE_DB" \
      python3 -c '
import os, sqlite3, sys, json, datetime
try:
    db_path = os.environ["Q_DB_PATH"]
    text = sys.stdin.buffer.read()
    conn = sqlite3.connect(db_path, timeout=5.0)
    try:
        os.chmod(db_path, 0o600)
    except OSError:
        pass
    # Drain pragma result rows so they do not leak to stdout. Stdout is
    # used to communicate the delivery_id back to the calling shell.
    conn.execute("PRAGMA journal_mode = WAL").fetchall()
    conn.execute("PRAGMA synchronous = NORMAL").fetchall()
    conn.execute("PRAGMA busy_timeout = 5000").fetchall()
    conn.execute("""CREATE TABLE IF NOT EXISTS entries (
      delivery_id TEXT PRIMARY KEY,
      topic_id INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      text BLOB NOT NULL,
      format TEXT,
      http_code INTEGER,
      error_body TEXT,
      attempted_port INTEGER,
      attempted_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      next_attempt_at TEXT,
      state TEXT NOT NULL,
      claimed_by TEXT,
      status_history TEXT NOT NULL DEFAULT "[]",
      truncated INTEGER NOT NULL DEFAULT 0
    )""")
    # Idempotent column add for older schemas.
    try:
        conn.execute("ALTER TABLE entries ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError as e:
        if "duplicate column name" not in str(e):
            raise
    conn.execute("CREATE INDEX IF NOT EXISTS idx_state_next ON entries(state, next_attempt_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_text_hash_topic ON entries(text_hash, topic_id)")
    # 5s dedup window (spec § 2b step 2).
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    cur = conn.execute(
        "SELECT delivery_id FROM entries WHERE topic_id=? AND text_hash=? AND attempted_at>=? ORDER BY attempted_at DESC LIMIT 1",
        (int(os.environ["Q_TOPIC_ID"]), os.environ["Q_TEXT_HASH"], cutoff),
    )
    dup = cur.fetchone()
    if dup:
        # Dedup match — caller already has the delivery_id. We do not
        # write to stdout (caller does not consume our output; bash uses
        # its own DELIVERY_ID variable).
        conn.close()
        sys.exit(0)
    initial_history = json.dumps([
        {"state": "queued", "at": os.environ["Q_ATTEMPTED_AT"], "http_code": int(os.environ["Q_HTTP_CODE"])}
    ])
    conn.execute(
        """INSERT OR IGNORE INTO entries (
          delivery_id, topic_id, text_hash, text, format,
          http_code, error_body, attempted_port,
          attempted_at, attempts, next_attempt_at,
          state, claimed_by, status_history, truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, "queued", NULL, ?, ?)""",
        (
            os.environ["Q_DELIVERY_ID"],
            int(os.environ["Q_TOPIC_ID"]),
            os.environ["Q_TEXT_HASH"],
            text,
            os.environ.get("Q_FORMAT") or None,
            int(os.environ["Q_HTTP_CODE"]),
            os.environ.get("Q_ERROR_BODY") or None,
            int(os.environ["Q_PORT"]),
            os.environ["Q_ATTEMPTED_AT"],
            initial_history,
            int(os.environ.get("Q_TRUNCATED", "0")),
        ),
    )
    conn.commit()
    conn.close()
    # Deliberately silent on success — bash consumed nothing from our stdout.
except Exception as exc:
    sys.stderr.write("queue-write-failed: " + str(exc) + "\n")
    sys.exit(2)
' >/dev/null 2>&1
    QUEUE_RC=$?
    if [ "$QUEUE_RC" != "0" ] && command -v sqlite3 >/dev/null 2>&1; then
      # Fallback: sqlite3 CLI direct write. Used only when python3's
      # stdlib sqlite3 module is somehow unavailable (rare — e.g. a
      # build of CPython compiled --without-sqlite). Schema is created
      # with IF NOT EXISTS so this is safe even if the Python path
      # partially ran.
      printf '%s' "$QUEUE_TEXT" > "${QUEUE_DB}.tmp.text"
      sqlite3 "$QUEUE_DB" >/dev/null 2>&1 <<SQL
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS entries (
  delivery_id TEXT PRIMARY KEY,
  topic_id INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  text BLOB NOT NULL,
  format TEXT,
  http_code INTEGER,
  error_body TEXT,
  attempted_port INTEGER,
  attempted_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  state TEXT NOT NULL,
  claimed_by TEXT,
  status_history TEXT NOT NULL DEFAULT '[]',
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_state_next ON entries(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_text_hash_topic ON entries(text_hash, topic_id);
INSERT OR IGNORE INTO entries (
  delivery_id, topic_id, text_hash, text, format,
  http_code, error_body, attempted_port, attempted_at,
  attempts, state, status_history, truncated
) VALUES (
  '$DELIVERY_ID', $TOPIC_ID, '$TEXT_HASH',
  CAST(readfile('${QUEUE_DB}.tmp.text') AS BLOB), $( [ -n "$FORMAT" ] && printf "'%s'" "$FORMAT" || echo "NULL"),
  $HTTP_CODE, NULL, $PORT, '$ATTEMPTED_AT',
  1, 'queued', '[]', $TRUNCATED
);
SQL
      rm -f "${QUEUE_DB}.tmp.text" 2>/dev/null
      chmod 600 "$QUEUE_DB" 2>/dev/null
    fi

    # Best-effort POST /events/delivery-failed to the SAME port the
    # original send used (NOT the live config port — see spec § Layer 2c
    # cross-tenant safety).
    EVENT_BODY=$(EV_DELIVERY_ID="$DELIVERY_ID" \
      EV_TOPIC_ID="$TOPIC_ID" \
      EV_TEXT_HASH="$TEXT_HASH" \
      EV_HTTP_CODE="$HTTP_CODE" \
      EV_ERROR_BODY="$BODY" \
      EV_PORT="$PORT" \
      python3 -c '
import sys, json, os
print(json.dumps({
  "delivery_id": os.environ["EV_DELIVERY_ID"],
  "topic_id": int(os.environ["EV_TOPIC_ID"]),
  "text_hash": os.environ["EV_TEXT_HASH"],
  "http_code": int(os.environ["EV_HTTP_CODE"]),
  "error_body": (os.environ.get("EV_ERROR_BODY") or "")[:1024],
  "attempted_port": int(os.environ["EV_PORT"]),
  "attempts": 1,
}))
' 2>/dev/null)

    if [ -n "$EVENT_BODY" ] && [ -n "$AUTH_TOKEN" ]; then
      EVENT_CURL=(-s -o /dev/null -w "%{http_code}" -X POST "http://localhost:${PORT}/events/delivery-failed"
        -H 'Content-Type: application/json'
        -H "Authorization: Bearer ${AUTH_TOKEN}"
        --max-time 2
        -d "$EVENT_BODY")
      if [ -n "$AGENT_ID" ]; then
        EVENT_CURL+=(-H "X-Instar-AgentId: ${AGENT_ID}")
      fi
      curl "${EVENT_CURL[@]}" >/dev/null 2>&1 || true
    fi

    echo "Queued for recovery (HTTP $HTTP_CODE, delivery_id ${DELIVERY_ID%%-*}…): $BODY" >&2
    exit 1
  fi

  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
