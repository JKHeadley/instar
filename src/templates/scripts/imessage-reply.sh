#!/bin/bash
# imessage-reply.sh — Send a reply via iMessage with validate-before-send safety.
#
# Usage:
#   ./imessage-reply.sh RECIPIENT "message text"
#   echo "message text" | ./imessage-reply.sh RECIPIENT
#   cat <<'EOF' | ./imessage-reply.sh RECIPIENT
#   Multi-line message here
#   EOF
#
# RECIPIENT is a phone number (+14081234567) or email (user@icloud.com).
#
# This script implements Layer 1 of the 5-layer outbound safety defense:
#   1. Validates recipient with server BEFORE sending (gets single-use token)
#   2. Sends the iMessage via `imsg send` CLI (requires Automation permission)
#   3. Confirms delivery to server with token (for logging + stall tracking)
#
# If validation fails, the message is NOT sent. This is the reverse of the
# original flow which sent first and notified second.

# imessage-reply-feature: tone-reaction
# Answering a 422 tone-gate-advisory. Flags go BEFORE everything else:
#   --tone-complied <RULE>     You agreed and revised the text.
#   --tone-ack <RULE>          You disagree and send unchanged; needs --tone-reason.
#   --tone-reason "<why>"      Why the nudge is wrong here.
#   --tone-decision-ref <REF>  The decisionRef from the 422.
TONE_ACK=""; TONE_REASON=""; TONE_COMPLIED=""; TONE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tone-ack|--tone-reason|--tone-complied|--tone-decision-ref)
      [ $# -ge 2 ] || { echo "Error: $1 needs a value" >&2; exit 1; }
      case "$1" in
        --tone-ack) TONE_ACK="$2" ;;
        --tone-reason) TONE_REASON="$2" ;;
        --tone-complied) TONE_COMPLIED="$2" ;;
        --tone-decision-ref) TONE_REF="$2" ;;
      esac
      shift 2 ;;
    *) break ;;
  esac
done
# Rule ids are charset-clamped and a decision ref must have the router's shape, so nothing
# shell- or JSON-hostile rides the metadata. Empty when no reaction was given.
TONE_META=$(TONE_ACK="$TONE_ACK" TONE_REASON="$TONE_REASON" TONE_COMPLIED="$TONE_COMPLIED" TONE_REF="$TONE_REF" python3 -c '
import json, os, re
clamp = lambda v: re.sub(r"[^A-Z0-9_]", "", v)[:64]
m = {}
if os.environ["TONE_ACK"]:
    m["toneAdvisoryAck"] = clamp(os.environ["TONE_ACK"])
    if os.environ["TONE_REASON"]:
        m["toneAdvisoryAckReason"] = os.environ["TONE_REASON"][:500]
if os.environ["TONE_COMPLIED"]:
    m["toneAdvisoryComplied"] = clamp(os.environ["TONE_COMPLIED"])
ref = os.environ["TONE_REF"]
if len(ref) <= 128 and re.fullmatch(r"[db]-(?:[A-Za-z0-9_]{1,64}-)?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", ref):
    m["toneAdvisoryDecisionRef"] = ref
print(json.dumps(m) if m else "")
' 2>/dev/null || true)

RECIPIENT="$1"
shift

if [ -z "$RECIPIENT" ]; then
  echo "Usage: imessage-reply.sh RECIPIENT [message]" >&2
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

# ── Setup ─────────────────────────────────────────────────────────────

PORT="${INSTAR_PORT:-4042}"

# Auth: env first (SessionManager injects it per spawned session and it
# survives secret-externalization), legacy plaintext-config fallback with
# string-type guard so the { "secret": true } placeholder produced by
# SecretMigrator cannot leak through as a bogus Bearer.
AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
AGENT_ID="${INSTAR_AGENT_ID:-}"
if [ -z "$AUTH_TOKEN" ] && [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
fi
if [ -z "$AGENT_ID" ] && [ -f ".instar/config.json" ]; then
  AGENT_ID=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)
fi

# Escape message for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
fi

# URL-encode the recipient
ENCODED_RECIPIENT=$(printf '%s' "$RECIPIENT" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))' 2>/dev/null)
if [ -z "$ENCODED_RECIPIENT" ]; then
  ENCODED_RECIPIENT="$RECIPIENT"
fi

AUTH_HEADER=""
if [ -n "$AUTH_TOKEN" ]; then
  AUTH_HEADER="Authorization: Bearer ${AUTH_TOKEN}"
fi
AGENT_HEADER=""
if [ -n "$AGENT_ID" ]; then
  AGENT_HEADER="X-Instar-AgentId: ${AGENT_ID}"
fi

# ── Step 1: Validate with server BEFORE sending (get single-use token) ──

VALIDATE_JSON="{\"text\":${JSON_MSG}}"
[ -z "$TONE_META" ] || VALIDATE_JSON="{\"text\":${JSON_MSG},\"metadata\":${TONE_META}}"

VALIDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "http://localhost:${PORT}/imessage/validate-send/${ENCODED_RECIPIENT}" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  ${AGENT_HEADER:+-H "$AGENT_HEADER"} \
  -H 'Content-Type: application/json' \
  -d "$VALIDATE_JSON" 2>/dev/null)

VALIDATE_BODY=$(echo "$VALIDATE_RESPONSE" | sed '$d')
VALIDATE_CODE=$(echo "$VALIDATE_RESPONSE" | tail -n 1)

if [ "$VALIDATE_CODE" != "200" ]; then
  # Validation failed — DO NOT SEND.
  # Body may be either:
  #   { "reason": "..." }  from validateSend (authz, rate limits, TOCTOU)
  #   { "issue": "...", "suggestion": "..." }  from the tone gate
  REASON=$(echo "$VALIDATE_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("reason") or d.get("issue") or "unknown")' 2>/dev/null || echo "unknown")
  SUGGESTION=$(echo "$VALIDATE_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))' 2>/dev/null || echo "")
  if [ "$VALIDATE_CODE" = "422" ]; then
    TONE_NUDGE=$(printf '%s' "$VALIDATE_BODY" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
kind = d.get("blockedBy") or d.get("error")
rule = d.get("rule") or "RULE"
ref = d.get("decisionRef") or ""
tail = (" --tone-decision-ref " + ref) if ref else ""
if kind == "tone-gate-advisory":
    print("ADVISORY: not sent yet, and the decision is yours (a nudge, not a wall).")
    print("  Rule: " + rule)
    print("  Issue: " + str(d.get("issue", "unknown")))
    if d.get("suggestion"):
        print("  Suggestion: " + str(d["suggestion"]))
    if ref:
        print("  decisionRef: " + ref)
    print("  AGREE: revise, then re-run with: --tone-complied " + rule + tail)
    print("  DISAGREE: re-run unchanged with: --tone-ack " + rule + " --tone-reason \"why the nudge is wrong here\"" + tail)
elif kind == "tone-gate-advisory-reason-required":
    print("NOT SENT: an override needs a reason.")
    print("  Re-run with: --tone-ack " + rule + " --tone-reason \"why the nudge is wrong here\"")
' 2>/dev/null || true)
    if [ -n "$TONE_NUDGE" ]; then
      printf '%s\n' "$TONE_NUDGE" >&2
      exit 1
    fi
    echo "BLOCKED by tone gate — message not sent to user." >&2
    echo "  Issue: $REASON" >&2
    if [ -n "$SUGGESTION" ]; then
      echo "  Suggestion: $SUGGESTION" >&2
    fi
    echo "  Revise the message (remove CLI commands, file paths, config syntax, API endpoints) and retry." >&2
  else
    echo "BLOCKED: $REASON" >&2
  fi

  # Log blocked attempt locally as backup
  echo "{\"blocked\":true,\"recipient\":\"${RECIPIENT}\",\"reason\":\"${REASON}\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> .instar/imessage-outbound-local.jsonl 2>/dev/null

  exit 1
fi

# Extract send token
SEND_TOKEN=$(echo "$VALIDATE_BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)

if [ -z "$SEND_TOKEN" ]; then
  echo "BLOCKED: no send token received from server" >&2
  exit 1
fi

# ── Step 2: Send via imsg CLI (only after validation passes) ──────────

IMSG="${IMSG_PATH:-imsg}"
if ! command -v "$IMSG" &>/dev/null; then
  for candidate in /opt/homebrew/bin/imsg /usr/local/bin/imsg "$HOME/homebrew/bin/imsg"; do
    if [ -x "$candidate" ]; then
      IMSG="$candidate"
      break
    fi
  done
fi

if ! command -v "$IMSG" &>/dev/null && [ ! -x "$IMSG" ]; then
  echo "imsg not found. Install: brew install steipete/tap/imsg" >&2
  exit 1
fi

"$IMSG" send --to "$RECIPIENT" --text "$MSG" --service imessage 2>/dev/null
SEND_STATUS=$?

if [ $SEND_STATUS -ne 0 ]; then
  echo "imsg send failed (exit $SEND_STATUS)" >&2
  exit 1
fi

# ── Step 3: Confirm delivery to server (with token to bind validate→send) ──

curl -s -o /dev/null -w "" -X POST "http://localhost:${PORT}/imessage/reply/${ENCODED_RECIPIENT}" \
  ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
  ${AGENT_HEADER:+-H "$AGENT_HEADER"} \
  -H 'Content-Type: application/json' \
  -d "{\"text\":${JSON_MSG},\"sendToken\":\"${SEND_TOKEN}\"}" 2>/dev/null || \
  echo "Warning: server confirmation failed (message was sent)" >&2

echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $RECIPIENT"
