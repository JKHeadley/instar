#!/bin/bash
# Skill Usage Telemetry — PostToolUse hook for Skill tool.
#
# Logs every skill invocation to .instar/skill-telemetry.jsonl
# for future pattern detection (which skills are used, when, how often).
#
# Cross-pollinated from Dawn's Portal project (2026-04-09).
# Lightweight: appends one JSONL line, no network calls.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
if [ "$TOOL_NAME" != "Skill" ]; then
  exit 0
fi

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
TELEMETRY_FILE="$INSTAR_DIR/skill-telemetry.jsonl"

SKILL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('skill','unknown'))" 2>/dev/null)
SKILL_ARGS=$(echo "$INPUT" | python3 -c "import json,sys; a=json.load(sys.stdin).get('tool_input',{}).get('args',''); print(a[:200])" 2>/dev/null)
OUTPUT_LEN=$(echo "$INPUT" | python3 -c "import json,sys; print(len(str(json.load(sys.stdin).get('tool_output',''))))" 2>/dev/null)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

SESSION_ID="${INSTAR_SESSION_ID:-}"

mkdir -p "$INSTAR_DIR"
echo "{\"timestamp\":\"$TIMESTAMP\",\"skill\":\"$SKILL_NAME\",\"args\":\"$SKILL_ARGS\",\"session_id\":\"$SESSION_ID\",\"output_length\":$OUTPUT_LEN}" >> "$TELEMETRY_FILE"
