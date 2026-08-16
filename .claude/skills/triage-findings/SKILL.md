---
name: triage-findings
description: Review and route pending serendipity findings captured by sub-agents.
metadata:
  user_invocable: "true"
---

# /triage-findings

Review pending serendipity findings — discoveries captured by sub-agents during focused tasks. Route each finding to the appropriate destination: Evolution proposals, dismiss, or flag for manual review.

## Steps

1. **List pending findings**:

\`\`\`bash
ls .instar/state/serendipity/*.json 2>/dev/null
\`\`\`

If no findings exist, report "No pending findings" and stop.

2. **For each finding**, read and verify:
   a. Parse the JSON file
   b. Verify HMAC signature (read authToken from .instar/config.json, derive signing key from HMAC-SHA256(authToken, "serendipity-v1:" + sessionId), verify the signed payload)
   c. If HMAC fails, move to \`.instar/state/serendipity/invalid/\` and log the failure
   d. If a .patch file is referenced, verify it exists and its SHA-256 matches \`artifacts.patchSha256\`

3. **Assess each valid finding**:
   - Is it actionable? Does it describe a real issue or improvement?
   - Is it a duplicate of something already proposed?
   - Check existing evolution proposals: \`curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/evolution/proposals\`

4. **Route the finding** (one of):

   **a. Promote to Evolution proposal** (for actionable findings):
   \`\`\`bash
   curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/proposals \\
     -H "Authorization: Bearer $AUTH" \\
     -H 'Content-Type: application/json' \\
     -d '{"title":"FINDING_TITLE","source":"serendipity:FINDING_ID","description":"FINDING_DESCRIPTION","type":"TYPE","impact":"IMPACT","effort":"EFFORT","tags":["serendipity","from-subagent"]}'
   \`\`\`

   **b. Dismiss** (for low-value, duplicate, or stale findings):
   Move to processed directory with a note.

   **c. Flag for manual review** (for findings you're uncertain about):
   Queue an attention item:
   \`\`\`bash
   curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/attention \\
     -H "Authorization: Bearer $AUTH" \\
     -H 'Content-Type: application/json' \\
     -d '{"title":"Serendipity finding needs review: TITLE","body":"DESCRIPTION","priority":"low","source":"serendipity"}'
   \`\`\`

5. **Move processed finding** to \`.instar/state/serendipity/processed/\`:
   \`\`\`bash
   mv .instar/state/serendipity/FINDING_ID.json .instar/state/serendipity/processed/
   mv .instar/state/serendipity/FINDING_ID.patch .instar/state/serendipity/processed/ 2>/dev/null
   \`\`\`

6. **Report summary**: How many findings triaged, how many promoted, dismissed, flagged.

## HMAC Verification (Python)

\`\`\`python
import json, hmac, hashlib

finding = json.load(open('FINDING_FILE'))
config = json.load(open('.instar/config.json'))
auth_token = config.get('authToken', '')
session_id = finding['source']['sessionId']

# Derive signing key
key_material = f"serendipity-v1:{session_id}"
signing_key = hmac.new(auth_token.encode(), key_material.encode(), hashlib.sha256).hexdigest()

# Build canonical signed payload
signed_data = {"id": finding["id"], "createdAt": finding["createdAt"],
               "discovery": finding["discovery"], "source": finding["source"]}
if "artifacts" in finding:
    signed_data["artifacts"] = finding["artifacts"]
canonical = json.dumps(signed_data, sort_keys=True, separators=(',', ':'))

expected = hmac.new(signing_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, finding.get('hmac', ''))
\`\`\`

## Category to Evolution Type Mapping

| Serendipity Category | Evolution Type |
|---------------------|---------------|
| bug | capability |
| improvement | capability |
| feature | capability |
| pattern | workflow |
| refactor | infrastructure |
| security | infrastructure |

## When to Run

- When session-start hook reports pending findings
- Periodically (the evolution-review job can trigger this)
- When the user asks about pending discoveries
