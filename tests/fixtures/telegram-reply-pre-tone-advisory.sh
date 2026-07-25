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
#   printf '%s' '<base64 text>' | ./telegram-reply.sh --stdin-base64 TOPIC_ID
#
# Flags:
#   --format <mode>   Override server-side format mode for this send.
#                     Valid: plain, code, markdown, legacy-passthrough
#                     ('html' is reserved for trusted internal callers.)
#                     When absent, the server's configured default applies.
#   --stdin-base64    Decode stdin/argument text from base64 before sending.
#                     Use this for content that may contain shell syntax or
#                     heredoc delimiters such as a literal EOF line.
#   --ack-advisory    Acknowledge a preflight advisory and send the message
#                     unchanged. The preflight still runs (so the override is
#                     audited) but never withholds. FLAG ONLY — there is
#                     deliberately no env form (a standing env export would be
#                     a blanket pre-ack that silently disables the inform
#                     layer; spec outbound-jargon-filepath-gap §2.4(4)).
#
# Outbound advisory preflight (inform-only — spec outbound-jargon-filepath-gap §2.4):
#   When this send comes from an automated LLM job session (the scheduler
#   stamps INSTAR_MESSAGE_KIND=automated + INSTAR_SENDER_CLASS=llm-session
#   into the session env — the model types nothing), the script first asks
#   the server's deterministic detectors about the text. If they flag
#   something (raw file path, dev jargon, localhost link), the message is
#   NOT sent yet: the advisory prints to stdout (so the agent reads it in
#   its transcript) and the script exits 0. The agent then either fixes the
#   text and re-runs, or re-runs with --ack-advisory to send unchanged.
#   The advisory layer NEVER blocks: the ack path always delivers past it,
#   and every error path (server down, timeout, bad JSON) proceeds straight
#   to the send as if the preflight returned nothing. Script-class senders
#   (INSTAR_SENDER_CLASS=script) skip the preflight — there is no agent to
#   inform.
#
#   Every OTHER sender (including a conversational session with no stamps —
#   typically an interactive session running an autonomous job) also runs the
#   preflight, with its real message kind defaulting to "reply". The server
#   applies ONLY the TIME_CLAIM check to non-automated kinds — an
#   elapsed/remaining claim contradicting the topic's live session clock
#   (operator mandate 2026-06-12: accurate time reporting is structural, not
#   willpower). Jargon/path/link detectors never run for conversational
#   sends, and when the topic has no active time-boxed session the preflight
#   returns nothing — conversational sends remain effectively unaffected.
#   Same fail-open contract end-to-end.
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
STDIN_BASE64=0
ACK_ADVISORY=0

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
    --stdin-base64|--base64-stdin)
      STDIN_BASE64=1
      shift
      ;;
    --ack-advisory)
      ACK_ADVISORY=1
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

