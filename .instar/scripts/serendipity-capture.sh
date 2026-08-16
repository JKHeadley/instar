#!/bin/bash
# serendipity-capture.sh — Capture a serendipity finding from a sub-agent.
#
# Usage:
#   .instar/scripts/serendipity-capture.sh \
#     --title "Short description" \
#     --description "Full explanation" \
#     --category improvement \
#     --rationale "Why this matters" \
#     --readiness idea-only \
#     [--patch-file /path/to/changes.patch]
#
# Categories: bug, improvement, feature, pattern, refactor, security
# Readiness: idea-only, partially-implemented, implementation-complete, tested
#
# The script handles JSON construction, HMAC signing, atomic writes,
# rate limiting, and secret scanning. Sub-agents should use this script
# rather than constructing JSON directly.

set -euo pipefail

# --- Configuration ---
MAX_PER_SESSION=5
MAX_TITLE_LEN=120
MAX_DESC_LEN=2000
MAX_RATIONALE_LEN=1000
MAX_PATCH_SIZE=10240  # 10KB
VALID_CATEGORIES="bug improvement feature pattern refactor security"
VALID_READINESS="idea-only partially-implemented implementation-complete tested"

# --- Find project root ---
# Walk up from script location to find .instar/config.json
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# If we're in a worktree, the .instar dir might be a gitlink
if [ ! -f "$PROJECT_ROOT/.instar/config.json" ]; then
  # Try parent directories
  DIR="$PWD"
  while [ "$DIR" != "/" ]; do
    if [ -f "$DIR/.instar/config.json" ]; then
      PROJECT_ROOT="$DIR"
      break
    fi
    DIR="$(dirname "$DIR")"
  done
fi

SERENDIPITY_DIR="$PROJECT_ROOT/.instar/state/serendipity"
CONFIG_FILE="$PROJECT_ROOT/.instar/config.json"

# --- Check if serendipity is enabled ---
if [ -f "$CONFIG_FILE" ]; then
  ENABLED=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG_FILE'))
  print(cfg.get('serendipity', {}).get('enabled', True))
except: print('True')
" 2>/dev/null || echo "True")
  if [ "$ENABLED" = "False" ]; then
    echo "Serendipity protocol is disabled in config. Finding not captured." >&2
    exit 1
  fi

  # Read configurable limits
  MAX_PER_SESSION=$(python3 -c "
import json
try:
  cfg = json.load(open('$CONFIG_FILE'))
  print(cfg.get('serendipity', {}).get('maxPerSession', 5))
except: print(5)
" 2>/dev/null || echo "5")
fi

# --- Argument parsing ---
TITLE=""
DESCRIPTION=""
CATEGORY=""
RATIONALE=""
READINESS=""
PATCH_FILE=""
ARTIFACT_TYPE=""
ARTIFACT_FILES=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --title) TITLE="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --rationale) RATIONALE="$2"; shift 2 ;;
    --readiness) READINESS="$2"; shift 2 ;;
    --patch-file) PATCH_FILE="$2"; shift 2 ;;
    --artifact-type) ARTIFACT_TYPE="$2"; shift 2 ;;
    --files) ARTIFACT_FILES="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Validate required fields ---
if [ -z "$TITLE" ]; then echo "Error: --title is required" >&2; exit 1; fi
if [ -z "$DESCRIPTION" ]; then echo "Error: --description is required" >&2; exit 1; fi
if [ -z "$CATEGORY" ]; then echo "Error: --category is required" >&2; exit 1; fi
if [ -z "$RATIONALE" ]; then echo "Error: --rationale is required" >&2; exit 1; fi
if [ -z "$READINESS" ]; then echo "Error: --readiness is required" >&2; exit 1; fi

# --- Validate category ---
VALID=false
for c in $VALID_CATEGORIES; do
  if [ "$CATEGORY" = "$c" ]; then VALID=true; break; fi
done
if [ "$VALID" = "false" ]; then
  echo "Error: --category must be one of: $VALID_CATEGORIES" >&2
  exit 1
fi

# --- Validate readiness ---
VALID=false
for r in $VALID_READINESS; do
  if [ "$READINESS" = "$r" ]; then VALID=true; break; fi
done
if [ "$VALID" = "false" ]; then
  echo "Error: --readiness must be one of: $VALID_READINESS" >&2
  exit 1
fi

