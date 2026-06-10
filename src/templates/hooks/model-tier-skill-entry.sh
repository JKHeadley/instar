#!/bin/bash
# Model-Tier Skill Entry — PostToolUse hook for the Skill tool.
#
# FABLE-MODEL-ESCALATION-SPEC §5.4: records that a trigger skill STARTED by
# writing the per-instance mode-state — ONLY on a tier transition (§6
# write-on-transition; never on every PostToolUse). This is a SIGNAL writer:
# it never swaps anything and never carries a model id; the reconciler +
# server-side swap service (the single authority) decide what happens.
#
# Instance key: INSTAR_SESSION_ID — the spawn-generated session id. A
# resume/respawn gets a fresh id, so a predecessor's mode-state can never be
# inherited (§5.5). Fail-closed: any missing input exits 0 silently.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
if [ "$TOOL_NAME" != "Skill" ]; then
  exit 0
fi

if [ -z "${INSTAR_SESSION_ID:-}" ]; then
  exit 0
fi

INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="$INSTAR_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

SKILL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('skill',''))" 2>/dev/null)
if [ -z "$SKILL_NAME" ]; then
  exit 0
fi

MODE_FILE="$INSTAR_DIR/state/model-tier-escalation/mode-state-${INSTAR_SESSION_ID}.json"

python3 - "$CONFIG_FILE" "$SKILL_NAME" "$MODE_FILE" "${INSTAR_SESSION_ID}" "${INSTAR_SESSION_NAME:-}" <<'PYEOF' 2>/dev/null
import json, os, sys, datetime
config_file, skill, mode_file, instance_id, session_name = sys.argv[1:6]
try:
    cfg = json.load(open(config_file))
except Exception:
    sys.exit(0)
te = ((cfg.get('models') or {}).get('tierEscalation') or {})
if te.get('enabled') is not True:
    sys.exit(0)
triggers = ((te.get('triggers') or {}).get('skills')) or ['build', 'autonomous', 'instar-dev', 'spec-converge']
if skill not in triggers:
    sys.exit(0)
# Write-on-transition only (spec section 6): an existing same-instance
# escalated mode-state means no transition - never rewrite (no churn).
try:
    existing = json.load(open(mode_file))
    if existing.get('instanceId') == instance_id and existing.get('tier') == 'escalated':
        sys.exit(0)
except Exception:
    pass
os.makedirs(os.path.dirname(mode_file), exist_ok=True)
state = {
    'tier': 'escalated',
    'trigger': skill,
    'since': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'instanceId': instance_id,
    'sessionName': session_name,
}
tmp = mode_file + '.tmp'
with open(tmp, 'w') as f:
    json.dump(state, f)
os.replace(tmp, mode_file)
PYEOF
exit 0
