# Side-Effects Review — a local-floor install never posts success from the Actions floor

**Version / slug:** `lv-no-actions-floor-fallback`
**Date:** `2026-10-24`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** independent reviewer subagent (harness path `src/localVerify/`; see the second-pass section)
**Tier:** 1 (narrow bug fix; a revert undoes it fully). Size: 4 `src/` files, ~90 LOC changed; 3 test files, ~140 LOC added. Effort: 0 spec rounds, 1 commit attempt expected.

## Summary of the change

The `instar/local-verify` commit status is the only required check on `JKHeadley/instar` and is defined to mean "the server ran the full suite on this exact head". `FloorGate.floorFor` answered `actions` for any settings state other than `effective`, and `StatusReconciler.floorOf` answered `actions` whenever the verifier was disabled; both routed an eligible PR of a configured-local install onto the Actions MIRROR, which writes `success · actions-floor green` from GitHub Actions results. On 2026-10-25T04:08:46Z the ruleset-bypass read alone failed (`floor-settings … state: settings-unreadable, from: effective, rulesetRequiresCheck: true, classicContexts: 0, bypass: null`), the mirror posted success on eleven heads at 04:09:20Z, and GitHub native auto-merge merged five PRs (2311, 2199, 2210, 2208, 1955) whose heads had no successful local record. The `settingsReadable()` early-return guard checks only the rules + branch reads, so it did not fire.

The fix: the CONFIGURED floor decides which authority may say `success`. `floorFor` keeps an eligible PR of a configured-local install on the local floor regardless of settings state; a new `FloorGate.localHold()` names why the local floor cannot vouch (`settings-unreadable`, `awaiting-edit-a`, `awaiting-edit-b`, `bypass-not-never`), and the reconciler adds `verifier-disabled`. `ProjectionPr.hold` carries that into `projectPr`, which projects `pending · local-floor-held:<reason>` for a held local-floor PR and never consults the mirror for it. The Actions mirror remains for configured-actions installs and ineligible PRs. One audit row (`local-floor-held` / `local-floor-released`) + one signal per hold episode; `lvHooks.signal` in `src/commands/server.ts` adds a `DegradationReporter` report for that key; `GET /local-verify/status` exposes `floor.hold`.

Files: `src/localVerify/floorGate.ts`, `src/localVerify/statusProjection.ts`, `src/localVerify/StatusReconciler.ts`, `src/commands/server.ts`; tests `tests/unit/localVerify/{floorGate,statusProjection,StatusReconciler}.test.ts`.

## Decision-point inventory

- `FloorGate.floorFor` — modify — which floor's authority a PR's status is projected from. No longer depends on `state() === 'effective'`.
- `FloorGate.localHold` — add — a named, deterministic reason the local floor cannot vouch (null when it can).
- `StatusReconciler.floorOf` / `localHold` — modify / add — `verifier-disabled` is a hold on the local floor, not a fall-through to `actions`.
- `projectPr` — modify — a held local-floor PR projects `pending` with the reason named; `projectLocal` remains the only path to `success` on the local floor.
- `StatusReconciler.noteHold` — add — transition-only audit + signal (observability, no gating).
- `StatusReconciler.effectiveFloor()` / `status().floor.effective` — pass-through — unchanged (safe-merge's contract); `floor.hold` added beside it.
- Stuck-status canary — modify — a held head is not "green admissible" (coherence only; desired and observed are both `pending`, so it would not have fired anyway).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A head with a GENUINE green local record is withdrawn to `pending` for the duration of a hold, including a transient GitHub read blip (the audit shows two `settings-unreadable` episodes in the incident day, each 1–2 minutes). The record is still true during the blip; the hold is deliberately stricter than necessary so that no state short of "the local verifier vouches" can read `success`. Cost: one withdrawal post + one re-post per green head per episode, bounded by `RECONCILER_LIMITS.postsPerMinute` (30; withdrawals are exempt, re-posts queue to later passes). GitHub auto-merge simply waits. Accepted: a minute of pending beats a wrong merge.
- A configured-local install whose operator has NOT yet completed edit A (the ruleset does not require the check) now posts `pending · local-floor-held:awaiting-edit-a` instead of mirroring Actions. Because the check is not required in that state, this blocks nothing; it only stops a mirror success being stamped with the local verifier's name.
- A configured-local install whose operator deliberately disables `monitoring.localVerify.enabled` while GitHub still requires the check now blocks merges (pending) instead of letting Actions results stand in. This is the intended fail-closed rollback: the lever to let Actions decide is the CONFIGURED floor (`monitoring.greenPrAutoMerge.floor: 'actions'`), which is unchanged. Named in the release note.

## 2. Under-block

**What failure modes does this still miss?**

- `effectiveFloor()` / `GET /local-verify/status .floor.effective` still answers `actions` during a hold (reason named). `safe-merge`'s `selectSafeMergeFloor` reads that and takes its Actions path; without `--admin` (and the agent's ruleset bypass is `never`) GitHub refuses the merge because the required status is now `pending`, so the class is closed by the status. A future caller that merged on `effective === 'actions'` WITHOUT GitHub's enforcement would still be wrong; not changed here to keep safe-merge's contract stable. Named as a known residual, not deferred work: the status is the enforced authority.
- A hold flapping every pass would signal once per episode; the attention item is deduped by key server-side, so repeated episodes do not flood, but a persistent flap would churn posts. Bounded by the post budget; visible in the audit.
- Ineligible PRs (other authors, forks) still receive the mirror on a configured-local install — by spec (their merge authority was never local) and unchanged.

