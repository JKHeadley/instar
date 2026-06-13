<!-- maturity: experimental — ships dev-enabled / fleet-dark behind resolveDevAgentGate -->
<!-- audience: agent-only — a dark feature; no user-facing announcement until promoted -->

## What Changed

Added an **Operator Authorization Request** flow: when the agent needs the operator to grant a person a floor action (e.g. "let Mia deploy to prod for an hour"), it now pre-fills a structured request and the operator approves it in one tap on a plain-language "Approvals waiting for you" card — instead of hand-building a mandate in a raw-JSON form. This fixes the operator-reported defect where the Mandates tab forced the operator to construct a mandate from a raw-JSON authorities editor. The raw-JSON "author a mandate by hand" form is demoted behind an "Advanced" disclosure. A new constitutional standard — "Agent Proposes, Operator Approves" — is enforced by a precommit gate so authorization surfaces must be approvals, never authoring tasks, with the authority text authored by the server (never agent free-text). Ships dev-enabled / fleet-dark.

## What to Tell Your User

Nothing yet — this is an experimental, dark-by-default capability. On a developer agent it is live: when I need you to authorize a person for something (a deploy, a credential, etc.), you'll see a simple card on the dashboard Mandates tab — one plain sentence, your PIN, and Approve. You never build a "mandate" or touch JSON. Only your PIN turns my request into a real grant.

## Summary of New Capabilities

- `POST /authorization-requests` — the agent pre-fills a structured grant request (Bearer; confers no authority).
- `GET /authorization-requests?status=pending` — the dashboard's "Approvals waiting for you" cards (server-authored plain-language text).
- `POST /authorization-requests/:id/approve|deny` — PIN-gated operator approval/decline; approve issues the grant via the existing signed MandateStore path.
- `POST /authorization-requests/:id/withdraw` — the proposing agent withdraws its own pending request.
- Constitutional standard "Agent Proposes, Operator Approves" + a blocking precommit gate.

## Evidence

The operator reported (2026-06-13, topic 22367) that the Mandates grant flow still showed raw JSON and forced him to "create a mandate" — reproducible by opening the Mandates tab and attempting a grant with no active mandate (the grant form never appears; only the raw-JSON issue form does). Fixed: the new "Approvals waiting for you" card is the primary surface; the raw-JSON form is demoted behind "Advanced". A naive version of the fix would have reopened a deceptive-display hole (agent-authored card text diverging from the executed grant); that is closed by server-authoring the headline from the structured proposal + the registry name, and is asserted at all three test tiers (a malicious agent `reason` never becomes the headline). 67 tests green (unit/integration/e2e + gate + dark-gate golden map).
