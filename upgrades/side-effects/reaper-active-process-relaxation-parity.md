# Side-Effects Review — Reaper active-process relaxation parity (terminate honors the reaper's relaxation)

**Version / slug:** `reaper-active-process-relaxation-parity`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `reviewer subagent (required — touches a KEEP-guard / kill decision)`

## Summary of the change

`SessionReaper.evaluate()` already relaxes the `active-process` KEEP-veto for a session it has proven idle — either `cpuFlat` under pressure (`cpuAwareActiveProcessKeep`) or 8h-stale-idle whose only blocker is its own idle children, e.g. the standing MCP stack (`reapStaleIdleWithActiveChildren`, default ON). It then layers transcript-flat + positive-idle + render-stasis-through-grace before reaching `reap-pending` and calling `terminate()`. But the terminate authority (`SessionManager.terminateSession`) re-runs the **shared, un-relaxed `ReapGuard`**, which returns `keep('active-process')` again — so it re-vetoes the very reap the reaper authorized. The reap is attempted and skipped every tick forever (observed live on dist v1.3.448: **1,532× `skipped:active-process`**, 0 idle reaps; idle sessions accumulated and over-subscribed the host). This change plumbs the reaper's already-made relaxation through to the authority via a new `bypassActiveProcessKeep` opt — mirroring the existing `bypassRecoveryFlag` pattern. It lifts ONLY the `active-process` keep-reason and only when the reaper sets it (on a reap whose veto it relaxed). Files: `src/core/SessionManager.ts` (opt + bypass), `src/monitoring/SessionReaper.ts` (dep signature + `performReap` forwards the flag), `src/commands/server.ts` (dep wiring passes the opt through), plus unit/integration/e2e tests.

## Decision-point inventory

