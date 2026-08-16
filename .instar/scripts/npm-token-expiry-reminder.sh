#!/usr/bin/env bash
# Daily reminder for the npmjs.com - SageMindAI token expiry.
# Runs every day via ai.instar.echo.npm-token-expiry-reminder.plist (LaunchAgent).
# Reads the expiry date from Bitwarden each fire, so when Echo rotates the token
# and pushes a new `expires` field, this script automatically stops nagging.
#
# Bitwarden item: 1ae75845-08b8-47be-a98b-b410013f93a3 (npmjs.com - SageMindAI)
# Notify window: send daily starting (expiry - 3 days), continue until expiry is refreshed.
set -euo pipefail
cd /Users/justin/.instar/agents/echo

BW_ITEM_ID="1ae75845-08b8-47be-a98b-b410013f93a3"
RECIPIENT_EMAIL="justin@sagemindai.io"
TELEGRAM_TOPIC=11078
WARN_DAYS_BEFORE=3

LOG_DIR="/Users/justin/.instar/agents/echo/.instar/logs"
mkdir -p "$LOG_DIR"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG_DIR/npm-token-reminder.log"; }

# Bitwarden session lookup.
if [ ! -r "$HOME/.bw-session" ]; then
  log "ABORT: ~/.bw-session not readable"
  exit 0
fi
export BW_SESSION="$(cat "$HOME/.bw-session")"

# Fetch expiry from the live Bitwarden item.
ITEM_JSON="$(bw get item "$BW_ITEM_ID" 2>/dev/null || true)"
if [ -z "$ITEM_JSON" ]; then
  log "ABORT: could not fetch Bitwarden item $BW_ITEM_ID (session locked? offline?)"
  exit 0
fi
EXPIRY_DATE="$(printf '%s' "$ITEM_JSON" | python3 -c "
import sys, json
it = json.load(sys.stdin)
for f in it.get('fields') or []:
    if (f.get('name') or '').lower() == 'expires':
        print((f.get('value') or '').strip()); break
")"
if [ -z "$EXPIRY_DATE" ]; then
  log "ABORT: no \`expires\` custom field on Bitwarden item"
  exit 0
fi

NOW_EPOCH="$(date '+%s')"
EXP_EPOCH="$(date -j -f '%Y-%m-%d' "$EXPIRY_DATE" '+%s' 2>/dev/null || true)"
if [ -z "$EXP_EPOCH" ]; then
  log "ABORT: could not parse expiry '$EXPIRY_DATE'"
  exit 0
fi
DAYS_LEFT=$(( (EXP_EPOCH - NOW_EPOCH) / 86400 ))
WARN_THRESHOLD=$WARN_DAYS_BEFORE

if [ "$DAYS_LEFT" -gt "$WARN_THRESHOLD" ]; then
  log "OK: $DAYS_LEFT days until $EXPIRY_DATE — outside warn window ($WARN_THRESHOLD)"
  exit 0
fi

# Build the message.
if [ "$DAYS_LEFT" -lt 0 ]; then
  SUBJECT="NPM token EXPIRED — please rotate"
  PHRASE="**expired** on $EXPIRY_DATE ($(( -DAYS_LEFT )) day(s) ago)"
elif [ "$DAYS_LEFT" -eq 0 ]; then
  SUBJECT="NPM token expires TODAY — please rotate"
  PHRASE="**expires today** ($EXPIRY_DATE)"
else
  SUBJECT="NPM token expires in $DAYS_LEFT day(s) — please rotate"
  PHRASE="expires in $DAYS_LEFT day(s) on $EXPIRY_DATE"
fi
BODY_TEXT="The npm automation token \"npmjs.com - SageMindAI\" $PHRASE.

Rotate it: https://www.npmjs.com/settings/sagemindai/tokens-create
Then DM the new token to Echo on Telegram topic 11078 (\"npm tokens\") — I'll update Bitwarden and stop these reminders automatically.

— Echo"

# Send via email if configured, else fall back to Telegram so the user is never silently un-notified.
EMAIL_SENT=0
EMAIL_ERR=""
if [ -r "$HOME/.instar/agents/echo/.instar/secrets/smtp.env" ]; then
  set +e
  ( set -a; . "$HOME/.instar/agents/echo/.instar/secrets/smtp.env"; set +a
    : "${SMTP_HOST:?}" "${SMTP_PORT:?}" "${SMTP_USER:?}" "${SMTP_PASS:?}" "${SMTP_FROM:?}"
    MSG_FILE="$(mktemp)"
    {
      printf 'From: %s\r\n' "$SMTP_FROM"
      printf 'To: %s\r\n' "$RECIPIENT_EMAIL"
      printf 'Subject: %s\r\n' "$SUBJECT"
      printf 'Date: %s\r\n' "$(date '+%a, %d %b %Y %H:%M:%S %z')"
      printf 'MIME-Version: 1.0\r\n'
      printf 'Content-Type: text/plain; charset=UTF-8\r\n'
      printf '\r\n'
      printf '%s\r\n' "$BODY_TEXT"
    } > "$MSG_FILE"
    curl --silent --show-error --ssl-reqd \
      --url "smtps://${SMTP_HOST}:${SMTP_PORT}" \
      --mail-from "$SMTP_FROM" \
      --mail-rcpt "$RECIPIENT_EMAIL" \
      --user "${SMTP_USER}:${SMTP_PASS}" \
      --upload-file "$MSG_FILE"
    rc=$?
    rm -f "$MSG_FILE"
    exit $rc
  ) 2> "$LOG_DIR/npm-token-reminder.smtp.err"
  if [ $? -eq 0 ]; then EMAIL_SENT=1; else EMAIL_ERR="$(cat "$LOG_DIR/npm-token-reminder.smtp.err" 2>/dev/null | tail -3)"; fi
  set -e
fi

if [ "$EMAIL_SENT" -eq 1 ]; then
  log "SENT email to $RECIPIENT_EMAIL ($PHRASE)"
else
  TG_BODY="$SUBJECT

$BODY_TEXT"
  [ -n "$EMAIL_ERR" ] && TG_BODY="$TG_BODY

(Email transport not configured / failed — falling back to Telegram. SMTP error: $EMAIL_ERR)"
  printf '%s\n' "$TG_BODY" | .instar/scripts/telegram-reply.sh "$TELEGRAM_TOPIC" >/dev/null
  log "SENT telegram (email path unavailable) ($PHRASE)"
fi
