# Side-Effects Review — Readiness authority approval from the dashboard

**Version / slug:** `feedback-readiness-authority-card`
**Date:** `2026-09-30`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The operated feedback drain on the Mac Studio is live-healthy with 1,001 unprocessed reports, but every tick 403s ("current registered readiness agent required"). The readiness authority can only be registered through the PIN-gated `POST /feedback-factory/readiness-authorities`, which has no human surface and needs a dozen technical fields. The operator (Justin, topic 95267, 2026-09-30 10:26 PDT) approved registering it with maxBatch 50 and maxDailySpendUsd 5. This change adds the operator surface:

- `src/feedback-factory/drain/readinessAuthorityProposal.ts` (new, pure): builds the record the runtime will accept. It also returns status, blockers, the Approve action and a plain summary.
- `src/core/IntelligenceRouter.ts`: new read-only `previewPrimary()` that mirrors `evaluateRouted`'s primary selection.
- `src/server/routes.ts`: new `GET /feedback-factory/readiness-authorities/proposal` (Bearer, read-only); `useProposal: true` on the existing PIN route makes the server fill the binding fields.
- `src/server/AgentServer.ts`: exposes `authorityBinding()`, the owner machine and epoch that `canAgentMutateReadiness` compares.
- `dashboard/feedback-readiness-authority.js` (new) + `dashboard/index.html`: the card on the Feedback Drain tab.
- CLAUDE.md template, migration, and shadow marker for Agent Awareness.

## Decision-point inventory

- `POST /feedback-factory/readiness-authorities` authorization (PIN + X-Instar-Request + same-origin): **pass-through**. It is unchanged and still runs before any new code.
- `FeedbackDrainStore.mutateAuthority` validation: **pass-through**. The proposal mirrors its envelope bounds for display, and the store remains the authority.
- `FeedbackDrainService.canAgentMutateReadiness` and `FeedbackReadinessArbiter.decideBatch` provider/model/prompt checks: **pass-through**. Nothing loosens them; the proposal computes values that satisfy them.

---

## 1. Over-block

No new block/allow surface. The proposal's `blockers` only decide whether the card offers Approve, and the PIN route re-checks the same conditions and refuses with 409 when `useProposal` cannot build a record. One case: an operator who deliberately wants to register while no routed model exists (for example, before enabling a framework) cannot use the card. The raw-field PIN route still works for that expert path.

## 2. Under-block

- The proposal predicts the primary route. If the call later lands elsewhere (the Codex retirement self-heal reports `gpt-5.6-sol`; a failure swap to another framework), the arbiter's existing check refuses and demotes the authority to `proposal-only`. The card then shows "Paused by a safety brake" and offers Approve (replace). This is the designed fail-safe direction and is replayed in `feedback-readiness-authority-proposal.test.ts`. The operator may need to approve again after a model retirement.
- Found during this build and not fixed here: the live `Config.ts` loader drops `sessions.natureRouting`, so the Studio runs nature routing observe-only even though its config says `dryRun:false`. `previewPrimary` reads the same runtime closure, so the proposal matches the real call (codex-cli / `gpt-6-astra`). If that loader bug is fixed, the next tick after a routing change demotes the authority, and the card offers a re-approval bound to the new route. Fixing the loader would make MessageSentinel's FAST chain fail closed (pi-cli is not enabled), so it is a separate decision. It is reported to the operator in the PR summary.

## 3. Level-of-abstraction fit

This is the right layer. The server already owns the facts: the owner binding in AgentServer, routing in IntelligenceRouter, and the prompt/schema ids in the arbiter module. Computing them server-side and letting the operator choose only the envelope keeps the human decision where it belongs. `previewPrimary` sits on the router beside `for()` (the existing diagnostic resolver) instead of re-implementing routing in the route handler.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The proposal is advisory display. Authority stays with the PIN (human), the store's validation, and the arbiter's runtime checks, none of which changed.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The status→action mapping follows the store's own state machine: a revoked authority must be restored before it can be replaced, and create is refused if a record already exists.

## 5. Interactions

- **Shadowing:** `useProposal` is read only after `feedbackMutationIntentValid` passes. Revoke and restore ignore it and reuse the stored record as before.
- **Double-fire:** the card renders on tab open and after an action, not on the 15-second status poll, so a PIN being typed is never wiped. The status poll is unchanged.
- **Races:** two approvals at once are serialized by the store's `.immediate()` transaction. The second create gets 409 "authority already exists", which the card shows verbatim.
- **Feedback loops:** none. The proposal reads state and writes nothing.

