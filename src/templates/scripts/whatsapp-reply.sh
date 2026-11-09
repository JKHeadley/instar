#!/bin/bash
# whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server.
#
# Usage:
#   ./whatsapp-reply.sh JID "message text"
#   echo "message text" | ./whatsapp-reply.sh JID
#   cat <<'EOF' | ./whatsapp-reply.sh JID
#   Multi-line message here
#   EOF
#
# JID format: phone@s.whatsapp.net (e.g., 12345678901@s.whatsapp.net)
# Reads INSTAR_PORT from environment (default: 4040).

# whatsapp-reply-feature: tone-reaction
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

JID="$1"
shift

if [ -z "$JID" ]; then
  echo "Usage: whatsapp-reply.sh JID [message]" >&2
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

PORT="${INSTAR_PORT:-4040}"

# Read auth token: env first (SessionManager injects it per spawned session and
# it survives secret-externalization), legacy plaintext-config fallback with
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

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  # Fallback if python3 not available: basic escape
  JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
fi

BODY_JSON="{\"text\":${JSON_MSG}}"
[ -z "$TONE_META" ] || BODY_JSON="{\"text\":${JSON_MSG},\"metadata\":${TONE_META}}"

if [ -n "$AUTH_TOKEN" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/whatsapp/send/${JID}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "X-Instar-AgentId: ${AGENT_ID}" \
    -d "$BODY_JSON")
else
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/whatsapp/send/${JID}" \
    -H 'Content-Type: application/json' \
    -d "$BODY_JSON")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $JID"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + WhatsApp API)
  # exceeded the route's budget. The actual send may have completed anyway.
  # Report AMBIGUOUS and exit 0 so the agent verifies before retrying (a retry
  # would double-send since the first attempt likely went through).
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the conversation to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
elif [ "$HTTP_CODE" = "422" ]; then
  TONE_NUDGE=$(printf '%s' "$BODY" | python3 -c '
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
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
