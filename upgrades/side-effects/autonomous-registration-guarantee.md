# Side-Effects Review — Autonomous-Registration Guarantee (GAP-B)

**Spec:** `docs/specs/autonomous-registration-guarantee.md` (CONVERGED 2 rounds + Part-D focused re-converge, approved:true) · P1 GAP-B
**Change:** revive an UNregistered-but-actively-working autonomous run after an age-limit reap, by injecting commitment-evidence into the reaper's existing eligibility path (Part B, DARK) + promoting the inert `recentUserMessage` KEEP-predicate to real (Part D, the one live part) + an observe-only attention surface (Part A). Part C was already shipped (#1186).

## Phase 1 — Principle check (signal vs authority)
Touches the reaper eligibility decision, so the principle applies. **No new brittle blocking authority:** Part B injects a *signal* (a fresh qualifying open-commitment) into the **existing** `evidenceEligible`/ResumeQueue authority — it never decides revival itself. Part A is observe-only (an aggregated attention signal). Part D promotes a KEEP-*predicate* (a signal ReapGuard already consults). The load-bearing safety is the **D8 agreement-invariant**: KEEP and the new eligibility compute from ONE shared `recentUserMessage` predicate, so they cannot disagree (the 2026-06-13 13-session loop came from disagreement). Compliant (`docs/signal-vs-authority.md`).

## Phase 2 — Plan
Built in `.worktrees/gapb-autonomous-registration` (rebased onto current `JKHeadley/main c41b27db5`). Decision points: the `sessionReaped` evidence wiring (gains an additive, dark, corroborated source) + ReapGuard/SessionReaper KEEP behavior (Part D un-stub). Rollback: dark by default (Part B needs explicit `enabled:true`) + revert the PR.

## 1. Over-block
The change does not block — it injects evidence to REVIVE. The inverse risk is **over-revive** (resurrecting a finished/idle run). Bounded by: the D2 qualifying filter (pending + agent-driven + this-machine + not-beacon-paused), D1 createdAt-freshness (6h), the **D8 agreement** (also needs a recent user message — a stale-per-KEEP commitment can't revive), drain-time D9 re-validation (`commitmentStillActiveForTopic` — a since-closed commitment is invalidated), the existing **resurrection cap** (≤2 resumes/24h/topic, then gives up loudly), and — decisively — Part B ships **DARK** (no injection ⇒ no revival) until `enabled:true`.

## 2. Under-block
A genuinely-working unregistered run with **no open commitment AND no recent user message** is not revived — the structural registration guarantee (make "go autonomous" always write the state file) is the root fix, an explicitly tracked follow-up (Follow-ups section), not this PR. Part B is a *corroborated* backstop (commitment + recent activity), not a universal catch.

## 3. Level-of-abstraction fit
Correct layer. The evidence feeds the **existing** `evidenceEligible`/ResumeQueue authority (no parallel revival path; no new WorkEvidence enum value — reuses `build-or-autonomous-active` + a distinct reason tag). Part D shares ONE predicate across all consumers (`gapBCommitmentEvidence.recentUserMessageFromHistory`), so KEEP and eligibility are computed identically — the right place to enforce agreement.

## 4. Signal vs authority compliance
See Phase 1. No brittle check gains blocking authority. Part B = signal → existing gate; Part A = observe-only; Part D = a shared predicate. Fail-open throughout (D7). Compliant.

## 5. Interactions
- **The D8 loop-prevention** is the central interaction: ReapGuard's KEEP (`ReapGuard.ts:149`, 8h) and the new eligibility both call the same `recentUserMessage` — verified by the anti-loop regression test (a stale-per-KEEP commitment is NOT eligible).
- **Part D un-stubs FIVE live sites consistently** via one shared closure spread into the single `reapGuardDeps` object backing BOTH `ReapGuard` (:137 standalone 30min, :149 commitment 8h, :221/:239 terminate-path) AND `SessionReaper` (:489 `staleIdle` inversion). All safe-direction (keep-more) — none makes the reaper kill more.
- **Drain-time D9** re-checks liveness for `COMMITMENT_ACTIVE_RUN_REASON` (state-file source is untouched, routed by the distinct reason).
- No double-fire: the commitment branch is mutually exclusive with the state-file branch (PRESENT vs ABSENT).

## 6. External surfaces
- Part A: ONE aggregated attention signal (`unregistered-autonomous:<topic>`, dedup'd via the existing chokepoint) — only when Part B fires LIVE. No new HTTP route.
- Reap-log gains an optional `evidenceSource` field (additive, back-compat, no PII — D3).
- Observable via the existing reap-log; dark by default so no user-visible behavior change until enabled.

## 7. Multi-machine posture
**Machine-local by design.** Part B's qualifying filter requires `originMachineId` is this machine or absent — a *replicated peer* commitment is advisory data, never revival authority (it can't revive a session on the wrong machine). `recentUserMessage` reads THIS machine's `TelegramAdapter.getTopicHistory`. No replicated/persisted state introduced; the per-topic state file source is unchanged. No generated URL, no cross-machine notice.

## 8. Rollback cost
Cheap and dark. (a) **Dark by default:** Part B is inert unless `monitoring.resumeQueue.commitmentEvidence.enabled === true`; even when armed it defaults to `dryRun:true` (no spawn). (b) **The one live change** (Part D `recentUserMessage` promotion) is safe-direction (keep-more) and bounded by the window — to revert just that, restore the stub. (c) **Full back-out:** revert the PR — additive code, no data migration, no state repair. The config keys are code-defaulted (absent from ConfigDefaults) so removal is clean.

## No-deferrals (Phase 4.5)
The structural registration guarantee (root fix) and the stopGate per-topic plumbing are explicitly **tracked** follow-ups (Follow-ups section, `<!-- tracked -->` markers) — Part B is a deliberate *corroborated backstop*, the honest scope, not a partial fix papering over the root.

## Phase 5 — Second-pass review
*(appended below)*
**Concur with the review.** An independent reaper-class reviewer verified the load-bearing safety against the real code (file:line), not the artifact:
- D8 agreement: the SAME closure `recentUserMessageShared` backs both GAP-B eligibility (`gapBCommitmentEvidence.ts:150`) and ReapGuard's commitment KEEP (`ReapGuard.ts:149`/:239), with a single-sourced window (`staleCommitmentWindowMinutes ?? 480`); GAP-B's `commitmentQualifies` is a strict superset-filter of ReapGuard's, so a GAP-B revive structurally implies KEEP would have fired — the 2026-06-13 loop is impossible.
- Dark containment airtight: armed only on `enabled===true`, dryRun-default-true; dryRun fires the Part A surface only, tags/injects nothing; disarmed skips the cost-bearing eligibility entirely.
- All 5 `recentUserMessage` sites (ReapGuard 137/149/221/239 + SessionReaper 489) consume the real shared predicate (stub at server.ts removed); tsc-clean proves no mismatch; all safe-direction (keep-more).
- Fail-open (D7) + D9 drain-revalidation verified both sides (`safeBool(..., true)` → throw resolves still-active, never a wrong drop); multi-machine strand closed by the `originMachineId` local-origin filter.
- No new failure mode, double-fire (commitment vs state-file branches mutually exclusive), or cross-machine revival risk.