# --- Validate field lengths ---
if [ ${#TITLE} -gt $MAX_TITLE_LEN ]; then
  echo "Error: --title exceeds $MAX_TITLE_LEN characters (${#TITLE} chars). Shorten it." >&2
  exit 1
fi
if [ ${#DESCRIPTION} -gt $MAX_DESC_LEN ]; then
  echo "Error: --description exceeds $MAX_DESC_LEN characters (${#DESCRIPTION} chars). Shorten it." >&2
  exit 1
fi
if [ ${#RATIONALE} -gt $MAX_RATIONALE_LEN ]; then
  echo "Error: --rationale exceeds $MAX_RATIONALE_LEN characters (${#RATIONALE} chars). Shorten it." >&2
  exit 1
fi

# --- Create directory lazily (0700 permissions) ---
if [ ! -d "$SERENDIPITY_DIR" ]; then
  mkdir -p "$SERENDIPITY_DIR" "$SERENDIPITY_DIR/processed" "$SERENDIPITY_DIR/invalid"
  chmod 700 "$SERENDIPITY_DIR"
fi

# --- Rate limiting ---
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
EXISTING_COUNT=$(find "$SERENDIPITY_DIR" -maxdepth 1 -name "*.json" -newer /dev/null 2>/dev/null | wc -l | tr -d ' ')

# More precise: count findings from THIS session
if [ "$SESSION_ID" != "unknown" ]; then
  EXISTING_COUNT=$(python3 -c "
import json, glob, sys
count = 0
for f in glob.glob('$SERENDIPITY_DIR/*.json'):
    try:
        d = json.load(open(f))
        if d.get('source', {}).get('sessionId') == '$SESSION_ID':
            count += 1
    except: pass
print(count)
" 2>/dev/null || echo "$EXISTING_COUNT")
fi

if [ "$EXISTING_COUNT" -ge "$MAX_PER_SESSION" ]; then
  echo "Error: Rate limit reached ($MAX_PER_SESSION findings per session). This finding was NOT captured." >&2
  echo "Do NOT attempt to bypass this limit by writing JSON directly." >&2
  exit 1
fi

# --- Validate and process patch file ---
PATCH_SHA256=""
PATCH_FILENAME=""
if [ -n "$PATCH_FILE" ]; then
  if [ ! -f "$PATCH_FILE" ]; then
    echo "Error: Patch file not found: $PATCH_FILE" >&2
    exit 1
  fi

  # Check it's a regular file, not a symlink
  if [ -L "$PATCH_FILE" ]; then
    echo "Error: Patch file is a symlink. Symlinks are not allowed for security reasons." >&2
    exit 1
  fi

  # Check size
  PATCH_SIZE=$(wc -c < "$PATCH_FILE")
  if [ "$PATCH_SIZE" -gt "$MAX_PATCH_SIZE" ]; then
    echo "Error: Patch file exceeds ${MAX_PATCH_SIZE} bytes ($PATCH_SIZE bytes). Max is 10KB." >&2
    exit 1
  fi

  # Check for path traversal in diff headers
  if grep -qE '^\+\+\+ .*(\.\.\/|^/)' "$PATCH_FILE" 2>/dev/null || \
     grep -qE '^--- .*(\.\.\/|^/)' "$PATCH_FILE" 2>/dev/null; then
    echo "Error: Patch file contains path traversal (../) or absolute paths in diff headers. Rejected." >&2
    exit 1
  fi

  # Compute SHA-256
  PATCH_SHA256=$(shasum -a 256 "$PATCH_FILE" | cut -d' ' -f1)
fi

# --- Secret scanning (blocking) ---
SECRET_PATTERNS='(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9\-]{20}|xox[bpors]-[a-zA-Z0-9\-]{10,}|-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----|password\s*[:=]\s*["\x27][^"\x27]{8,}|[a-zA-Z0-9+/]{40,}={1,2})'

# Scan all text fields
ALL_TEXT="$TITLE $DESCRIPTION $RATIONALE"
if echo "$ALL_TEXT" | grep -qEi "$SECRET_PATTERNS" 2>/dev/null; then
  echo "Error: Potential secret/credential detected in finding text. Finding NOT captured." >&2
  echo "Remove sensitive content and try again." >&2
  exit 1
fi

# Scan patch file if present
if [ -n "$PATCH_FILE" ] && grep -qEi "$SECRET_PATTERNS" "$PATCH_FILE" 2>/dev/null; then
  echo "Error: Potential secret/credential detected in patch file. Finding NOT captured." >&2
  echo "Remove sensitive content from the patch and try again." >&2
  exit 1
fi

# --- Generate ID ---
if command -v uuidgen &>/dev/null; then
  FINDING_ID="srdp-$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)"
else
  FINDING_ID="srdp-$(python3 -c 'import uuid; print(str(uuid.uuid4())[:8])')"
fi

CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
AGENT_TYPE="${CLAUDE_AGENT_TYPE:-general-purpose}"

# --- Copy patch file to serendipity dir ---
if [ -n "$PATCH_FILE" ]; then
  PATCH_FILENAME="${FINDING_ID}.patch"
  cp "$PATCH_FILE" "$SERENDIPITY_DIR/${PATCH_FILENAME}.tmp"
  sync "$SERENDIPITY_DIR/${PATCH_FILENAME}.tmp" 2>/dev/null || true
  mv "$SERENDIPITY_DIR/${PATCH_FILENAME}.tmp" "$SERENDIPITY_DIR/${PATCH_FILENAME}"
fi

# --- Build JSON and compute HMAC ---
# Export all variables for the python script
export FINDING_ID CREATED_AT SESSION_ID AGENT_TYPE
export TITLE DESCRIPTION CATEGORY RATIONALE READINESS
export PATCH_FILENAME PATCH_SHA256 ARTIFACT_TYPE ARTIFACT_FILES
export SERENDIPITY_DIR CONFIG_FILE
export TASK_DESC="${CLAUDE_TASK_DESCRIPTION:-}"

# Use python3 for reliable JSON construction and HMAC signing
python3 << 'PYTHON_EOF'
import json, hmac, hashlib, os, sys

# Read values from environment/arguments
finding = {
    "schemaVersion": 1,
    "id": os.environ.get("FINDING_ID"),
    "hmac": "",  # placeholder, computed below
    "createdAt": os.environ.get("CREATED_AT"),
    "source": {
        "sessionId": os.environ.get("SESSION_ID", "unknown"),
        "taskDescription": os.environ.get("TASK_DESC", ""),
        "agentType": os.environ.get("AGENT_TYPE", "general-purpose")
    },
    "discovery": {
        "title": os.environ.get("TITLE"),
        "description": os.environ.get("DESCRIPTION"),
        "category": os.environ.get("CATEGORY"),
        "rationale": os.environ.get("RATIONALE")
    },
    "readiness": os.environ.get("READINESS"),
    "status": "pending"
}

# Add artifacts if present
patch_file = os.environ.get("PATCH_FILENAME", "")
patch_sha = os.environ.get("PATCH_SHA256", "")
artifact_type = os.environ.get("ARTIFACT_TYPE", "")
artifact_files_str = os.environ.get("ARTIFACT_FILES", "")

if patch_file or artifact_type:
    artifacts = {}
    if artifact_type:
        artifacts["type"] = artifact_type
    elif patch_file:
        artifacts["type"] = "code"
    if patch_file:
        artifacts["patchFile"] = patch_file
        artifacts["patchSha256"] = patch_sha
    if artifact_files_str:
        artifacts["files"] = [f.strip() for f in artifact_files_str.split(",")]
    finding["artifacts"] = artifacts

# Compute HMAC
# Key derivation: HMAC-SHA256(authToken, "serendipity-v1:" + sessionId)
signing_key = os.environ.get("SERENDIPITY_SIGNING_KEY", "")
if not signing_key:
    # Derive from auth token + session
    config_path = os.environ.get("CONFIG_FILE", "")
    auth_token = ""
    if config_path and os.path.exists(config_path):
        try:
            cfg = json.load(open(config_path))
            auth_token = cfg.get("authToken", "")
        except:
            pass
    session_id = finding["source"]["sessionId"]
    key_material = f"serendipity-v1:{session_id}"
    signing_key = hmac.new(
        auth_token.encode(), key_material.encode(), hashlib.sha256
    ).hexdigest()

# Signed payload: canonical JSON of { id, createdAt, discovery, source, artifacts }
signed_data = {
    "id": finding["id"],
    "createdAt": finding["createdAt"],
    "discovery": finding["discovery"],
    "source": finding["source"]
}
if "artifacts" in finding:
    signed_data["artifacts"] = finding["artifacts"]

canonical = json.dumps(signed_data, sort_keys=True, separators=(',', ':'))
signature = hmac.new(
    signing_key.encode(), canonical.encode(), hashlib.sha256
).hexdigest()

finding["hmac"] = signature

# Write to temp file
serendipity_dir = os.environ.get("SERENDIPITY_DIR")
finding_id = finding["id"]
tmp_path = os.path.join(serendipity_dir, f"{finding_id}.json.tmp")
final_path = os.path.join(serendipity_dir, f"{finding_id}.json")

with open(tmp_path, 'w') as f:
    json.dump(finding, f, indent=2)
    f.flush()
    os.fsync(f.fileno())

# Atomic rename
os.rename(tmp_path, final_path)

print(f"Captured: {finding_id} — \"{finding['discovery']['title']}\"")
print(f"File: {final_path}")
PYTHON_EOF
