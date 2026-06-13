# Side-effects review — Operator Authorization Request

Spec: `docs/specs/OPERATOR-AUTHORIZATION-REQUEST-SPEC.md` (converged 3 rounds / 6 reviewers, approved).

## Summary of the change

Adds an **Authorization Request** primitive: the agent (Bearer) pre-fills a structured request to grant a user a floor action; the operator approves it with their dashboard PIN on a dead-simple "Approvals waiting for you" card; on approval the server issues the grant via the EXISTING signed `MandateStore.issue()` path. Replaces the raw-JSON "build a mandate by hand" form as the primary surface (it is demoted behind an "Advanced" disclosure). Ships dev-enabled / fleet-dark (`resolveDevAgentGate`, `enabled` omitted from ConfigDefaults).

## Decision-point inventory

The only new authority-conferring decision point is the PIN-gated `POST /authorization-requests/:id/approve`. It routes through the existing signed `MandateStore.issue/addGrants` — it does NOT introduce a new authority primitive, modify the MandateGate deny-ladder, the GrantStore read path, or the SlackPermissionGate evaluate-path.

## 1. Over-block
Could a legitimate operator be blocked from approving? The approve route is PIN-gated with the existing rate-limited `checkMandatePin` (5/5min per IP). A locked-out operator self-heals after the window. The feature is additive — if its store is unreadable the routes 503 and the existing manual mandate/grant path is unaffected. No new over-block on existing flows.

## 2. Under-block
Could an agent get authority it shouldn't? No. A pending request confers ZERO authority (inert). The grant issues ONLY inside the PIN-gated approve, via the existing signed path — requester ≠ authorizer is preserved and the agent can never approve its own request (no PIN). The proposable floor-action allowlist EXCLUDES `grant-authority` (the meta-escalation stays manual). The grantee must resolve to a registered principal at create AND approve (rejects phantom/sybil ids).

## 3. Level-of-abstraction fit
A new primitive at the right layer: it is an operator-friendly FRONT DOOR to issuing a grant, built atop the proven mandate read/issue path (one-carrier-per-grant, `meta.carrier:true`, operator-invisible). Not a parallel authority store.

## 4. Signal vs authority compliance
The PIN-gated approve is a legitimate human authority chokepoint (the operator sees the named person + plain-language action and decides). No automated trust-policy gate is layered on top (that would re-introduce brittle blocking authority on a human authority). Foundation note: the SlackPermissionGate `FLOOR_ACTIONS` enum-as-authority (flagged 2026-06-09) is inherited UNCHANGED and explicitly NOT worsened — recorded in the spec's Foundation Audit; resolving it is a separate spec.

## 5. Interactions
- MandateStore: approval issues a fresh per-grant carrier mandate (expiry == grant expiry); revoking one never affects another; hourly prune bounds the `activeGrant` hot-path scan.
- SlackPermissionGate: unchanged — `activeGrant` returns the issued grant and the gate flips refuse→allow with no gate change.
- Manual issue form: demoted behind "Advanced", still functional for the rare agent-pair credential/code-review case.

## 6. External surfaces
- HTTP: 6 new `/authorization-requests` routes (Bearer for propose/list/withdraw; PIN-gated for approve/deny). 503 when the feature is off.
- Dashboard: a new "Approvals waiting for you" section + the demoted manual form (`dashboard/index.html`, `dashboard/mandates.js`).
- Audit: every issued grant lands in the existing hash-chained `MandateAudit`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
The change touches operator surfaces (`dashboard/index.html`, `dashboard/mandates.js`). Answering the quality question in writing:
1. **Leads with the primary action?** YES — the "Approvals waiting for you" card renders open at the top of the tab with Approve as the primary, always-visible button; the destructive/advanced paths are below and collapsed.
2. **Exposes zero raw internals as primary content?** YES — the card shows only a server-authored plain-language sentence ("Let Mia deploy to production for 1 hour.") + an optional escaped secondary reason. No JSON, fingerprints, slugs, or the carrier mandate. The raw-JSON authorities editor is demoted behind "Advanced — author a mandate by hand".
3. **De-emphasizes destructive actions?** YES — Decline is a quiet secondary button; there is no destructive primary.
4. **Plain language at phone width?** YES — single-column cards, real tap targets, plain sentences; no horizontal scroll.

## Agent Proposes, Operator Approves (the new standard)
The change touches an authorization/approval surface, so it answers the agent-proposes/operator-approves + display-integrity question:
1. **Does the operator APPROVE a pre-filled request rather than construct one?** YES — the agent supplies only structured fields; the operator reads one sentence and taps Approve. They never assemble a mandate, pick enums, or edit JSON.
2. **Is the authority statement SERVER-authored, not agent free-text?** YES — `renderAuthorizationCard` builds the headline from the structured proposal + the registry display name; the agent's optional `reason` is carried as a clearly-secondary, escaped note and can never become the headline. A unit + integration + e2e test each assert a malicious `reason` never appears as the authority. This closes the deceptive-summary class.

## 7. Multi-machine posture (Cross-Machine Coherence)
The AuthorizationRequest store is **machine-local by design** (the grant it issues lands in the holder's machine-local MandateStore). Each request stamps `createdOnMachine`. The pending-approval card on a NON-holder machine shows "Asked on <machine> — open that machine's dashboard to approve" instead of a dead Approve button (no silent cross-machine hole). Documented in FD-6.

## 8. Rollback cost
Clean. The feature is dev-gated: setting `monitoring.authorizationRequests.enabled:false` (or fleet default) routes every route 503; nothing else changes. Disabling mid-flight leaves pending requests inert (they confer nothing) and any already-issued grants stand as normal mandate grants (revocable via the existing path). No migration to unwind (no `migrateConfig` entry; the dashboard serves from the package dir).

## Conclusion
Loss-reducing + additive. The single safety invariant (requester ≠ authorizer; PIN-only authority) is preserved and strengthened (server-authored display). Ships dark-on-fleet behind the dev gate.

## Evidence pointers
- Spec + convergence report: `docs/specs/OPERATOR-AUTHORIZATION-REQUEST-SPEC.md`, `docs/specs/reports/operator-authorization-request-convergence.md`.
- Tests (67 green): `tests/unit/AuthorizationRequestStore.test.ts` (20), `tests/unit/operator-surface-gate.test.ts` (13), `tests/integration/authorization-request-routes.test.ts` (7), `tests/e2e/authorization-request-lifecycle.test.ts` (3), `tests/unit/lint-dev-agent-dark-gate.test.ts` (24, golden map recomputed).
- The deceptive-summary defense is asserted at all three tiers (server-authored headline ≠ agent free-text).

## Second-pass review (if required)
The spec passed 3-round convergence with 6 independent reviewers (security, adversarial, integration/multi-machine, decision-completeness, lessons-aware/foundation, scalability) — the multi-angle adversarial review that catches what a single pass misses. The round-1 CRITICAL (deceptive display) and round-2 HIGH (bounds-as-deception) were both closed before convergence.