if [ "$STDIN_BASE64" = "1" ]; then
  DECODED_MSG=$(printf '%s' "$MSG" | python3 -c '
import base64, sys
raw = "".join(sys.stdin.read().split())
sys.stdout.write(base64.b64decode(raw, validate=True).decode("utf-8"))
' 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "Invalid base64 message provided to --stdin-base64" >&2
    exit 1
  fi
  MSG="$DECODED_MSG"
fi

# Resolve the owning agent home before reading config or recovery state.
# Explicit launcher context wins. Otherwise, ONLY the structural .worktrees
# marker may move us upward; a general config search could cross tenant roots
# on a multi-agent host. The ordinary agent-home cwd remains unchanged.
if [ -n "${INSTAR_AGENT_HOME:-}" ]; then
  AGENT_HOME="$INSTAR_AGENT_HOME"
else
  case "$PWD" in
    */.worktrees/*) AGENT_HOME="${PWD%%/.worktrees/*}" ;;
    *) AGENT_HOME="$PWD" ;;
  esac
fi
CONFIG_PATH="$AGENT_HOME/.instar/config.json"

# Resolve config-derived values from the owning agent's config (single python3
# invocation). Env > config > 4040-warn for port. Auth: INSTAR_AUTH_TOKEN env
# first (SessionManager injects it per spawned session; survives the
# secret-externalization refactor that moved authToken out of config.json into
# the encrypted store), legacy plaintext-config fallback with a string-type
# guard so the { "secret": true } placeholder produced by SecretMigrator
# cannot leak through as a bogus Bearer.
AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
AGENT_ID=""
CONFIG_PORT=""
if [ -f "$CONFIG_PATH" ]; then
  CONFIG_VALUES=$(python3 -c "
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
v = c.get('authToken', '')
print(v if isinstance(v, str) else '')
print(c.get('projectName', ''))
print(c.get('port', ''))
t = (((c.get('messaging') or {}).get('outboundAdvisory') or {}).get('timeoutMs', ''))
print(t if isinstance(t, (int, float)) else '')
" "$CONFIG_PATH" 2>/dev/null)
  CONFIG_AUTH=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '1p')
  [ -z "$AUTH_TOKEN" ] && AUTH_TOKEN="$CONFIG_AUTH"
  AGENT_ID=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '2p')
  CONFIG_PORT=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '3p')
  CONFIG_ADVISORY_TIMEOUT_MS=$(printf '%s\n' "$CONFIG_VALUES" | sed -n '4p')
fi

if [ -n "$INSTAR_PORT" ]; then
  PORT="$INSTAR_PORT"
elif [ -n "$CONFIG_PORT" ]; then
  PORT="$CONFIG_PORT"
else
  PORT=4040
  echo "WARN: telegram-reply.sh — no INSTAR_PORT env and no port in $CONFIG_PATH; falling back to 4040" >&2
fi

# ── Outbound advisory preflight (inform-only; spec outbound-jargon-filepath-gap §2.4) ──
# Validate the scheduler-stamped env values against the literal enums BEFORE
# use (an unexpected value forwards nothing — the server additionally coerces
# unknowns server-side).
MESSAGE_KIND=""
case "${INSTAR_MESSAGE_KIND:-}" in
  reply|health-alert|unknown|automated) MESSAGE_KIND="$INSTAR_MESSAGE_KIND" ;;
esac
SENDER_CLASS=""
case "${INSTAR_SENDER_CLASS:-}" in
  script|llm-session) SENDER_CLASS="$INSTAR_SENDER_CLASS" ;;
esac
# Job slug rides the metadata for server-side audit keying; charset-clamped
# here so it can never carry quotes/injection into a JSON or SQL context.
JOB_SLUG=$(printf '%s' "${INSTAR_JOB_SLUG:-}" | tr -c 'A-Za-z0-9._-' '_' | head -c 128)

ADVISORY_CODES_CSV=""
# Preflight gate: every sender EXCEPT script-class (no agent to inform).
# automated+llm-session → full detector set server-side (unchanged);
# anything else (incl. unstamped conversational sessions) → the server
# applies only the TIME_CLAIM clock check, kind defaulting to "reply".
# An older server returns no advisories for non-automated kinds — the new
# gate is a no-op against it (version-skew safe both directions).
if [ "$SENDER_CLASS" != "script" ]; then
  # Timeout: config messaging.outboundAdvisory.timeoutMs (default 2000ms),
  # converted ms→SECONDS for curl --max-time with ceil division, clamped to
  # [1, 10]. A raw `--max-time 2000` would be a ~33-minute fail-HANG and
  # `$((MS/1000))` on values <1000 would yield 0 = no timeout — both invert
  # the fail-open contract.
  ADV_MS="${CONFIG_ADVISORY_TIMEOUT_MS:-2000}"
  case "$ADV_MS" in (*[!0-9]*|'') ADV_MS=2000 ;; esac
  ADV_SECS=$(( (ADV_MS + 999) / 1000 ))
  [ "$ADV_SECS" -lt 1 ] && ADV_SECS=1
  [ "$ADV_SECS" -gt 10 ] && ADV_SECS=10

  # Preflight body via python3 (already a hard dependency of this script). If
  # python3 is unavailable the preflight is skipped entirely — fail-open.
  PREFLIGHT_BODY=$(PF_TOPIC="$TOPIC_ID" PF_SLUG="$JOB_SLUG" PF_KIND="${MESSAGE_KIND:-reply}" python3 -c '
import sys, json, os
print(json.dumps({
  "text": sys.stdin.read(),
  "messageKind": os.environ.get("PF_KIND") or "reply",
  "topicId": int(os.environ.get("PF_TOPIC") or 0),
  "jobSlug": os.environ.get("PF_SLUG", ""),
}))
' <<<"$MSG" 2>/dev/null)

  if [ -n "$PREFLIGHT_BODY" ]; then
    PREFLIGHT_CURL=(-s -X POST "http://localhost:${PORT}/messaging/preflight"
      -H 'Content-Type: application/json'
      --max-time "$ADV_SECS"
      -d "$PREFLIGHT_BODY")
    if [ -n "$AUTH_TOKEN" ]; then
      PREFLIGHT_CURL+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
    fi
    if [ -n "$AGENT_ID" ]; then
      PREFLIGHT_CURL+=(-H "X-Instar-AgentId: ${AGENT_ID}")
    fi
    PREFLIGHT_RESP=$(curl "${PREFLIGHT_CURL[@]}" 2>/dev/null)

    # Parse advisories — every failure mode (empty/timeout/malformed/disabled)
    # yields an empty result and the send proceeds (fail-OPEN end-to-end).
    ADVISORY_RENDERED=$(printf '%s' "$PREFLIGHT_RESP" | python3 -c '
import sys, json
try:
    resp = json.load(sys.stdin)
    advisories = resp.get("advisories") or []
except Exception:
    advisories = []
codes = ",".join(a.get("code", "") for a in advisories if isinstance(a, dict) and a.get("code"))
print(codes)
for a in advisories:
    if not isinstance(a, dict):
        continue
    print("- " + str(a.get("code", "")))
    m = a.get("match")
    if m:
        # Inert, delimited, quoted token under a fixed label — never spliced
        # into instruction-shaped prose (injection-pinned rendering).
        print("  detected: " + json.dumps(str(m)[:120]))
    g = a.get("guidance")
    if g:
        print("  guidance: " + str(g))
' 2>/dev/null)
    ADVISORY_CODES_CSV=$(printf '%s\n' "$ADVISORY_RENDERED" | sed -n '1p')
    ADVISORY_DETAIL=$(printf '%s\n' "$ADVISORY_RENDERED" | sed '1d')

    if [ -n "$ADVISORY_CODES_CSV" ] && [ "$ACK_ADVISORY" != "1" ]; then
      # Inform the sender BEFORE the user sees anything. The FIRST line is
      # machine-unmissable and literal (the E2E asserts this exact string).
      # Exit 0 is deliberate: non-zero means delivery failure and triggers
      # queue/retry semantics in callers; an advisory is neither — the message
      # was deliberately not yet sent and the next move belongs to the agent.
      echo "NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)"
      echo ""
      echo "The outbound advisory flagged this outbound message BEFORE delivery:"
      printf '%s\n' "$ADVISORY_DETAIL"
      echo ""
      echo "Next move (yours — the advisory layer never blocks):"
      echo "  1. FIX: revise the message and re-run this script (preferred)."
      echo "  2. SEND AS-IS: re-run with --ack-advisory to deliver unchanged (the override is audited)."
      exit 0
    fi
  fi
fi

# ── Serialized kind metadata — computed ONCE, shared by both body builders
# AND both queue writers (a queued send must carry the metadata whole so the
# sentinel redrive doesn't mis-kind it / drop an ack — spec §2.5). Every
# component is enum-validated or charset-clamped above, so this fragment is
# safe to interpolate into JSON and (parameterized) SQL contexts.
METADATA_JSON=""
if [ -n "$MESSAGE_KIND" ] || [ -n "$SENDER_CLASS" ] || [ -n "$JOB_SLUG" ] || { [ "$ACK_ADVISORY" = "1" ] && [ "$SENDER_CLASS" != "script" ]; }; then
  META_PARTS=""
  [ -n "$MESSAGE_KIND" ] && META_PARTS="\"messageKind\":\"${MESSAGE_KIND}\""
  if [ -n "$SENDER_CLASS" ]; then
    [ -n "$META_PARTS" ] && META_PARTS="${META_PARTS},"
    META_PARTS="${META_PARTS}\"senderClass\":\"${SENDER_CLASS}\""
  fi
  if [ -n "$JOB_SLUG" ]; then
    [ -n "$META_PARTS" ] && META_PARTS="${META_PARTS},"
    META_PARTS="${META_PARTS}\"jobSlug\":\"${JOB_SLUG}\""
  fi
  # Ack annotation rides for EVERY non-script sender (not just automated):
  # an unstamped interactive session's --ack-advisory must record 'acked'
  # server-side, or its advised episodes never resolve and the escalation
  # false-fires on messages that actually delivered (second-pass concern 2).
  if [ "$ACK_ADVISORY" = "1" ] && [ "$SENDER_CLASS" != "script" ]; then
    # REQUIRED annotation (§2.4(4)) — how the server audits "acked" as the
    # single writer. Carries the overridden codes, including [] for a
    # preemptive ack on a clean message (itself a signal).
    ACK_CODES_JSON=$(printf '%s' "$ADVISORY_CODES_CSV" | tr -cd 'A-Z_,' | awk -F',' '{out=""; for(i=1;i<=NF;i++){if($i!=""){out=out (out==""?"":",") "\""$i"\""}} print "["out"]"}')
    [ -z "$ACK_CODES_JSON" ] && ACK_CODES_JSON="[]"
    [ -n "$META_PARTS" ] && META_PARTS="${META_PARTS},"
    META_PARTS="${META_PARTS}\"advisoryAck\":true,\"advisoryCodes\":${ACK_CODES_JSON}"
  fi
  METADATA_JSON="{${META_PARTS}}"
fi

# Build JSON body (text + optional format + optional kind metadata). A
# conversational session (no kind env) produces the identical body it
# always did.
JSON_BODY=$(B_META="$METADATA_JSON" python3 -c '
import sys, json, os
msg = sys.argv[1]
fmt = sys.argv[2]
body = {"text": msg}
if fmt:
    body["format"] = fmt
meta_raw = os.environ.get("B_META", "")
if meta_raw:
    try:
        body["metadata"] = json.loads(meta_raw)
    except Exception:
        pass
print(json.dumps(body))
' "$MSG" "$FORMAT" 2>/dev/null)

if [ -z "$JSON_BODY" ]; then
  # Fallback if python3 not available: basic escape, no format override.
  # BOTH builders must carry the kind fields, or a python-degraded agent
  # silently drops them and the incident class recurs (spec §2.1).
  ESCAPED=$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')
  META_FIELD=""
  [ -n "$METADATA_JSON" ] && META_FIELD=",\"metadata\":${METADATA_JSON}"
  JSON_BODY="{\"text\":\"${ESCAPED}\"${META_FIELD}}"
fi

# ── delivery-id minted BEFORE the first POST (spec slack-outbound-robustness
# §2.6, round-3 C1) ──
# The id is sent as X-Instar-DeliveryId on the INITIAL send so the server
# records THIS id the moment the send lands. Every later redrive of a
# recoverable failure then reuses this exact id and is answered
# `idempotent:true` — closing the latent double-post window that minting at
# ENQUEUE time left open (the first send was permanently outside the id-ledger
# guarantee, so a redrive past the content-dedup window re-posted the message
# under an id the server had never seen). The enqueue below reuses this same
# DELIVERY_ID and ATTEMPTED_AT. A mint failure (python3 gone) degrades to
# today's headerless send — fail toward delivery, never a refused send.
DELIVERY_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)
ATTEMPTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Assemble curl args. Always include X-Instar-AgentId when we can resolve it
# from config — the server uses it to reject wrong-port requests before
# evaluating the token.
CURL_ARGS=(-s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/reply/${TOPIC_ID}"
  --connect-timeout 3
  --max-time 125
  -H 'Content-Type: application/json'
  -d "$JSON_BODY")
if [ -n "$AUTH_TOKEN" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
fi
if [ -n "$AGENT_ID" ]; then
  CURL_ARGS+=(-H "X-Instar-AgentId: ${AGENT_ID}")
fi
if [ -n "$DELIVERY_ID" ]; then
  CURL_ARGS+=(-H "X-Instar-DeliveryId: ${DELIVERY_ID}")
fi

RESPONSE=$(curl "${CURL_ARGS[@]}")
CURL_STATUS=$?

# A transport failure after request start is inherently ambiguous: the server
# may still finish its tone review or Telegram send after our bounded client
# window closes. Always render a terminal outcome so a yielded/reattached tool
# call cannot complete silently, and never auto-enqueue/retry an unknown send.
if [ "$CURL_STATUS" -ne 0 ]; then
  echo "AMBIGUOUS: Telegram relay transport ended without an HTTP outcome (curl ${CURL_STATUS})." >&2
  echo "  The message MAY still be delivered. Do NOT retry blindly; verify the conversation first." >&2
  [ -n "$DELIVERY_ID" ] && echo "  Delivery id: ${DELIVERY_ID}" >&2
  echo "AMBIGUOUS: no HTTP outcome — verify delivery before retrying"
  exit 0
fi

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
  #   - 409 with structured `delivery-in-flight` (R8-M1 Arm C — the reservation
  #     race; NON-LOSING, redriven under the same pre-minted id)
  # NOT recoverable here (already handled above or terminal):
  #   - 200 (success), 408 (ambiguous), 422 (tone gate)
  #   - 400, 403/revoked, 403 unstructured, 409 unstructured
  RECOVERABLE=0
  if [ "$HTTP_CODE" = "000" ] || \
     ( [ "$HTTP_CODE" -ge 500 ] 2>/dev/null && [ "$HTTP_CODE" -le 599 ] 2>/dev/null ); then
    RECOVERABLE=1
  elif [ "$HTTP_CODE" = "409" ]; then
    # 409 delivery-in-flight (spec R8-M1 Arm C): the server's §2.4 single-flight
    # reservation saw a concurrent POST for THIS delivery-id still in flight.
    # This is NON-LOSING, never terminal — enqueue under the SAME pre-minted id
    # so the sentinel redrives; by then the first call has resolved (recorded →
    # idempotent, or failed → retryable). recovery-policy classifies structured
    # 409 delivery-in-flight as retry (Arm A). An UNSTRUCTURED 409 is terminal
    # (default-deny) exactly like an unstructured 4xx.
    IN_FLIGHT_CODE=$(echo "$BODY" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin).get("error",""))
except Exception:
  print("")' 2>/dev/null)
    if [ "$IN_FLIGHT_CODE" = "delivery-in-flight" ]; then
      RECOVERABLE=1
    else
      RECOVERABLE=0
    fi
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
    # Sanitize agent-id for filename (mirrors src/messaging/pending-relay-store.ts).
    SAFE_AGENT_ID=$(printf '%s' "${AGENT_ID:-unknown}" | tr -c 'A-Za-z0-9._-' '_')
    if [ "$SAFE_AGENT_ID" = "unknown" ]; then
      echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
      echo "  (also: agent id is unknown; refusing to create an undrainable pending-relay.unknown.sqlite store)" >&2
      exit 1
    fi
    QUEUE_DIR="$AGENT_HOME/.instar/state"
    mkdir -p "$QUEUE_DIR" 2>/dev/null
    QUEUE_DB="${QUEUE_DIR}/pending-relay.${SAFE_AGENT_ID}.sqlite"

    # delivery_id — the id was minted BEFORE the initial POST and sent on it
    # (spec §2.6 round-3 C1); the enqueue reuses that exact id so a redrive of
    # THIS row is answered idempotent:true by the server that already recorded
    # it. If the pre-POST mint failed (python3 unavailable), the initial send
    # went out headerless — the server never recorded an id, so there is
    # nothing to make the redrive idempotent; skip the enqueue with the loud
    # note (fail toward loudness, exactly today's degraded behavior).
    if [ -z "$DELIVERY_ID" ]; then
      echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
      echo "  (also: no delivery_id was minted pre-POST; queue write skipped)" >&2
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

    # ATTEMPTED_AT was stamped at the PRE-POST mint (spec §2.6 round-5 m3): the
    # 25h-ledger > 24h-row-TTL margin holds only if both clocks anchor at the
    # send, so the enqueue reuses the mint-time stamp rather than re-stamping
    # `now` (which a wedged/slept script would push arbitrarily late).
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
      Q_METADATA="$METADATA_JSON" \
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
      truncated INTEGER NOT NULL DEFAULT 0,
      message_metadata TEXT
    )""")
    # Idempotent column add for older schemas.
    try:
        conn.execute("ALTER TABLE entries ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError as e:
        if "duplicate column name" not in str(e):
            raise
    # message_metadata (kind/senderClass/advisoryAck) — the redrive must carry
    # the metadata whole (spec outbound-jargon-filepath-gap §2.5). Idempotent.
    try:
        conn.execute("ALTER TABLE entries ADD COLUMN message_metadata TEXT")
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
          state, claimed_by, status_history, truncated, message_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, "queued", NULL, ?, ?, ?)""",
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
            os.environ.get("Q_METADATA") or None,
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
      # message_metadata rides via a temp file + readfile (same pattern as the
      # text BLOB) so no shell value is ever interpolated into SQL — the
      # metadata is enum-built, but the no-raw-interpolation rule holds anyway
      # (spec outbound-jargon-filepath-gap §2.5).
      META_SQL_VALUE="NULL"
      if [ -n "$METADATA_JSON" ]; then
        printf '%s' "$METADATA_JSON" > "${QUEUE_DB}.tmp.meta"
        META_SQL_VALUE="CAST(readfile('${QUEUE_DB}.tmp.meta') AS TEXT)"
      fi
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
  truncated INTEGER NOT NULL DEFAULT 0,
  message_metadata TEXT
);
ALTER TABLE entries ADD COLUMN message_metadata TEXT;
CREATE INDEX IF NOT EXISTS idx_state_next ON entries(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_text_hash_topic ON entries(text_hash, topic_id);
INSERT OR IGNORE INTO entries (
  delivery_id, topic_id, text_hash, text, format,
  http_code, error_body, attempted_port, attempted_at,
  attempts, state, status_history, truncated, message_metadata
) VALUES (
  '$DELIVERY_ID', $TOPIC_ID, '$TEXT_HASH',
  CAST(readfile('${QUEUE_DB}.tmp.text') AS BLOB), $( [ -n "$FORMAT" ] && printf "'%s'" "$FORMAT" || echo "NULL"),
  $HTTP_CODE, NULL, $PORT, '$ATTEMPTED_AT',
  1, 'queued', '[]', $TRUNCATED, $META_SQL_VALUE
);
SQL
      rm -f "${QUEUE_DB}.tmp.text" "${QUEUE_DB}.tmp.meta" 2>/dev/null
      chmod 600 "$QUEUE_DB" 2>/dev/null
    fi

    # A zero exit from a writer is not durable evidence. Re-open the canonical
    # DB and prove this exact pre-minted delivery_id exists before claiming the
    # message is queued. This closes the historical false-success path where a
    # failed/partial writer left a zero-byte file and the script still printed
    # "Queued for recovery".
    QUEUE_PERSISTED=$(Q_DB_PATH="$QUEUE_DB" Q_DELIVERY_ID="$DELIVERY_ID" \
      Q_TOPIC_ID="$TOPIC_ID" Q_TEXT_HASH="$TEXT_HASH" python3 -c '
import os, sqlite3
try:
    conn = sqlite3.connect("file:" + os.environ["Q_DB_PATH"] + "?mode=ro", uri=True, timeout=2.0)
    row = conn.execute(
        "SELECT 1 FROM entries WHERE delivery_id=? AND topic_id=? AND text_hash=? AND state=? LIMIT 1",
        (os.environ["Q_DELIVERY_ID"], int(os.environ["Q_TOPIC_ID"]), os.environ["Q_TEXT_HASH"], "queued"),
    ).fetchone()
    conn.close()
    print("1" if row else "0")
except Exception:
    print("0")
' 2>/dev/null)
    if [ "$QUEUE_PERSISTED" != "1" ]; then
      echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
      echo "  (also: recovery queue persistence could not be verified; message was NOT reported as queued)" >&2
      exit 1
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