- `SessionManager.terminateSession` autonomous KEEP-guard (`src/core/SessionManager.ts:~793`) — **modify** — add a scoped bypass of the `active-process` reason when `opts.bypassActiveProcessKeep` is set; every other KEEP-guard is re-checked and still vetoes.
- `SessionReaper.performReap` (`src/monitoring/SessionReaper.ts`) — **modify** — forwards `bypassActiveProcessKeep: <reap relaxed active-process>` to `terminate()`. The flag is `evaln.cpuTightened || evaln.staleIdleRelaxed`.
- `SessionReaperDeps.terminate` signature — **modify** — accepts an optional `{ bypassActiveProcessKeep }` third arg.
- `ReapGuard` itself — **pass-through** — unchanged; the relaxation stays in the reaper (the component holding the per-tick idle proof), and the authority is told the decision rather than re-deriving it.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None new — this change *removes* an over-block (the reaper's own authorized reap was being rejected). It does not reject anything that was previously allowed: the bypass only ever lifts a veto, never adds one.

---

## 2. Under-block

**What failure modes does this still miss / could the bypass let a working session through?**

The risk is over-reaping a session that *looks* idle but is doing real work via a child process. This is bounded by the conditions that must ALL hold before `performReap` sets the flag: (a) the reaper relaxed active-process only via `cpuFlat` (descendants below the CPU-active floor under pressure) or `staleIdle` (no user message in 8h); AND (b) the stateful proofs still cleared — transcript did not grow this tick, the pane is positively idle (ready prompt, no working footer), and the frame was byte-static across the full grace window (a frame change aborts the reap). A session genuinely working would grow its transcript or render a working frame and be KEPT. And the worst case is recoverable: a reaped session's conversation persists in its transcript and resumes via `claude --resume` on the next message. Residual miss: a child doing real work that produces NO pane render and NO transcript growth for 8h while the user is silent — extremely narrow, and resumable if it ever occurs.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The relaxation DECISION needs the per-tick observation state (CPU delta, transcript-growth, frame-stasis, candidacy clock) that only `SessionReaper` holds — so it correctly stays there. The terminate AUTHORITY (`SessionManager`) is the right place to enforce the guard for *other* killers, but it has no per-tick state and cannot re-derive the relaxation; so the reaper TELLS it the decision via an explicit, scoped opt. This is exactly the existing `bypassRecoveryFlag` contract (the recovery engine tells the authority "I already set the recovery flag; honor my kill"). The alternative — making `hasActiveProcesses` MCP-aware with a process-name allowlist — was rejected: it is brittle (allowlist drift), changes a shared primitive used by `McpProcessReaper`, and is unnecessary because the existing `staleIdle`/`cpuFlat` relaxations already identify the case correctly.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no NEW block/allow surface; it lifts an existing veto in a scoped, explicit case.

The change does NOT add brittle blocking authority. It removes an over-broad veto in a specific, well-evidenced case. The default (no flag) leaves the `active-process` veto fully intact — fail-safe toward KEEP. The bypass is opt-in per call and only the reaper (which has already produced strong idle evidence) sets it. An arbitrary killer calling `terminate()` without the flag still gets the full veto. No new heuristic owns a kill decision; the existing reaper pipeline (which already had the relaxation) simply has its decision honored end-to-end.

---

## 5. Interactions

- **Shadowing:** The bypass is evaluated alongside `bypassRecoveryFlag` in the same `bypassThis` expression; they are independent (different keep-reasons). No shadowing — each only lifts its own reason.
- **Double-fire:** None. `performReap` is the single idle-reap call site; the topic-moved-closeout path keeps its plain 2-arg `terminate()` call (no bypass) and is unaffected.
- **Races:** The reaper's two-phase (mark-reaping → grace → terminate) and the in-flight lock in `terminateSession` are unchanged. The bypass is read inside the existing guarded section; protected/lease/CAS/in-flight all still apply.
- **Feedback loops:** None. Reaping an idle session frees resources; it does not feed back into the reaper's inputs for other sessions.

---

## 6. External surfaces

- **Other agents / users:** Behavior change is internal to one agent's session lifecycle. Across the install base, idle sessions whose only blocker was their standing MCP stack will now actually be reaped once 8h-stale (or CPU-flat under pressure) — the intended fix. Conversations are preserved (resume on next message), so the user-visible effect is "idle topics get cleaned up; they resume seamlessly when next messaged."
- **External systems:** None (no Telegram/Slack/GitHub/Cloudflare surface).
- **Persistent state:** None added. The reap-log already records reaped/skipped; entries will now show `reaped` where they showed `skipped:active-process`.
- **Timing/runtime:** The reap still requires the full hysteresis + grace window; no timing assumption changes.

---

## 7. Rollback cost

Pure code change across three source files; revert and ship as the next patch. No persistent-state migration, no agent-state repair, no user-visible regression during the rollback window (reverting simply restores the prior "idle sessions kept" behavior). The new config-free behavior rides the already-shipped `reapStaleIdleWithActiveChildren`/`cpuAwareActiveProcessKeep` flags, so a precise rollback can also be achieved by toggling those without reverting code.

---

## Conclusion

The review confirmed the fix is the *minimal correct* one: the relaxation already existed and was correct; the only defect was that the terminate authority re-vetoed it. Plumbing the decision through (mirroring `bypassRecoveryFlag`) fixes the stalemate without adding any brittle heuristic or broad primitive change, and fails safe (default keeps the veto; over-reap is bounded by strong idle proofs and is recoverable via `--resume`). Clear to ship pending second-pass concurrence.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (required — touches a KEEP-guard / kill decision)
**Independent read of the artifact: CONCUR**

The reviewer independently traced all five audit axes and concurred:
- **Over-reap (safe):** `relaxedActiveProcess` is set true only when `evaluate()` assigned `cpuTightened`/`staleIdleRelaxed`, which happens ONLY inside the `blocked.reason === 'active-process'` relaxation branch; the stateful idle proofs (transcript-not-grown, positive-idle-required, frame-static-through-grace) sit strictly downstream, so there is no path where the flag is true but the session is rendering or growing. Worst case (8h-silent, no render, no transcript growth, real child work) is bounded and recoverable via `--resume`.
- **Scope (correct):** because `ReapGuard.evaluate()` returns the single first-match keep reason (ordered early-return), lifting the bypass on `active-process` cannot unmask any higher-priority guard; protected/lease/CAS/in-flight all fire outside the bypassable block.
- **Signal vs authority (compliant):** no new blocking surface — it lifts an existing veto, opt-in and fail-safe; default (no flag) preserves prior behavior exactly; exact mirror of `bypassRecoveryFlag`.
- **Wiring (correct):** the server dep closure forwards the opt; the topic-moved-closeout call deliberately omits it.
- **Tests (both sides):** flag-true reaps, flag-false / other-reason kept, real reaper↔authority agreement integration-tested.

Minor doc nit raised: ensure the referenced `docs/specs/reaper-active-process-relaxation-parity.md` exists — RESOLVED, it is added as part of this change.

---

## Evidence pointers

- Live root-cause evidence: reap-log `skipped:active-process` ×1,532 + `skipped:open-commitment` ×173; reaper-audit `reap-pending` rows for the same sessions (dist v1.3.448).
- Tests: `tests/unit/session-reaper-cpu-aware-keep.test.ts` (reaper passes the flag iff it relaxed), `tests/unit/session-manager-terminate.test.ts` (authority honors the flag, scoped to active-process only), `tests/integration/session-lifecycle-reap-wiring.test.ts` (real reaper↔terminate agree end-to-end), `tests/e2e/session-reaper-lifecycle.test.ts` (lifecycle still green). All green: 115 tests across the 7 affected suites.
