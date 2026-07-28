# Side-Effects Review — Blocker Ledger (Autonomy Principles Enforcement, Piece 1)

**Version / slug:** `blocker-ledger`
**Date:** `2026-06-10`
**Author:** `echo`
**Second-pass reviewer:** `code-reviewer subagent (see below)`

## Summary of the change

Adds the **Blocker Ledger** — the resolution-workflow + memory layer that COMPLETES Principle 1 of `docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md`. The detection half (deferral-detector hook, B16_UNVERIFIED_WALL, B17_FALSE_BLOCKER) already exists; this is the missing resolution half. A detected false-blocker becomes a gated pipeline (`candidate → authority-checked → access-requested → dry-run → live-run → terminal`) with structural evidence-of-work at every terminal, built so the memory can NEVER become a deferral-laundromat. Ships **DARK** behind `monitoring.blockerLedger.enabled` (default false → routes 503).

Files: `src/monitoring/BlockerLedger.ts` (new — store + state machine + CAS + archival + audit), `src/monitoring/blockerSettleAuthority.ts` (new — the Tier-1 B17 settle authority), `src/server/routes.ts` (5 `/blockers*` routes + RouteContext field), `src/server/AgentServer.ts` (gated construction + routeCtx thread), `src/core/PostUpdateMigrator.ts` (deferral-detector auto-open trigger in the always-overwritten built-in hook), `src/config/ConfigDefaults.ts` (dark default), `src/core/types.ts` (config type), `src/scaffold/templates.ts` (CLAUDE.md awareness block). Tests: unit (35) + integration (7) + e2e (4).

## Decision-point inventory

- `BlockerLedger.advance()` — **add** — gated linear-transition validator (refuses skips). Brittle/structural by design; carries NO message-blocking authority.
- `BlockerLedger.settle()` (resolved) — **add** — structural evidence validator (confined playbook path, id-reference, successful live-run). Structural, no message authority.
- `BlockerLedger.settle()` (true-blocker) — **add** — the one JUDGMENT in the feature. The field checks gate the FORM of evidence; the judgment routes to `blockerSettleAuthority` (Tier-1 LLM, B17 pattern). This is the signal-vs-authority crux.
- `deferral-detector` hook — **modify** — adds a best-effort, non-blocking auto-open POST to `/blockers` on the inability/false-blocker shape. The hook's existing checklist injection is unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The ledger has **no outbound-message block/allow surface** — it never holds a message. Its only refusals are at its own `/blockers*` API edge (rejecting an advance that skips a state, or a settle whose evidence is incomplete). Those refusals are *intended* and reversible (the caller gathers the missing evidence and retries). A possible over-refusal: the `resolved` confined-path check rejects a legitimate playbook authored outside the configured `confinedPlaybookRoots` (default: `.claude/skills`, `<stateDir>/playbooks`, `.instar/playbooks`). Mitigation: the roots are constructor-configurable; the error message names the constraint. This is a deliberate safety bound (no arbitrary-path write target), not an accidental over-block.

---

## 2. Under-block

**What failure modes does this still miss?**

The free-text evidence fields (`detectedText`, `rebuttal`, `failedAttempt.detail`) are bounded + enveloped but their *truthfulness* is not verifiable by the ledger — an agent could record a plausible-but-fabricated "vault miss". This is mitigated, not eliminated: the true-blocker settle still routes through the B17 LLM authority, which is prompted to refuse a vague/untried rebuttal, and the self-fetch-first mandate requires the *form* of a failed self-fetch. The ledger's claim is "harder to launder," not "impossible to lie to." The D6 re-walk (re-test on a cadence, require NEW evidence) is the backstop. Noted as an accepted residual.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The ledger is a **detector/recorder** (low-level, structural) for everything except the one true-blocker settle judgment, which is correctly delegated UP to an **authority** (the LLM-backed `blockerSettleAuthority`). It does not re-implement the deferral-detector or B16/B17 — it *feeds off* them (the auto-open trigger) and *routes the settle through* B17. The CAS/atomic-write reuses the `CommitmentTracker` pattern; the audit-jsonl reuses the `SessionReaper` pattern; the dark/503 gate reuses the `growthMilestoneAnalyst` pattern. No parallel re-implementation of an existing primitive.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] **No — this change produces a signal consumed by an existing smart gate** (for the message surface: the ledger never blocks a message; B16/B17 keep that authority), **AND** the one judgment it does carry (the true-blocker settle) is a **smart gate with context** (`blockerSettleAuthority`, an LLM authority that fails CLOSED).

The brittle field checks in `settle()` gate only the FORM of evidence (taxonomy membership, presence of a failed-attempt record, temporal ordering). They do NOT make the settle decision — that is the LLM authority's. A settle with perfect-form evidence still DENIES if the B17 authority judges it a false blocker. No brittle check owns the judgment. Compliant.

---

## 5. Interactions

- **Shadowing:** None. The `/blockers*` routes are new and additive; they do not sit in front of any existing route. The deferral-detector change appends after the existing checklist `process.stdout.write` — it cannot shadow or alter the checklist (verified: checklist is written first, then the fire-and-forget POST).
- **Double-fire:** The auto-open fires once per inability-match hook invocation. A blocker could be opened multiple times across multiple messages (no dedup in v1) — acceptable; entries are cheap and the list is paginated/archived. Noted as a known v1 characteristic, not a defect.
- **Races:** All ledger mutations serialize through one in-process chain (`mutate()`), reloading from disk before each apply — a cross-process write is picked up, not clobbered. Concurrent-open test proves 20 parallel opens produce 20 unique ids with no lost increment.
- **Feedback loops:** The deferral-detector → /blockers auto-open is one-directional; the ledger does not feed back into the hook. The B17 authority consumes ledger free-text only inside the data envelope (no instruction-injection feedback).
- **Timing:** the deferral-detector hook now holds the process open ~200ms (bounded, global 2000ms safety-net) on inability-matches only, to flush the fire-and-forget POST. Adds bounded latency to that specific hook path; negligible and only on false-blocker framing.