## 6. External surfaces

- **Operator surface (Mobile-Complete):** this change adds the missing phone surface. It works from the tunnel URL with the dashboard PIN, and the POST is same-origin.
- Other agents and users: the new route is Bearer-only and read-only. Without the drain (fleet default) it returns 503, like its siblings.
- Persistent state: nothing new. Approvals write the same `authority_records` and `authority_audit` rows as before, with an `operatorDecisionRef` of the form `dashboard:<timestamp>:<random>`.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The card shows its title, a one-line status, the plain sentence of what is being approved, the PIN box, then Approve. The numeric limits sit in a collapsed "Adjust limits" drawer because the approved defaults (50 / $5) are prefilled.
2. **Zero raw internals as primary content?** Yes. The machine id, epoch and model appear only as a muted "Bound to:" line inside the collapsed drawer. Statuses read "Not set up yet", "Active (version 1): up to 50 reports per batch…", "Paused by a safety brake", "Revoked". No enum values are shown.
3. **Destructive actions de-emphasized?** Yes. Revoke is a plain button after the green Approve / Save new limits, never above it, and appears only when there is something to revoke.
4. **Plain language + phone width?** Plain language is checked in the UI tests. The card reuses the Spend tab's mobile-first classes: 44px tap targets, 16px inputs (no iOS zoom), full-width stacked fields. I did not take a separate phone-width screenshot of this card.

## 7. Multi-machine posture

**Machine-local by design, proxied on the owner.** The authority binds to the drain's canonical owner machine and epoch, and `authorityBinding()` reports this server's view: the configured `operatedHostMachineId` and the coordinator lease epoch. On a non-owner machine, `ownerMachineId` is still the configured owner, so a record approved there binds to the owner. The store is per machine, though, so the approval must be made on the owner's dashboard; the tick proxy already routes ticks to the owner. The card emits no user notices and generates no URLs. Its only durable state is the existing authority tables, which are already in the drain backup/restore path.

## 8. Rollback cost

This is a pure code change. Reverting removes the card, the proposal route, `useProposal` and `previewPrimary`. Records approved through the card are ordinary authority generations and keep working, and they can be revoked through the raw PIN route. No migration is needed. The CLAUDE.md section would remain in existing agents' files, pointing at a card that no longer exists, until a follow-up migration removes it by the same marker.

## Conclusion

The review changed the design in three ways. Approval uses `useProposal` (server-derived fields) rather than posting client-side copies of technical fields. The card renders outside the 15-second poll. The model binding comes from a router preview that is proven equal to the real `evaluate()` selection, rather than from the static routing map. The static map would have proposed `gpt-5.5`, a retired id that the live call never uses, and the first tick would have demoted the authority. The change is clear to ship. The natureRouting loader drop is flagged to the operator as a separate finding.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

The reviewer found no path for a Bearer-only caller to register, widen or restore. `useProposal` is read only after the PIN, origin and header checks pass, and the store's envelope bounds still apply. They confirmed that `previewPrimary` matches `evaluateRouted` on the enforced, fail-closed, no-route and category paths. They also confirmed that the binding equals what `canAgentMutateReadiness` and the tick job compare. They raised three minor points:
- Restore ignores the edited limits. Fixed: the card now says Restore brings back the last approved limits, and a UI test covers it.
- An emptied limit field turned into 0. Fixed: empty fields are omitted, so the server default applies (JS and GET), with a UI test.
- A `claude-code` subscription-path agent reports `interactive-pool` as its model, so the arbiter would pause the authority (a false pause, fail-safe). This is noted here, and it does not affect the Studio route.

---

## Evidence pointers

- `tests/integration/feedback-readiness-authority-routes.test.ts`: before approval the tick 403s; after the PIN approval it returns 202 with a succeeded run and the authority stays active.
- `tests/unit/intelligence-router-preview-primary.test.ts`: the preview equals the real `onModel` in four routing modes.
- `tests/unit/feedback-readiness-authority-proposal.test.ts`: replays the recorded live shape codex-cli/`gpt-6-astra` (Mac Studio `.instar/server-data/feature-metrics.db`, 221 rows) and the `gpt-5.6-sol` retirement-fallback shape.
- `tests/e2e/feedback-factory-drain-lifecycle.test.ts`: the route is alive on the production init path.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller is added.
