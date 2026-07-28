---
title: "Operator Authorization Request — agent proposes, operator approves (one tap)"
slug: "operator-authorization-request"
author: "echo"
status: draft
parent-principle: "Agent Proposes, Operator Approves"
eli16-overview: "operator-authorization-request.eli16.md"
review-convergence: "2026-06-13T21:35:53.667Z"
review-iterations: 3
review-completed-at: "2026-06-13T21:35:53.667Z"
review-report: "../docs/specs/reports/operator-authorization-request-convergence.md"
approved: true
approved-by: "echo (autonomous run, blanket pre-approval; Justin-commissioned 2026-06-13, topic 22367)"
---

# Operator Authorization Request — agent proposes, operator approves

## Problem statement

When the agent needs the operator to authorize something (e.g. "let Mia deploy to prod for an hour"), the only path today is the dashboard **Mandates → "Issue a new mandate"** form. That form is a defect surface (operator screenshot, 2026-06-13, topic 22367):

- It shows a **raw JSON authorities editor** (`[{"action":"exchange-read-credential","bounds":{"credentialScope":"read-only"}}]`) as primary content.
- It uses engineering jargon ("Issue mandate", "authorities", "bounds", "scope", agent "fingerprints").
- It forces the operator to **construct an agent-pair mandate from scratch** — a concept they should never need to learn — *before* they can grant a person a floor action (grants live inside `mandate.grants[]`, so with no active mandate the grant form never appears).

The operator's words: *"You should not be requiring me to create some new mandate… This should be extremely extremely simple. Users go to the UI, are directed exactly what to do, enter credentials, approve, and that's it — explained simply, no barrage of options."*

This is also the concrete reason the Slack live-test **scenario 8** stalled: the grant path was unusable, so the grant was never issued.

## Proposed design

Introduce a first-class **Authorization Request** primitive: the agent (Bearer-auth) registers a structured request; the server renders a dead-simple, **server-authored** plain-language approval card; the operator approves with their PIN; on approval the server executes the structured proposal (issues the grant via the existing signed path). The operator never sees JSON, never picks bounds, never "creates a mandate".

### Authority model preserved (this is NOT a weakening)

The single safety invariant of the mandate system — **requester ≠ authorizer; only the operator's PIN can confer authority** — is preserved and strengthened:

- The agent can only **propose**. Creating a request confers **zero** authority; a pending request is inert.
- The grant is issued **only** inside the existing PIN-gated path. `POST /authorization-requests/:id/approve` requires the dashboard PIN, verified by the existing `checkMandatePin()` (rate-limited, timing-safe, never stored). No PIN → no grant. The single PIN on the approve call covers the whole execution, **including the carrier-mandate auto-issue** — there is never a second PIN prompt.
- The server issues the grant via the **existing** signed `MandateStore.issue()` / `addGrants()` path (server-held HMAC `authProof`). The agent never gains the ability to mint or widen authority.

### The display-integrity rule (the load-bearing fix)

**The operator-facing card is authored ENTIRELY by the server from the structured proposal + trusted registry data. No agent-supplied free-text is ever rendered as the authority a person is approving.** This closes the deceptive-summary attack (an agent crafting `summary:"let Mia view dashboards"` while `proposal.floorAction:'prod-deploy'`):

- The agent supplies **only structured fields** (`floorAction`, `grantedToSlackUserId`, `durationMs`) plus one optional free-text `reason` (≤280 chars). There is no agent-supplied `bounds` in v1 (FD-15) — so every field that shapes the grant is server-rendered into the headline.
- The card's headline ("Let **Mia** deploy to production for **1 hour**") is **computed server-side** from: the human label of `floorAction` (a server-side map, e.g. `prod-deploy → "deploy to production"`), the display name resolved from the **principal registry** for `grantedToSlackUserId` (never an agent-supplied name), and the duration.
- The agent's `reason`, if present, is shown as a clearly-delimited, escaped, secondary "Echo's reason:" line, in a visually distinct region (muted/boxed), with embedded line breaks collapsed to spaces — explicitly **not** the authority statement, and never a substitute for the server headline. It cannot be laid out to read as the headline.
- `proposalSha256` content-addresses the **structured proposal** (the thing executed). Because the displayed authority is server-derived from that same structured proposal, what the operator reads and what executes cannot diverge.

### The primitive