---

## 6. External surfaces

- **Other agents / users:** None until `monitoring.blockerLedger.enabled` is set (ships dark → routes 503). Existing agents receive the dark default via `migrateConfig` → `applyDefaults` (idempotent, missing-key-only) and the updated deferral-detector hook via the always-overwrite built-in-hook migration.
- **External systems:** None. The ledger is purely local file-JSON + the local `/blockers` API + a local-only B17 LLM call through the agent's existing intelligence provider. No network egress beyond the agent's own server.
- **Persistent state:** Adds `state/blocker-ledger.json`, `state/blocker-ledger-archive.json`, and `logs/blocker-decisions.jsonl`. All created lazily on first write; absent until the feature is enabled AND a blocker is opened.
- **CLAUDE.md template:** new capability block (agent-awareness). Existing agents get it via the normal template-migration path; it documents the dark default honestly.
- **Dashboard:** a read-only "Blockers" tab (`dashboard/index.html`) that consumes `GET /blockers`, HTML-escapes all untrusted free-text via the existing `escapeHtml`, renders a true-blocker as a decaying hypothesis ("recheck after <date>", never "settled/stop trying"), and shows a friendly "not turned on yet" message on the 503-dark response. Additive; mirrors the `resources` tab. No mutation controls (advance/settle from the dashboard is a later phase).

---

## 7. Rollback cost

Pure additive code + a dark-by-default flag. Back-out = revert the code and ship a patch; nothing is on by default, so no agent is running it unless explicitly enabled. The only persistent state is the three lazily-created files, which are inert when the feature is off and safe to leave on disk (or delete) on rollback. No migration to undo (the config default is missing-key-only and harmless when present-but-unused). No user-visible regression during the rollback window (nothing user-visible shipped). Estimated rollback: one revert commit, zero downtime.

## Conclusion

The review produced no signal-vs-authority violation and no message-block surface. The one judgment (true-blocker settle) is correctly an LLM authority that fails closed, with brittle checks confined to evidence-FORM validation. One material build-time discovery (recorded for the user): on current `JKHeadley/main` (v1.3.479), `resolveModelForFramework` **already** handles `gemini-cli`/`pi-cli` with real models, so Piece 3's "broken foundation" premise is already fixed upstream — that is a separate PR's concern and does not affect this one. The design change made *during* this build (vs the converged spec): the true-blocker settle evidence (failedAttempt + accessRequest, each timestamped) is carried in the settle call and validated `accessRequest.at >= failedAttempt.at`, **decoupled** from the linear pipeline's `access-requested` state — because the pipeline orders `access-requested` (state 3) before `dry-run` (state 4), which conflicts with the true-blocker requirement that the ask come AFTER the failed attempt. This is faithful to the spec's *intent* (ask-after-trying) while resolving an ordering contradiction the spec didn't catch. Clear to ship as PR 1.

---

## Second-pass review (if required)

**Required** (touches a gate + server lifecycle). An independent reviewer subagent audited the artifact + code adversarially.

**Independent read of the artifact: concur.**

> Concur with the review. The one judgment (true-blocker settle) routes through the LLM authority (`buildB17SettleAuthority`), which fails closed on no-provider / provider-error / unparseable-verdict; every brittle check gates only the FORM of evidence and holds no settle authority; the message surface is never touched (the deferral-detector hook emits `decision:'approve'` unconditionally before the fire-and-forget auto-open, fully wrapped). Verified: no-skip state machine, `resolved` requires a successful live-run + confined id-referencing playbook, the no-evidence re-settle counter is persisted via `mutate()` BEFORE the throw (survives), single-writer CAS closes the TOCTOU by re-finding inside the final commit after the async authority call, and the feature is ALIVE when enabled / DARK (503) when disabled. `tsc` exit 0; 46 tests pass.

Two nice-to-haves the reviewer flagged, both addressed/accepted:
- The `toLlmSafeEnvelope` close-tag regex was tightened to tolerate whitespace/attributes (`</blocker-ledger-data >`) — **applied** this pass.
- `escapeHtmlForDashboard` was "exported but unused" at review time — now **wired** by the dashboard "Blockers" tab added this pass (all untrusted text escaped before render).

---

## Evidence pointers

- Unit: `tests/unit/BlockerLedger.test.ts` (28), `tests/unit/blockerSettleAuthority.test.ts` (7) — gated state machine, both terminals, self-fetch-first mandate, anti-laundering re-walk + escalate-after-N, injection-envelope, concurrency, archival, fail-closed authority.
- Integration: `tests/integration/blocker-ledger-routes.test.ts` (7) — 503-dark, 200-alive, X-Instar-Request 403, full create→advance→settle over HTTP, audit line with origin + gate hash.
- E2E: `tests/e2e/blocker-ledger-lifecycle.test.ts` (4) — production-path "feature is alive" (200 not 503), dark-by-default, persistence across restart.
- `npx tsc --noEmit` exit 0.
