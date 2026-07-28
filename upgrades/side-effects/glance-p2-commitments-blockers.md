# Side-Effects Review — Dashboard glance Phase 2: Commitments rebuild + Blockers + #1428

**Version / slug:** `glance-p2-commitments-blockers`
**Date:** `2026-07-10`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required` (no block/allow, session-lifecycle, gate/sentinel/watchdog, or compaction surface — a client-side dashboard render change)

## Summary of the change

Phase 2 of the operator-approved glance rollout (topic 29836, spec `docs/specs/dashboard-ux-standard.md`, F10/F11). Three view-layer changes, all in `dashboard/*.js` + `dashboard/index.html`, plus tests — **no `src/*.ts` runtime code is touched**:

1. **Commitments full rebuild** — `buildCommitmentsGlance`/`commitmentsGlanceSpec` in `dashboard/glance.js` now fold issue #1435: an **Overdue tile** (so every headline number drills down), **count-aware pluralization** ("1 needs" / "2 need", "1 is overdue"), and a **classification fix** — a promise whose HARD deadline is past is **overdue, never "due soon"** (overdue is computed first; due-soon is taken over the remainder, so a stale beacon record a month past its deadline is no longer double-counted). Five tiles now: Open · Due soon · Overdue · Waiting on you · Quiet.
2. **Blockers rebuild** — the old ~7,000-word raw table (built with `escapeHtml`-into-`innerHTML`) is replaced by the shared glance component. New pure builders `buildBlockersGlance` / `blockerRowText` / `blockerRecordNode` / `blockersGlanceSpec`. Headline ("N things are truly stuck; K being worked") + three tiles (Truly stuck / Being worked / Resolved) that partition the ledger population; each tile drills to plain-sentence rows; each row opens the full record (state, id, origin, timestamps, terminal detail) at Layer 3. `loadBlockers()` in `index.html` rewired onto it.
3. **Subscriptions optimistic cancel (issue #1428)** — a confirmed cancel (2xx) now drops a short-lived `cancelled` transient that suppresses the still-cached pending-login and rebuilds the cell AT CLICK TIME (no ~40s stale window). `purgeTransients()` clears it on the very next poll, so the poll stays authoritative if the cancel actually failed.
4. **Conformance ratchet** — `blockers` moved from `GLANCE_GRANDFATHERED` to `GLANCE_ADOPTED_TABS`; `GLANCE_GRANDFATHERED_CEILING` lowered 25 → 24. The ratchet only shrinks.

## Decision-point inventory

- **Commitments overdue-vs-due-soon classification** (`buildCommitmentsGlance`) — *modify* — overdue now takes precedence; pure derivation from existing server fields, no new authority.
- **Blockers state → tile bucketing** (`buildBlockersGlance`) — *add* — pure classification of the `/blockers` ledger population into working / stuck / resolved; no new authority, no new endpoint.
- **Subscriptions cell state derivation** (`buildMatrixModel`) — *modify* — a `cancelled` transient suppresses a stale cached pending-login; a display-only override cleared each poll.
- No block/allow, message-filter, or dispatch decision point is touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The classification changes decide which *tile* a record appears under (display grouping), never whether a record is admitted or an action allowed. A commitment/blocker is never dropped: the Commitments population is unchanged (`beaconEnabled && status==='pending'`), and the Blockers tiles partition the full `/blockers` population (a test asserts the tile counts sum to the population length — nothing is filtered out).

---

## 2. Under-block

No block/allow surface — under-block not applicable. Worst case for the #1428 optimistic reset is a *display* lag, not a missed block: if a cancel POST returns 2xx but the server actually failed to cancel, the `cancelled` transient hides the flow for at most one poll cycle, then `purgeTransients` clears it and the fresh pending-login re-renders the in-flight flow (poll is authority). A pasted code during that window still hits the submit route's existing pane-liveness guard (the dangerous half was already closed per #1428) — this change does not touch that guard.

---

## 3. Level-of-abstraction fit

Correct layer. All logic is a **stateless client-side renderer** deriving display from data the tab already fetches — the lowest-risk layer for a UX change. It reuses the shared `dashboard/glance.js` component (built in Phase 1) rather than re-implementing per-tab markup, and reuses the shipped `sanitizeForDisplay` + `hasOpenInteraction` primitives. No server route, config, or gate is added or changed; the Blockers glance drills into the existing `GET /blockers`, the Commitments glance into the existing `GET /commitments`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It is pure presentation: it renders records into a headline + tiles + drill-downs. It holds no authority over any action, message, or session. The `cancelled` transient is a display hint that self-clears on the next authoritative poll — it never decides an outcome.

---

## 5. Interactions

- **Shadowing:** The Commitments/Blockers glances replace the tabs' own prior renderers (the old blockers table + its now-removed `blockerStateBadge`/`blockerTerminalLine` helpers were deleted; no other caller referenced them — verified by grep). No server-side check is shadowed.
- **Double-fire:** None. `loadBlockers`/`loadCommitments` are idempotent renders triggered by tab activation + Refresh; `renderGlance` replaces (never appends) the DOM, so repeated renders can't leak detached nodes/listeners.
- **Races:** The `cancelled` transient shares `state.matrixTransient` with the existing poll loop. It is set after the cancel POST resolves (server has processed the cancel), read by `buildMatrixModel`, and cleared in `purgeTransients` — which runs inside `render()` only after a *fresh* `/pending-logins` fetch succeeds (a fetch failure early-returns before `render()`), so clearing it always hands authority to real server state. The F9 hold (`data-interaction-open`) is respected: the optimistic rebuild removes the cell's own hold first, and `rerenderMatrixFromCache` still skips while any OTHER interaction is open (the status line is the fallback there, and the next poll catches up).
- **Feedback loops:** None.

---

## 6. External surfaces

- **Other agents / other users:** None — a client-side render change shipped in the package `dashboard/` directory (served via `express.static`), reaching deployed agents on the normal update path (no `PostUpdateMigrator` entry needed, same as Phase 1).
- **External systems:** None.
- **Persistent state:** None — the glance persists nothing; `matrixTransient` is in-memory dashboard state only.
- **Operator surface (Mobile-Complete):** The Commitments "Mark delivered" action is preserved and phone-completable at Layer 3. The Blockers tab is read-only (as before). The Subscriptions cancel/sign-in flow is unchanged except that a confirmed cancel now resets the cell faster. No new operator action is introduced without a surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Touches `dashboard/glance.js`, `dashboard/index.html`, `dashboard/subscriptions.js` — REQUIRED, and it is the whole point of the change.

1. **Leads with the primary action?** Yes. Both tabs now open on a one-sentence plain-English headline + big labeled tiles — the answer ("where do my promises / blockers stand?") is the first thing rendered, not a wall of records. The old Blockers page-one was a ~7,000-word raw table; it is gone from Layer 1.
2. **Zero raw internals as primary content?** Yes, and enforced. The F10 validator scans the concatenated headline + every tile label + value and refuses to build a glance carrying internal IDs, cadences, config keys, or insider terms. Raw internals (id `BLK-004`, `cadence 1800s`, state slugs, recheck timestamps) live only at Layer 3, one or two taps down. Verified live in-browser: the Commitments headline reads "I'm carrying 5 open promises; 1 needs attention soon, 1 is overdue."; the Blockers headline reads "1 thing is truly stuck right now; 2 are being worked."
3. **Destructive actions de-emphasized?** No destructive action is added. "Mark delivered" (Commitments) is a constructive Layer-3 action; the Blockers tab is read-only. The Subscriptions Cancel affordance is unchanged in prominence.
4. **Plain language + phone width?** Labels read the way a non-engineer speaks ("Truly stuck", "Being worked", "Due soon", "Overdue"). The glance uses the shared responsive `.glance-*` CSS shipped + browser-verified in Phase 1 (flex tiles, `overflow-x` contained). No new bespoke inline styles. State words at Layer 3 are humanized ("Truly stuck for now (recheck scheduled)", never a raw `true-blocker` slug at the glance). The decaying-hypothesis framing is preserved — a true-blocker is "best current understanding … not 'give up'", never "stop trying".

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — pure client-side renderer, no machine-divergent state.** `dashboard/glance.js` persists nothing, reads no config, and holds no server state; it renders whatever data the adopting tab already fetches and inherits that endpoint's posture. The Blockers glance drills into `GET /blockers` (a per-machine ledger read, unchanged by this PR); the Commitments glance into `GET /commitments` (posture unchanged). It emits no user-facing notices (no one-voice concern), holds no durable state (nothing to strand on topic transfer), and generates no URLs. The Subscriptions matrix already reads pool-scope (`?scope=pool`) so a login started on another machine surfaces here; the `cancelled` transient is per-dashboard-session in-memory display state that self-clears on the next poll — it introduces no new cross-machine surface.

---

## 8. Rollback cost

Pure client-side code change — revert the `dashboard/*` files and ship a patch. No persistent state, no data migration, no agent-state repair. During the rollback window a user would see the previous glance/table render; no functional regression (the underlying routes are untouched). The conformance-ratchet constants revert with the file.

---

## Conclusion

The review produced no design changes and flags no concerns. The change is confined to the presentation layer, reuses the Phase-1 component and its safety contract (`sanitizeForDisplay` + `textContent`, no `innerHTML`) — which is a security *improvement* for Blockers over the old `escapeHtml`-into-`innerHTML` table — and is fully enforced by the F10 word-budget and F11 drill-down ratchets now covering both rebuilt tabs across all three test tiers, plus a live in-browser render of both tabs. Clear to ship.

---

## Second-pass review (if required)

Not required — no block/allow, session-lifecycle, gate/sentinel/watchdog, coherence, or compaction surface is touched. (This is a client-side dashboard render change; the qualifying triggers in `/instar-dev` Phase 5 do not apply.)

---

## Evidence pointers

- Unit: `tests/unit/dashboard-glance-word-budget.test.ts` (43), `tests/unit/dashboard-glance-drilldown.test.ts` (13), `tests/unit/subscriptions-render.test.ts` (+2 for #1428), `tests/unit/follow-me-controller-wiring.test.ts` (+2 for #1428 both sides of the boundary).
- Integration: `tests/integration/glance-blockers-tab.test.ts` (real `/blockers` route + BlockerLedger), `tests/integration/glance-commitments-tab.test.ts`.
- E2E: `tests/e2e/glance-blockers-tab-lifecycle.test.ts` (feature ON 200 / dark 503 / shipped-file check), `tests/e2e/glance-commitments-tab-lifecycle.test.ts`.
- Live browser render (Playwright, stubbed-route harness): Commitments headline "I'm carrying 5 open promises; 1 needs attention soon, 1 is overdue." with an Overdue tile drilling to CMT-101 (past hard deadline, classified overdue not due-soon) → Layer-3 record with cadence 1800s + Mark-delivered; Blockers headline "1 thing is truly stuck right now; 2 are being worked." with Truly-stuck drilling to BLK-004 → Layer-3 record showing "recheck after" and "not 'give up'".

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The #1435 (overdue misclassification / missing tile / grammar) and #1428 (stale cancel window) fixes are defects in runtime client-side dashboard code, not in an LLM prompt, hook, config, skill, or standards text. This change adds no self-triggered controller (the `cancelled` transient is a display hint cleared each poll, not a loop/monitor/sentinel/reaper/scheduler/recovery path that fires a restart/swap/respawn/spawn/notify/retry/kill). The recurrence of an over-budget or jargon-carrying or dead-end glance for these two tabs is now structurally refused by `validateGlanceSpec` + the F10/F11 ratchets (`tests/unit/dashboard-glance-word-budget.test.ts`, `tests/unit/dashboard-glance-drilldown.test.ts`), which render both rebuilt tabs' real builders under adversarial fixtures.
