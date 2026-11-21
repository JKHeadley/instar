---
name: Gemini Pay-Per-Use Invoice Check
description: "Monthly invoice-drift check for the Gemini pay-per-use lane (docs/specs/gemini-payg-metered-lane.md §7 Invoice-drift reporting, Self-Heal (c)). On the 2nd of each month at 09:00 (the spending machine's Pacific clock), with the one re-read at 15:00 the same day, it reads LAST month's spend for the lane's dedicated Google project from the AI Studio / Cloud billing page — read-only, through the account lane's signed-in browser profile (the normal-chrome-browser skill) — and posts the figure to POST /routing-spend/reconciliation (source browser-read; `unmeasurable` when the page cannot be read, never a guessed figure). REPORTING ONLY: a record never moves a cap or the gate. Quiet unless drift is over 10% AND over $2, re-read once after 6 hours; the server sends the one notice. Runs only on the spending machine (the route refuses elsewhere). Ships DISABLED fleet-wide; the operator's go-live plan turns it on for that agent."
schedule: "0 9,15 2 * *"
priority: low
expectedDurationMinutes: 10
model: sonnet
enabled: false
tags:
  - cat:maintenance
  - role:worker
  - exec:prompt
  - money
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: ["Bash"]
unrestrictedTools: false
mcpAccess: none
---
Run the monthly Gemini pay-per-use invoice check. It exists because Instar's own books (the money ledger) and Google's bill can disagree, and only reading Google's page shows it. It is reporting only: nothing you post changes what may spend.

AUTH="${INSTAR_AUTH_TOKEN:-$(node .instar/scripts/secret-get.mjs authToken 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"

1. **Only on the spending machine.** Read `curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/routing-spend/gemini-payg/release`. If `here` is not true, exit quietly: another machine spends, and its own run posts the figure.

2. **Which month.** The month to read is LAST month on the Pacific calendar (YYYY-MM).

3. **Read the figure, read-only.** Use the normal-chrome-browser skill with the account lane's signed-in profile for the dedicated Gemini project. Open the billing / spend page for that project and read the total charged for that month. Read only: never change a budget, a key or a setting there. Never read, copy or screenshot an API key.
   - If the page cannot be read (sign-in needed, the layout changed, the figure is not shown), the figure is `unmeasurable`. Never estimate it.

4. **Post it.** One of:
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H 'Content-Type: application/json' http://localhost:$PORT/routing-spend/reconciliation -d '{"month":"YYYY-MM","figureUsd":12.34}'`
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" -H 'Content-Type: application/json' http://localhost:$PORT/routing-spend/reconciliation -d '{"month":"YYYY-MM","unmeasurable":true}'`

5. **The one re-read.** This job runs twice on the 2nd (09:00 and 15:00, six hours apart). The 15:00 run is the re-read: if the 09:00 answer had no `driftPendingReread`, the 15:00 run may still post (it is harmless) or exit. The server sends the single drift notice only when a read at least six hours after the first drifted one still disagrees. If there is no drift, stay silent.

Do not message anyone. The server owns the notice; this job only reads and posts.