```ts
interface AuthorizationRequest {
  id: string;                       // 'authreq-...'
  createdAt: string;                // ISO
  createdByAgent: string;           // server-stamped from the authenticated caller (audit only, never authority)
  createdOnMachine: string;         // this machine's id (multi-machine holder, FD-6)
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn';
  kind: 'user-floor-grant';         // v1 scope; closed enum
  proposal: UserFloorGrantProposal; // structured; the ONLY thing executed
  proposalSha256: string;           // content-address of `proposal`, fixed at create, re-checked at approve
  reason?: string;                  // optional agent free-text (≤280), escaped, secondary; NEVER the headline
  requestExpiresAt: string;         // pending auto-expires (24h)
  resolvedAt?: string;
  resolvedBy?: 'operator';          // only the PIN path resolves approve/deny
  resultMandateId?: string;         // the per-grant carrier mandate the grant landed on
  denyReason?: string;              // REQUIRED on deny
}

interface UserFloorGrantProposal {
  floorAction: string;              // MUST be in the proposable allowlist (FD-8) — excludes 'grant-authority'
  grantedToSlackUserId: string;     // MUST resolve to a REGISTERED principal (FD-12)
  durationMs: number;               // grant lifetime from approval; within [60_000, 86_400_000] (FD-7)
}
```

**No agent-supplied `bounds` in v1 (FD-15).** A `bounds` object would be agent-authored data that materially shapes the grant yet might not appear in the server-authored headline — reopening the deceptive-display class on a different field. v1's three structured fields (action, person, duration) fully describe the grant and are each server-rendered. Bounds are out of scope for v1; a future spec that adds them MUST server-render every authority-affecting bound into the headline.

The displayed `grantedToDisplay` is **not stored on the proposal** — it is resolved at render time from the principal registry, so it can never be agent-spoofed.

### Routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/authorization-requests` | POST | Bearer | Agent proposes (structured). Returns `{ id }`. Confers no authority. Dedup + rate-limited. |
| `/authorization-requests` | GET | Bearer | List (filter `?status=pending`). Each row carries the server-rendered card text + `createdOnMachine`. |
| `/authorization-requests/:id` | GET | Bearer | One request (with server-rendered display). |
| `/authorization-requests/:id/approve` | POST | **PIN-gated** | Operator approves → server executes the proposal atomically; marks approved. Idempotent. |
| `/authorization-requests/:id/deny` | POST | **PIN-gated** | Operator declines; `denyReason` REQUIRED. |
| `/authorization-requests/:id/withdraw` | POST | Bearer | Proposing agent withdraws its own still-pending request. |

**Create validation** (`POST`): `kind` ∈ closed enum; `floorAction` ∈ the proposable allowlist (FD-8); `grantedToSlackUserId` matches `^[UW][A-Z0-9]+$` **and resolves to a REGISTERED principal** via a FRESH registry lookup (FD-12; else 400 `unknown-user`); `durationMs` ∈ [60_000, 86_400_000]; `reason` ≤280 chars; **all unknown fields rejected at both the request and proposal level** (no `bounds` accepted in v1). `createdByAgent`/`createdOnMachine` stamped server-side, never from the body. Per-agent pending cap (FD-13) + dedup on `(createdByAgent, proposalSha256)` among pending (returns the existing id) + per-agent POST rate limit.

### Approval execution (the only authority-conferring step)

On `approve` with a valid PIN, under a per-request write lock (serialized; concurrent second approval gets the idempotent result, never a second grant):

