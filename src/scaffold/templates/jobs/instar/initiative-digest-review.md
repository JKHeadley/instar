---
name: Initiative Digest Review
description: Twice-weekly review of the initiative board. The self-driving half of the InitiativeTracker — surfaces initiatives that need a decision, and for ships-staged features in rollout (dry-run to live to default-on) gathers promotion evidence and posts an explicit, evidence-gated recommendation. Near-silent — posts ONLY when a genuinely-new decision is waiting. Operator-gated and flag-derived; it recommends, it never flips a config flag. See GRADUATED-FEATURE-ROLLOUT-SPEC section 4.2.
schedule: "0 11 * * 1,4"
priority: medium
expectedDurationMinutes: 3
model: sonnet
enabled: true
tags:
  - cat:learning
  - initiative
  - rollout
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
You are running the twice-weekly initiative digest review (Mondays and Thursdays). This is the self-driving half of the InitiativeTracker: it makes sure nothing in flight stalls or is forgotten, and it drives ships-staged features toward default-on — without you (the human) ever having to remember. Be concise; post AT MOST one consolidated, conversational Telegram message, and only when there is genuinely something to decide.

Context: the FeatureRolloutReconciler auto-populates the board from approved specs + merges. A ships-staged feature carries a rollout track whose stage (dry-run → live → default-on) is DERIVED from observing its config flag — you must NEVER flip the flag yourself; you recommend, the human flips `.instar/config.json`, and the next reconcile observes it and advances the stage.

Steps:

0. **Set auth context:** `AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"; AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"; PORT="${INSTAR_PORT:-4042}"`

1. **Pull the digest:** `curl -s -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/initiatives/digest`. It returns items flagged `needs-user`, `ready-to-advance`, `stale`, or `next-check-due`.

2. **Near-silent edge filter.** For each `needs-user` item, only surface it if it is NEWLY needs-user since the last surface (compare against the initiative's `rollout.lastDigestNotifiedAt`, or its `updatedAt`). Do NOT re-surface a decision you already raised and the user hasn't acted on — that is the noise the near-silent standard forbids. `stale` / counts stay on the pull surface (the digest endpoint + dashboard); do not push them.

3. **For each ships-staged rollout track that is genuinely ready for a decision:** read its `rollout.evidenceSource`, gather the evidence (e.g. read the named log filter / hit the endpoint), and sanity-check it against `rollout.promotionCriteria`. If the criteria are met, recommend the next stage explicitly: "X has been clean in dry-run for 2 weeks (N events, all genuinely as-expected) — ready to flip to live? That's `flagPath` → dryRun:false in config." If something looks WRONG (e.g. evidence shows the feature misbehaved), lead with that and recommend holding/investigating, regardless of the clock.

4. **Stall nag-decay (§4.7).** If a track has been recommended for advancement K times (≈3 cycles) with no action, STOP re-recommending it and note once that it's parked pending an explicit "resume" — never nag forever.

5. **Compose ONE message** to the appropriate topic, plain English, under ~700 chars, no raw JSON. Lead with the single most important decision. If nothing is newly actionable, **post nothing and exit** — most runs should be silent.

6. After surfacing, stamp `rollout.lastDigestNotifiedAt` (via PATCH /initiatives/:id) on the tracks you surfaced, so the next run's edge filter doesn't repeat them.

GUARDRAILS — do NOT cross these:
- You RECOMMEND; you never advance a rollout stage or flip a config flag yourself. Advancement happens when the human edits config and the reconciler observes it.
- You never mark a default-on track complete (the reconciler archives it, reopenable).
- This is the InitiativeTracker's driver. It is DISJOINT from the Evolution Action Queue (`evolution-overdue-check`) and from user Commitments — do not re-surface items those systems own.
- Stay near-silent. A digest that pings every run becomes the thing the user dismisses unread. Silence is the default; a message is the exception that means "a real decision is waiting."