## 3. Level-of-abstraction fit

The projection was the right layer: it is the one pure function that decides what the required status says, and it already had the local/mirror branch. The fix moves one fact (the configured floor decides the authority) into `floorFor` — the spec's "one floor-selection function" — rather than patching the reconciler's call sites, and adds the hold as data on `ProjectionPr` so the projection stays pure and testable. No parallel gate was added; the existing `settingsReadable()` guard stays as a pass-level audit.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no NEW block/allow surface; it narrows which deterministic authority may grant `success`.

The `instar/local-verify` status already holds merge authority, and GitHub enforces it. This change removes a brittle grant path (a transient read failure → the Actions mirror → `success`) and replaces it with a fail-closed, named `pending`. The hold's audit row and signal are signals (observability), not authority. No LLM, no heuristic over content.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain is enumerable: the configured floor is one of two values; the hold reasons are the gate's finite settings states plus `verifier-disabled`. "Which authority may say success" is an invariant (the configured floor), not a judgment.

## 5. Interactions

- **Shadowing:** `projectPr`'s hold check runs before `projectLocal`; a held PR never reaches `projectLocal`, so a genuine `failure` record is shown as `pending` for the hold's duration (information briefly hidden, never a wrong grant). `refreshHeadInputs` reads check runs only for actions-floor/ineligible heads — a held local head reads none (less GitHub traffic).
- **Double-fire:** `FloorGate.refresh` still audits `floor-settings` transitions; `noteHold` audits `local-floor-held` on transition. Two rows per incident shape, different events, both wanted. The attention item is deduped by key; the DegradationReporter report fires once per signal (per episode).
- **Races:** `heldReason` is set once per pass before heads are processed; `inputsFor` (event-driven reprojection) reads the last pass's hold — consistent with how the floor was already read.
- **Feedback loops:** none — the hold does not change what the gate reads next.
- The existing `inactive` early return (`!enabled && !checkRequired()`) is unchanged; `noteHold` runs before it so a disabled verifier on a configured-local install is still audited once.

## 6. External surfaces

- GitHub commit statuses: a held head reads `pending · local-floor held · <reason>` (≤140 chars). Auto-merge waits; nothing merges on it.
- `GET /local-verify/status`: `floor.hold` added (additive; `effective`/`reason` unchanged for safe-merge).
- Attention topic: a `local-verify: local-floor-held` MEDIUM item per episode (existing hook, existing dedupe). DegradationReporter: one report per episode, feature `local-verify-status-floor`.
- Timing dependence: the hold is only as current as the last pass (≤1 min), same as the floor was.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, as the reconciler already is: only the serving-lease holder posts statuses (`safeHolds()`), so the hold is computed and audited on that one machine; the audit file and `heldReason` are per machine, and a lease move recomputes the hold on the new holder's first pass (the spec's pool-wide floor comparison on takeover remains `not-built`, unchanged). The attention item goes through the holder's `telegram.createAttentionItem` (one voice: only the holder reaches this code). No URLs generated; no durable state strands on topic transfer.

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert and ship a patch. The previous behaviour (mirror on non-effective settings / disabled verifier) returns in full.
- **Data migration:** none. The audit rows are append-only JSONL; no reader depends on them.
- **Agent state repair:** none. Statuses re-project on the next pass.
- **User visibility:** none during rollback; the only visible difference is which heads read `pending`.

