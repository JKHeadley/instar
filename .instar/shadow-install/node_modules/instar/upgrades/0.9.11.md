# Upgrade Guide: Instar (latest)

## What Changed

### Intent Engineering — Organizational Alignment Infrastructure

Instar now includes a complete intent engineering system. This is the third discipline after prompt engineering ("how do I talk to AI?") and context engineering ("what does AI need to know?"). Intent engineering answers: "what does the organization need AI to WANT?"

#### Phase 2: Learning Ecosystem Security

**Human approval gate for dispatches.** Security and behavioral dispatches from Dawn now require explicit approval before being applied. Your user can review, approve, or reject dispatches via Telegram or API.

**Feedback quality validation.** Feedback submissions are now validated for substance — empty titles, short descriptions, and duplicates are rejected before forwarding.

**Pseudonymized traceability.** Agent names in feedback are replaced with stable SHA-256 pseudonyms (`agent-a1b2c3d4e5f6`) for privacy. The mapping is reversible locally but anonymous upstream.

**Anomaly detection.** A sliding-window detector flags agents submitting feedback at suspicious rates (rapid fire, hourly bursts, daily limits).

**Rate limiting.** Feedback endpoint now enforces 10 submissions per minute per source.

#### Phase 3: Organizational Intent

**ORG-INTENT.md.** Organizations deploying multiple agents can now define shared purpose, constraints, goals, values, and tradeoff hierarchies in a single file. Run `instar intent org-init "Acme Corp"` to generate the template.

**Three-rule contract inheritance:**
1. Org constraints are mandatory — agents cannot override them
2. Org goals are defaults — agents can specialize but not contradict
3. Agent identity fills the rest — personality, style, approach

**Static validation.** `instar intent validate` checks your agent's AGENT.md against the organization's ORG-INTENT.md for structural conflicts (contradicting constraints, missing required values, incompatible tradeoff hierarchies).

#### Phase 4: Measurement

**Intent drift detection.** `instar intent drift` analyzes your decision journal over a sliding window and detects 4 signal types: conflict spikes, confidence drops, principle shifts, and volume changes.

**Alignment scoring.** `instar intent alignment` produces a weighted score (0-100, A-F grade) based on conflict freedom (30%), decision confidence (25%), principle consistency (25%), and journal health (20%).

### New API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/dispatches/pending-approval` | GET | List dispatches awaiting human approval |
| `/dispatches/:id/approve` | POST | Approve a pending dispatch |
| `/dispatches/:id/reject` | POST | Reject a pending dispatch with reason |
| `/intent/org` | GET | View parsed organizational intent |
| `/intent/validate` | GET | Run agent-vs-org conflict validation |
| `/intent/drift` | GET | Analyze intent drift (optional `?window=14`) |
| `/intent/alignment` | GET | Get alignment score and grade |

### New CLI Commands

| Command | Purpose |
|---------|---------|
| `instar intent org-init [name]` | Generate ORG-INTENT.md template |
| `instar intent validate` | Check agent intent against org constraints |
| `instar intent drift [--window N]` | Detect intent drift over N days |

## What to Tell Your User

- **Dispatch approval**: "I now have a safety gate on dispatches from Dawn. Security and behavioral updates will wait for your approval before I apply them — you'll see them in our chat and can approve or reject each one."
- **Organizational intent**: "If you're managing multiple agents, you can now define shared organizational values in an ORG-INTENT.md file. I'll inherit the constraints and goals automatically, and you can run validation to check for conflicts."
- **Intent drift monitoring**: "I can now track whether my decisions are drifting away from our stated intent over time. Run `instar intent drift` to see a report, or check the alignment score for an overall grade."
- **Feedback quality**: "My feedback to Dawn is now validated for quality before submission — no more accidental empty or duplicate reports."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dispatch approval gate | Automatic — security/behavioral dispatches pause for approval. Approve/reject via API or Telegram |
| Feedback validation | Automatic — low-quality submissions rejected before forwarding |
| Pseudonymized feedback | Automatic — agent names anonymized in upstream reports |
| Anomaly detection | Automatic — suspicious submission patterns flagged |
| Rate limiting | Automatic — 10 feedback submissions/minute enforced |
| Organizational intent | `instar intent org-init "Name"` to create ORG-INTENT.md |
| Intent validation | `instar intent validate` to check agent-vs-org conflicts |
| Drift detection | `instar intent drift --window 14` for sliding-window analysis |
| Alignment scoring | Via API: GET /intent/alignment |
