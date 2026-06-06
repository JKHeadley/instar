# Side-Effects Review — Hermetic local unit suite

**Version / slug:** `hermetic-unit-suite`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required — Tier-1 patch; watchdog template path reviewed here`

## Summary of the change

This change makes local unit-suite evidence hermetic on a live-agent Node 25 developer box. It touches `src/templates/scripts/instar-watchdog.sh`, `tests/unit/Config.test.ts`, and `tests/unit/coherence-gate-escalation.test.ts`. The source change fixes the existing watchdog no-auth health probe so it calls curl without auth arguments when no auth token exists. The test changes pin framework-specific config fixtures and make package export checks static so full-suite load does not turn a valid export check into a timeout.

## Decision-point inventory

- `probe_server_identity` in `src/templates/scripts/instar-watchdog.sh` — modify — preserves the existing server identity decision, but corrects the no-auth request path so auth headers are only supplied when an auth token exists.
- `Config.test.ts` fixture framework selection — modify — test-only fixture isolation; no production decision point.
- `coherence-gate-escalation.test.ts` export verification — modify — test-only import strategy; no production decision point.

## 1. Over-block

No new block/allow surface is added. The watchdog already decided whether server identity was same-project, wrong-project, unreachable, or indeterminate; this patch only makes the unauthenticated curl invocation match the "no token" branch. There is no new legitimate input rejected by this change.

## 2. Under-block

This does not attempt to make every unit test hermetic in perpetuity. It fixes the local-red failures observed in this run: real-config/framework leakage, live tunnel leakage already addressed on current main, Node 25 native-module setup, the watchdog no-auth script bug, and the export-test timeout. Future tests can still leak live machine state if they read real config or network state without fixtures; that remains a suite hygiene class, not a new runtime gap introduced here.

## 3. Level-of-abstraction fit

The watchdog fix is at the right layer: the bug is in the shell template's curl argument construction, so the correction belongs in the shipped template rather than in the unit test. The config and export changes are correctly test-local: they do not ask production code to grow a seam just to satisfy this suite. Current main already provides the tunnel-provider and worktree cwd seams that absorbed the earlier tunnel/worktree local-reds, so this patch does not duplicate those abstractions.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The watchdog path has existing operational authority to classify the server it probes, but this patch does not add a brittle new authority. It removes an accidental argument-shape dependency in the existing probe. The other two files are tests and have no runtime authority.

## 5. Interactions

- **Shadowing:** The watchdog no-auth branch now bypasses `auth_args` entirely when no token exists. It does not shadow the authenticated path; the authenticated path is unchanged.
- **Double-fire:** No new timers, retries, or events are introduced.
- **Races:** No persistent state or concurrent path changes are introduced. The generated `src/data/builtin-manifest.json` was primed locally by the manifest test and remains ignored.
- **Feedback loops:** No release/update/job feedback loop changes.

## 6. External surfaces

Existing installed agents receive the corrected watchdog template when the template is shipped and applied. The visible behavior is narrower and intended: a no-auth probe should be genuinely no-auth. There is no database migration, ledger write, config-field change, public API change, or Telegram/Slack surface change. The local Node 25 dependency repair required `npm install --include=dev` on the dev box, but it did not modify `package.json` or `package-lock.json`.

## 7. Rollback cost

Rollback is a normal hot-fix revert. The source change is a shell-template branch, and the test changes are fixture/import isolation only. No persistent state is written, and no existing agent state needs repair. If the watchdog change were wrong, reverting it restores the prior curl invocation shape.

## Conclusion

The change is clear to ship as Tier 1. It fixes one real watchdog script bug and isolates two unit-suite failures without skipping tests, suppressing failures, or weakening assertions. The full unit-only run on the live-agent Node 25 box had one failure: a generated built-in manifest was stale because source was dirty; the manifest test regenerated that ignored file and its immediate rerun passed. Focused post-rebase validation passed on the edited/failure-class files.

## Second-pass review (if required)

**Reviewer:** not required for this Tier-1 patch.
**Independent read of the artifact:** not run.

The watchdog surface is documented above because it is the only runtime path touched. No new watchdog decision or recovery authority was added.

## Evidence pointers

- Full unit-only local run: 1,241/1,242 files passed; 23,548/23,549 tests passed. The only failure was `tests/unit/builtin-manifest.test.ts` because the generated ignored manifest was stale after source changes.
- Targeted manifest rerun after local generation: `tests/unit/builtin-manifest.test.ts` passed, 9/9.
- Focused post-rebase run: `AgentWorktreeDetector`, `Config`, `TunnelManager`, `watchdog-bind-probe`, `index-exports`, `coherence-gate-escalation`, and `builtin-manifest` passed, 124/124.
- Claim-check: path advisory found merged PR #842 on the watchdog template and many keyword specs, with no open sibling claim requiring a different layer.
