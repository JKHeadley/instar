# Operator Approval Links — one-time, PIN-gated, phone-first authorization of agent-staged actions

**Status:** DRAFT — pending `/spec-converge` and operator approval. Do not build from this document until the frontmatter carries `review-convergence` and `approved: true`.
**Constitutional basis:** Mobile-Complete Operator Actions; Structure beats Willpower; Signal vs. Authority; Know Your Principal; Bounded Notification Surface.
**Born from:** the 2026-06-12 floor-grant incident (Slack live-test scenario 8/8, topic 22367) — the crystallizing case of an operator action that existed only as an API. The Mandates-tab grant form (instar#1080, PR #1082) converted that one surface; THIS spec is the generalization the constitution entry tracks.

## Problem

Operator-authorized actions keep being born API-first: a PIN-gated route ships, its dashboard surface lags (or never lands), and the agent's only honest fallback is a terminal command — a constitutional defect under Mobile-Complete Operator Actions. Building a bespoke dashboard form per action (the #1082 approach) closes one surface at a time and only for *standing* controls; it does not cover **ad-hoc, one-shot authorizations** ("approve THIS deploy", "sign THIS grant", "release THIS payment") where the operator should be able to act from a Telegram link in seconds.

Secret Drop already proves every ingredient of the right shape — one-time token, short expiry, CSRF protection, mobile-friendly form, Telegram delivery — but in the inbound-secret direction. This spec is its mirror: outbound **decision** collection.

## Shape

### Core flow

1. **Stage.** The agent (or a feature on its behalf) creates an approval request: `POST /approvals/links` with `{ kind, title, plainDescription, action: { method, path, body }, expiresInMinutes?, topicId? }`. The `action` is the EXACT server-side call to perform on approval — **frozen at staging time** and content-addressed (`sha256` over the canonicalized action); the page later displays this hash and the server refuses to execute anything that no longer matches it. The agent can never swap the action after the operator has seen it.
2. **Deliver.** The response carries `localUrl` + `tunnelUrl` (signed, unguessable token — same discipline as private-view links). The agent sends the link to the operator's channel. One link = one decision.
3. **Decide.** The operator opens the page on any device. It shows: the plain-English description, the structured action (human-rendered, not raw JSON-first), the staging agent's identity, the freeze hash, and the expiry countdown. Two buttons — **Approve** / **Deny** — plus the **PIN field**. The PIN is the authorizer; the link alone grants nothing.
4. **Execute.** On Approve + correct PIN, the server executes the frozen action **server-side** (the operator's browser never needs the Bearer token), records the outcome on the request, and notifies the staging context (topic message + the approval row). On Deny, the denial + optional reason is recorded and the agent is told. Either way the token is consumed — a second open shows the terminal state, not the form.

### Security invariants (each one is a test)

- **Requester ≠ authorizer, preserved end-to-end.** Bearer can stage; ONLY the PIN can decide. `POST /approvals/links/:id/decide` runs the same `checkMandatePin`-class verification (timing-safe hash compare, per-IP attempt limiting, never stored).
- **Frozen action.** The executed call is byte-identical to what was staged and shown (hash verified at decide time). No parameterization at decision time, ever — a "but just change the amount" need is a NEW link.
- **One-time + expiring.** Default 15 minutes (configurable per request, capped at 24h). Consumed on first decision. Expired links render an honest "expired — ask the agent to re-stage" page.
- **Action allowlist, deny-by-default.** Only routes explicitly registered as approval-executable (an `APPROVAL_EXECUTABLE` registry mapping kind → route pattern + bounds validator) can be staged. Staging an unregistered action is refused at creation. The registry starts minimal: mandate grants, mandate issuance, a config-flag flip class. Growth requires a code change (reviewed), never runtime registration.
- **No self-execution.** The execution path runs under a distinct internal principal ("operator-via-approval-link:<id>") recorded in every audit trail the action touches — an approval-executed mandate grant lands in the MandateAudit with that provenance, not as the agent.
- **Bounded notification surface.** Links ride existing topics (or the system topic); staging NEVER creates a new Telegram topic. Re-sends are deduped.

### Explicitly out of scope (v1)

- Multi-step approvals, partial approvals, counter-proposals (a deny + a new staged link covers these).
- Delegated approvers / multiple PIN holders (the dashboard PIN is the single operator key today; multi-operator is its own spec).
- Standing approvals ("always allow X") — that is what mandates are for; links are one-shot by design.

### Touchpoints

- `src/server/` — routes (`POST /approvals/links`, `GET /approvals/links` (Bearer, list/status), the public decide page + `POST .../decide`), the executable-action registry, the page template (Secret Drop's renderer pattern).
- Durable store (`state/approval-links.json` or SQLite alongside PendingRelayStore) — links must survive restarts; a decided/expired record is retained for audit (bounded retention).
- `CapabilityIndex`, CLAUDE.md template + migration ("when you need the operator to authorize something ad-hoc, stage an approval link — never a command, never a raw API walkthrough"), dashboard visibility (an Approvals card listing pending links).
- Token-Audit Completeness: no LLM calls in the core flow (deterministic); any future LLM-rendered description carries attribution.

### Open questions for convergence

1. Should the decide page require the PIN for DENY too? (Lean: no — denial is safe-direction; but an unauthenticated deny lets a link-intercepter kill a legitimate approval. Lean revised: PIN for both, since the link may leak.)
2. Where does the executable-action registry live so the conformance audit can see it as this standard's ratchet?
3. Does Approval-as-Data (the existing `/approvals` decision-recording system) subsume the record, or does each link mirror into it? (Lean: every decided link auto-records an Approval-as-Data row — one memory, two entry points.)
4. Tunnel-down behavior: links die with the tunnel; should staging warn when no public URL is available and fall back to dashboard-resident pending approvals?

## Acceptance sketch

The floor-grant scenario, replayed end-to-end with zero laptop: agent stages "Grant Mia prod-deploy for 1 hour" → operator taps the Telegram link on a phone → reads the plain-English action → types PIN → Approve → the grant exists in the mandate (audited with approval-link provenance) → the agent's watcher sees it and proceeds — and the staged action hash shown on the page matches what executed.
