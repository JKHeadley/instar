#!/bin/bash
# Stage 2 startup script - reads handoff and spawns review session

AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

STAGE2_PROMPT=$(cat .instar/prompts/github-monitor-stage2.md)
HANDOFF=$(cat .instar/state/github-monitor-handoff.json)

PAYLOAD=$(python3 -c "
import json
full_prompt = '''$STAGE2_PROMPT

## Handoff Data

$HANDOFF
'''
print(json.dumps({
    'name': 'github-monitor-review',
    'prompt': full_prompt,
    'model': 'opus',
    'jobSlug': 'github-collab-monitor'
}))
")

curl -s -X POST http://localhost:4042/sessions/spawn \
  -H "Authorization: Bearer $AUTH" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