1. Reload the request; if already `approved`, return 200 with the existing `resultMandateId` (**idempotent**); refuse if `denied`/`withdrawn`/`expired` (409) or past `requestExpiresAt` (409 `expired`).
2. Recompute `sha256(canonical(proposal))`; refuse on mismatch with stored `proposalSha256` (409 `proposal-tampered`).
3. Re-check `floorAction` is STILL in the proposable allowlist (defends against an allowlist config change while pending; 409 `action-no-longer-proposable`); and FRESH-resolve `grantedToSlackUserId` to a registered principal; refuse if it no longer resolves (409 `unknown-user`). The freshly-resolved principal name is the display the operator just saw.
4. **Issue a fresh per-grant carrier mandate** (never reuse across grants — FD-1): `MandateStore.issue()` with scope `'user-authority-grant'`, `author: 'system'`, a single self-party (this machine's fingerprint, twice), authorities `[]`, `meta.carrier: true`, and `expiresAt = now + durationMs` (exactly the grant lifetime — no separate clock to clamp).
5. `addGrants(carrierId, [{ floorAction, grantedTo: grantedToSlackUserId, authorizedBy: <operator display, FD-9>, expiresAt: now + durationMs }])` — the existing signed path. Grant expiry == carrier expiry == operator-approved duration; **no silent clamp**.
6. Mark the request `approved` (`resolvedAt`, `resolvedBy:'operator'`, `resultMandateId`), append to `MandateAudit` (grant issuance, already audited) + a request-level audit line.

`MandateBackedGrantStore.activeGrant(slackUserId, floorAction, now)` then returns the grant unchanged — the SlackPermissionGate flips refuse→allow with **no gate change**.

**Carrier lifecycle / hot-path bound (FD-1 + scalability):** because each grant has its own carrier with expiry == grant expiry, an expired grant's carrier is dead and contributes nothing to `activeGrant` (already expiry-filtered). A background sweep (hourly) revokes-and-prunes carrier mandates (`meta.carrier:true`) whose expiry passed > 7 days ago, bounding the mandate set the per-message `activeGrant` scan walks. Revoking one grant's carrier never touches another grant.

### Dashboard surface (the operator experience)

A new **top-of-tab** section "Approvals waiting for you" on the Mandates tab, rendered from `GET /authorization-requests?status=pending`, and surfaced as **one aggregated** Attention item ("N approvals waiting", never one item per request — respects the topic-flood guard). Each pending request is one card built from the **server-rendered** text:

```
┌────────────────────────────────────────────┐
│  Echo is asking for your approval            │
│                                              │
│  Let  Mia  deploy to production              │
│  for  1 hour.                                │
│  Echo's reason: hotfix for the login bug.    │   ← escaped, secondary, optional
│                                              │
│  [ Enter your PIN: ______ ]                  │
│  [        Approve         ]  [ Decline ]     │
└────────────────────────────────────────────┘
```

- Plain language only; **all text server-authored** (headline) or **HTML-escaped** (the optional reason). No JSON, fingerprints, slugs, or carrier-mandate internals.
- **Approve** is the primary, always-visible action; **Decline** is quieter; no other options. Decline prompts for a short required reason.
- **Multi-machine (FD-6):** if `createdOnMachine` ≠ this machine, the card shows "Asked on **<machine nickname>** — open that machine's dashboard to approve" instead of a non-functional Approve button (no silently un-approvable cards). The aggregated Attention item names the holder machine. Approval always happens on the holder; the request store is machine-local by design (a grant lands in the holder's MandateStore, which is already machine-local).
- Works at phone width (single column, real tap targets) per Operator-Surface Quality §5.
- The existing manual "Issue a new mandate" form is demoted **in this PR** behind an **"Advanced — author a mandate by hand"** disclosure, collapsed by default; its raw-JSON `authorities` textarea is replaced by a guided checklist of the standard authority templates with plain-language labels (raw JSON only behind a further "edit raw" toggle). [FD-3 — in-scope for this PR]

### New constitutional standard — "Agent Proposes, Operator Approves"

Add to `docs/STANDARDS-REGISTRY.md` as the **third member of the operator-surface triad** (alongside Mobile-Complete Operator Actions and Operator-Surface Quality). It is a distinct axis, not a restatement:

- Mobile-Complete asks *can the operator act from their phone?*
- Operator-Surface Quality asks *is the surface good when they act?*
- **Agent Proposes, Operator Approves asks *are they approving, or are they being made to author?***

> **Rule.** When the agent needs the operator to authorize, decide, or confer authority, the agent MUST pre-fill the complete structured request and the operator's surface MUST present it as a plain-language **approval** (approve / decline + credential), never as a construction or authoring task. A surface that makes the operator assemble, from fields the agent already knows, what the agent could have pre-filled — picking enum values, editing JSON/bounds, naming fingerprints, choosing scopes — is a defect, even if every field is individually valid. **Corollary (display integrity):** the authority statement the operator approves must be authored by the server from the structured request and trusted data, never from agent free-text — what is shown and what executes cannot be allowed to diverge. The operator's job is judgment (approve or not), never data-entry the agent could have done, and never approving a sentence the agent wrote.

Enforcement (Structure > Willpower): extend the existing `scripts/lib/operator-surface.mjs` side-effects question set with an "agent-proposes/operator-approves + display-integrity" check for any change touching an authorization/approval surface; a "no" or unjustified "n/a" blocks the commit (same mechanism as Operator-Surface Quality), with a unit test asserting the gate fires.

## Foundation Audit (one layer below this spec)

This spec builds on the **SlackPermissionGate** + **MandateBackedGrantStore**. Honest disposition of the foundation's known issue:

- **SlackPermissionGate `FLOOR_ACTIONS` enum holds deterministic blocking authority** over what counts as a floor action (flagged 2026-06-09 in the decision-surface inventory; Signal-vs-Authority concern; out of scope for this spec). **This spec does not resolve and does not worsen it:** it adds an operator-friendly front door to *issuing a grant*; the gate's evaluate-path and the enum are unchanged. The operator's PIN approval is a full-context human authority decision (they see the named person + the plain-language action), which is the *correct* tier for the judgment "should this person have this power" — so this spec routes the high-stakes call to a human authority, not to the enum. Resolving the enum-as-authority for the *classification* step ("is this message a prod-deploy?") remains a separate spec; it is explicitly out of scope here and recorded so it is not silently inherited. [Surfaced per the lessons-aware foundation-audit requirement.]
- **Carrier mandate** is a tactical reuse of the proven mandate read-path, not a new authority primitive. It is operator-invisible by construction (`meta.carrier:true`, never rendered on any operator surface) and one-per-grant (no cross-grant entanglement). Documented as tactical, not policy.

## Frontloaded Decisions

- **FD-1 (one carrier per grant, never reused).** Each approved grant gets its own fresh carrier mandate with expiry == the grant's expiry. No cross-grant reuse — so revoking one grant's carrier never affects another, and there is no expiry-clamp surprise. Bounded by the hourly carrier prune. Reversible; ships dark-on-dev.
- **FD-2 (PIN is the only authority).** Approve/deny are PIN-gated via `checkMandatePin()`; the single PIN covers the carrier auto-issue (no second prompt). Create/withdraw are Bearer-only and confer nothing. The agent can never approve its own request.
- **FD-3 (manual issue form demoted IN THIS PR, not deleted).** The raw-JSON agent-pair path stays (credential-handoff / code-review pairs are real) but moves behind an "Advanced" disclosure with a guided checklist replacing the raw-JSON authorities editor. This is Phase-1 acceptance criteria, shipped in this PR.
- **FD-4 (proposal immutability / TOCTOU).** `proposal` is content-addressed at create and re-verified at approve. To change a pending request the agent withdraws and re-creates.
- **FD-5 (posture).** Ships **enabled on developer agents, dark on the fleet** via `resolveDevAgentGate(config.monitoring?.authorizationRequests?.enabled, config)` with `enabled` OMITTED from ConfigDefaults (Maturation Path standard, `docs/STANDARDS-REGISTRY.md`). Routes 503 when off. Registered in `src/core/devGatedFeatures.ts` (`DEV_GATED_FEATURES`); the dark-gate lint golden line-map is recomputed for any ConfigDefaults insertion.
- **FD-6 (multi-machine — honest holder labeling).** The request store is machine-local by design (the grant it issues lands in the holder's machine-local MandateStore). Each request stamps `createdOnMachine`. The pending-approval Attention item follows the attention-pool merge so the operator is *told* from any machine, but the card on a non-holder machine shows "open <holder>'s dashboard to approve" rather than a dead Approve button. No silent cross-machine hole.
- **FD-7 (durations).** `durationMs` ∈ [60_000 (1 min), 86_400_000 (24 h)]; `requestExpiresAt` = createdAt + 24 h (pending TTL). 24 h is the human-supervision ceiling: a standing authority expires within a day and must be re-approved.
- **FD-8 (proposable floor-action allowlist — excludes the meta-action).** Agents may propose ONLY from `['prod-deploy','money-movement','credential-access','destructive-data','external-send']`. **`'grant-authority'` is EXCLUDED** from the agent-propose path: letting an agent propose that a human be given the power to grant authority is a meta-escalation that stays manual-only (the Advanced mandate form). Adding an action to this allowlist later requires a new spec review.
- **FD-9 (carrier author + grant authorizedBy — concrete).** Carrier `author: 'system'` (distinguishes PIN-issued grants from agent-pair delegations in the audit). The dashboard PIN authenticates "the operator" (singular — there is no per-human identity at the dashboard PIN), so the grant's `authorizedBy` = the agent's configured owner/operator display name (from `identity.json`'s owner field / config) if set, else the literal `'operator'`. This is concrete and resolvable at approve time without a per-request human-identity lookup.
- **FD-10 (deny requires a reason; bounded re-propose).** `denyReason` is mandatory (400 without it). After a deny, the same agent cannot re-propose an identical `(grantedToSlackUserId, floorAction)` for 1 h (429 `recently-denied`), preventing deny-spam. The operator card shows prior-deny context ("denied 12 min ago").
- **FD-11 (retention + atomicity).** Resolved requests (approved/denied/withdrawn/expired) are pruned after 30 days. An hourly sweep marks past-TTL pending requests `expired`. Approval is serialized per-request (write lock) and idempotent; withdraw and approve are mutually exclusive (whichever commits first wins; the loser gets 409).
- **FD-12 (registry-resolved grantee — concrete binding + sybil/phantom floor + display source).** The "principal registry" is the SAME principal resolution the SlackPermissionGate consumes: a `slackUserId` resolves to a `Principal { name, slackUserId, registered }` via the Slack adapter's user resolution (the `UserManager`/identity-resolution path that builds the gate's `Principal`). `grantedToSlackUserId` must resolve to a principal with `registered === true` at create AND via a FRESH re-resolve at approve (not a stale cache — so a rename between create and approve is reflected). `Principal.name` is the SOURCE of the displayed name (never agent-supplied) — this closes the deceptive-display vector. **Trust assumption (documented):** the display name comes from the workspace/registry profile; the operator's job at approval is to confirm the named person + action are right — if a profile name is misleading, that is the operator's judgment call to catch, exactly as it is for any human looking at a name. The operator's human PIN approval IS the trust decision; no automated trust-policy gate is layered on top (that would re-introduce brittle blocking authority on top of a human authority — Signal-vs-Authority). [Engages L15 with a principled boundary.]
- **FD-13 (flood control).** Per-agent pending cap (default 10; 429 `too-many-pending`), dedup of identical pending proposals, per-agent POST rate limit, and a SINGLE aggregated Attention item carrying the count. Across multiple agents the aggregated item still shows the total; if the global pending total exceeds 20 the dashboard surfaces a "many approvals waiting — review or dismiss" note so a multi-agent burst can't quietly bury a legitimate ask.
- **FD-14 (agent awareness + migration parity).** Routes ship in `src/` (reach existing agents via the new build). The dashboard is served from the package dir (`AgentServer.resolveDashboardDir`), so dashboard markup reaches existing agents on update with **no migration**. The CLAUDE.md template (`src/scaffold/templates.ts` `generateClaudeMd`) gains a capability + proactive-trigger entry (Agent Awareness Standard). No `migrateConfig` entry (the dev-gate flag is never persisted — the resumeQueue lesson).
- **FD-15 (no agent-supplied bounds in v1).** The v1 proposal carries no `bounds` field. Bounds would be agent-authored data shaping the grant that could escape the server-rendered headline (the deceptive-display class, relocated). The three structured fields (action, person, duration) fully describe a v1 grant and are each server-rendered. A future spec MAY add bounds ONLY if it server-renders every authority-affecting bound into the headline; until then `bounds` is rejected as an unknown field.

## Decision points touched

- Adds the PIN-gated `/authorization-requests/:id/approve` authority-conferring chokepoint — routing through the existing signed `MandateStore.issue/addGrants`, not a new authority primitive.
- Does NOT modify the MandateGate deny-ladder, the GrantStore read path, or the SlackPermissionGate evaluate-path — unchanged. This adds an operator-friendly *front door* to issuing a grant.

## Open questions

*(none)*

## Testing

Per the Testing Integrity Standard:
- **Unit** — request lifecycle; proposal canonicalization/hashing; expiry; PIN-required approve; **agent-cannot-approve**; tamper-refusal (proposalSha256 mismatch); **server-derived display ≠ agent free-text** (deceptive-summary defense: a malicious `reason` never becomes the headline); registry-resolution reject (phantom user); allowlist reject (`grant-authority` refused); one-carrier-per-grant (N approvals → N carriers, revoking one leaves others); duration bounds; deny-requires-reason + re-propose cooldown; flood cap/dedup; idempotent approve; withdraw/approve mutual exclusion; carrier prune.
- **Integration** — all routes incl. 403-without-PIN, 409-on-tampered/expired/already-resolved, 400-on-unknown-user/missing-deny-reason, the full propose→approve→`activeGrant` flow end-to-end; the aggregated Attention item.
- **E2E** — feature-alive 200-not-503 under the dev gate; full propose→approve→SlackPermissionGate refuse→allow lifecycle.
- **Wiring-integrity** — the approve route actually calls `MandateStore.addGrants`; the dashboard reads the live route; the operator-surface gate fires on an authoring-surface diff.
- Dark-gate lint golden-map update for the ConfigDefaults insertion.
