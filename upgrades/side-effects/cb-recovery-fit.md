# Side-Effects Review — Compaction recovery fits the hook-output limit; canary counts truncation

**Version / slug:** `cb-recovery-fit`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

A defect in shipped Phase 0 work (context-budget-layered-summaries §9.1), found by the Phase 0 verification run. Claude Code passes a hook's stdout to the model in full only up to 10,000 characters. Larger output becomes `<persisted-output>` holding a 2 KB preview and a file path. Instar's post-compaction recovery block was about 45 KB, and AGENT.md alone is 28 KB of that. On the 3 live compactions measured after the 9.1 fix, the model received only the first 2 KB. The canary counted those as recovered, because the marker sits inside the preview.

Changes:
- **New fitter.** `PostUpdateMigrator.getFitRecoveryOutput()` generates `.instar/hooks/instar/fit-recovery-output.mjs`. `migrateHooks` always overwrites it, and it is added to the built-in hook list.
- **Session-start hook.** The compact branch pipes the seed through the fitter with a 9,000-character limit. That leaves room for the roughly 320-character machine-load preamble under Claude Code's 10,000.
- **What gets saved.** The full block is saved at `state/context-layers/_recovery/<session>.txt`: 0600, directory 0700, never served (under the never-served layer root), and pruned after 7 days.
- **What gets printed.** The marker, then the conversation context (head 600 characters plus the newest tail), the Telegram session, the identity head (1,200), the memory head (600), and a closing instruction to read the saved file now. A block under the limit passes through unchanged.
- **`compactionCanary.ts`.** `isTruncatedHookOutput` detects the oversize wrapper. A detection whose hook output was truncated is `recoveryTruncated`. It settles immediately as diverged and is counted per group as `truncated`.
- **`BackupManager`.** `_recovery` is a never-backup segment.

## Decision-point inventory

- **Recovery output shape** (modify). It decides what part of an oversize recovery block the hook prints. Deterministic: a priority order and fixed budgets.
- **Canary recovery credit** (modify). A truncated delivery is no longer credited as a recovery. This tightens a signal; it has no authority.
- The seeded-marker write is unchanged: it still depends on the seed's exit code and on non-empty output.

---

## 1. Over-block

- An oversize block drops the middle of the conversation context (the older messages), most of AGENT.md and MEMORY.md, and the dispatch table. All of it is in the saved file, and the session is told to read it.
- Before this change the model already saw only the first 2 KB. The new output carries strictly more of the block: up to 9,000 characters, chosen by priority.

## 2. Under-block

- **The session may not read the file.** The instruction is explicit and sits in the first screen, but compliance is not enforced. The Phase 1 standing packet (S10) replaces this block with a packet built to fit.
- **Claude Code's limit is measured, not configured.** It is 1e4 in the binary (2.1.322). A later Claude Code version could lower it. The 1,000-character margin and the marker's placement inside the first 2,000 characters keep the block safe if the preview path ever returns.

## 3. Level-of-abstraction fit

The fix sits in the hook that produces the block, the one place that knows the block's sections. The canary correction is in the canary, so delivered and printed are distinguished where recovery is judged.

## 4. Signal vs authority compliance

The fitter shapes output; it blocks nothing. The canary change makes a signal honest. No new authority.

## 4b. Judgment-point check

The limit (9,000) and the section budgets are fixed. They derive from a measured external constant, the engine's 10,000-character hook-output limit, not from competing live signals.

## 5. Interactions

- **Seeded marker.** It is still written on a successful, non-empty seed, so the CompactionSentinel stands down exactly as before. The fitter only changes what is printed.
- **Fallback.** `|| printf` prints the raw block if node exits non-zero. The fitter exits non-zero only before writing output: it reads all of stdin first, then writes in a single call.
- **Hook paths.** The `exec` path, taken when recovery is switched off or the framework is not Claude Code, is unchanged. Other engines keep today's behaviour.
- **Canary.** Detections already on the ledger keep their state. Only new hook attachments are classified.

## 6. External surfaces

- The post-compaction context a Claude Code session sees changes shape when the block is oversize.
- New files appear under `state/context-layers/_recovery/`. The canary report gains a `truncated` count.
- Nothing is sent outside the machine.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The hook and the fitter: unified by build.** They are code-level and identical on every machine running the version.
- **Saved blocks: machine-local by design.** `machine-local-justification: hardware-bound-resource`. Each block is the recovery of a session on this machine, read by that same session.
- **The canary.** Per machine, as before.

## 8. Rollback cost

- Remove the fitter file, or revert the release, and the hook prints the raw block again.
- `contextBudget.compactionRecovery.enabled: false` takes the legacy `exec` path, which does not use the fitter.
- Saved files are inert and pruned after 7 days.

## Conclusion

This makes the 9.1 fix actually deliver after a compaction, and makes the canary report delivery rather than printing.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

**Independent read of the artifact:** concur, after one round of fixes.

**First pass: concern raised.**

Blocking:
- The canary read `stdout`, which is the raw printed output, not the delivered `content`. Real truncations would therefore still have counted as recovered. The test fixtures hid this. Fixed: the canary now judges `content`, falls back to `stdout` only when `content` is empty, and anchors the `<persisted-output>` match.
- The Phase 0 canary unit and e2e fixtures encoded a truncated delivery as "complete". Corrected to the whole-delivery shape, where content equals stdout.

Should-fix:
- `init` did not install the fitter. Fixed.
- The seeded marker was written even when the fitter did not run. Fixed: `CB_FIT_OK` gates it.
- A diff header in a message could end the conversation section. Fixed: each section is bounded by its own END line.
- The marker could be lost behind a large preamble. Fixed: the marker always comes first.

Nits:
- The budget arithmetic is fixed.
- An unknown session id now gets a pid and time suffix.

**Resolution check: concur.**
- All five items are resolved.
- Unit 31, integration 1 and e2e 3 pass.
- On this machine's real truncated attachment, the canary now reads `recoveryTruncated: true` and `diverged`.

Non-blocking items recorded:
- A marker outside the 2 KB preview would read diverged only after the grace period.
- A message quoting a section header at the start of a line is mis-sectioned. Cosmetic.
- Detections already on the canary ledger are not re-scanned. They age out of the verification epoch. <!-- tracked: CMT-1536 -->

## Evidence pointers

- Unit: `tests/unit/recovery-output-fit.test.ts` (10 tests), plus the corrected canary fixtures in `tests/unit/compaction-canary.test.ts` (21 tests) and `tests/e2e/context-budget-canary-alive.test.ts`.
  - The fitter passes small blocks through unchanged.
  - An oversize block prints ≤ limit with the marker, the newest conversation, Telegram, identity and the Read line, and the saved file is 0600.
  - The no-save fallback.
  - The rendered session-start hook end to end prints ≤ 10,000 characters, saves the block and writes the seeded marker.
  - Installer parity.
  - The canary marks a truncated delivery as truncated and diverged.
- Integration: `tests/integration/recovery-truncation-canary-route.test.ts`. A truncated delivery reaches `GET /context-budget/sentinel` as diverged with `truncated: 1`.
- E2E: `tests/e2e/recovery-output-fit-lifecycle.test.ts`. The real `migrate()` runs twice, then the installed hook runs on a block of the measured size.
- Measurement: Phase 0 results check 4 (`docs/specs/reports/context-budget-phase0-results.md`, branch `cb-phase0-results`).

## Class-Closure Declaration (display-only mirror)

Defect class: agent-authored hook output exceeding a host limit, silently truncated, with a monitor that credited the truncated output. Closure: the guard (fitter) plus an honest detector (the canary's truncation check), each with a test.