## Conclusion

The review confirmed the fix is strictly fail-closed (no previously-pending or -failing head can become success) and changed one design detail: the hold reason is carried as data on `ProjectionPr` so `projectPr` stays pure, instead of the reconciler pre-computing a projection. Two residuals are named rather than deferred: `effective: 'actions'` on the status route during a hold (closed by GitHub's enforcement of the now-pending status), and brief withdrawal churn on green heads during a read blip (bounded by the post budget, accepted). Clear to ship.

---

## Second-pass review (required — harness path)

**Reviewer:** second-pass reviewer subagent (claude-fable-5-1), independent context
**Independent read of the artifact: concur**

Verified against the code, not the prose: `hold` is null exactly when `enabled && state() === 'effective'` on a configured-local install — the same condition that previously selected the local floor — so the set of inputs reaching `projectMirror` strictly shrank and no input reaches `projectLocal` un-held that did not before; no previously-`pending`/`failure` input can project `success`. The configured-actions path and ineligible PRs are byte-for-byte on the old mirror path; `refreshHeadInputs`, `canaries` and the `inactive` early return all key off `floorOf`, which now never answers `actions` for a configured-local eligible PR; `noteHold` is transition-only and sits after the `safeHolds()` return, so section 7 is right (only the lease holder computes or audits it). The `effectiveFloor()` residual is honestly named and its closure is sound — and in fact doubly closed: besides GitHub's enforcement of the pending status, safe-merge's own `evaluateRequiredContexts` reads the `instar/local-verify` commit status as a required context whenever the ruleset requires it and demands `success`, so even the legacy `--admin` path re-imposes it. Two minor notes, neither changing the verdict: (1) the attention item is deduped by key, but `DegradationReporter.report` has no per-key dedupe, so a settings read flapping every pass would emit one degradation row per minute — bounded by the pass cadence, visible, never affecting posting; (2) `status().floor.hold` is only computed on the lease holder (a standby reads a stale/null `hold`), while `floor.reason`/`settingsState` on a standby still carry the truth and safe-merge reads `effective`, not `hold`. Tests: 87/87 pass on the three files as claimed.

---

## Evidence pointers

- Root cause: `.instar/logs/local-verify.jsonl` line 2839 — `{"ts":"2026-10-25T04:08:46.421Z","src":"status","event":"floor-settings","state":"settings-unreadable","from":"effective","rulesetRequiresCheck":true,"classicContexts":0,"bypass":null}`; lines 2853–2865 — eleven `status-posted … "state":"success","reason":"actions-floor-green"` rows at 04:09:20Z including heads of PRs 1955, 2210, 2199, 2208, 2311; line 2867 — recovery to `effective` at 04:10:19Z.
- GitHub: `gh api repos/JKHeadley/instar/commits/5aec79544aeaf1287ad75e660ef13b880784eda5/statuses` → `02:59:55Z failure error:verifier-mismatch` → `04:09:19Z success actions-floor green` → `04:10:23Z pending withdrawn`.
- Tests: `tests/unit/localVerify/floorGate.test.ts` (incident shape: bypass-only read failure ⇒ `settingsReadable()` true, floor stays local with hold), `statusProjection.test.ts` (held ⇒ pending even with a green record and green runs; actions/ineligible unchanged; shared head), `StatusReconciler.test.ts` (scenarios a/b/b2/c incl. the incident replay with recovery). Canary: with the `src/localVerify` diff reverted, the new tests fail; with it applied, 87/87 pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect in the registry's sense (prompt / hook / config / skill / standards text) — the defect is in server source. The modified controller (the status reconcile loop) gains no new self-action class: posts remain bounded by `RECONCILER_LIMITS.postsPerMinute`, and the hold's audit + signal are transition-only (one per episode), so steady state emits nothing. Not applicable.
