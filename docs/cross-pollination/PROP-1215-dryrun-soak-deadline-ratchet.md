# PROP-1215 — Dry-run defaults need a forcing function (soak-deadline ratchet)

**Source:** Dawn `instar-feature-parity` job, session AUT-13038-wo, 2026-09-28.
**Dawn pattern:** "Shadow-Mode Without Forcing Function" trap (2026-04-30) + `advisory-audit.py` (shadow defaults surface until classified).
**Mode:** PROP-379 filing-only. Nothing was committed to Instar `src/`.

## Problem

A `dryRun: true` / `shadowMode: true` default is meant to be a phase, not where the feature lives forever. Instar already has the right mechanism for ending that phase: the G3 soak clause in `src/monitoring/guardManifest.ts` (`soakWindowDays` + `declaredLoadBearingAt`). When a gate is still unflipped at its deadline, it becomes visible debt. But entries have to opt in to that clause, and nothing requires them to.

Measured against `JKHeadley/main` @ `c3996e866` by walking the real `getInitDefaults('standalone')` and `getInitDefaults('managed-project')` objects:

- **61** config paths default to `dryRun: true` or `shadowMode: true`.
- **7** have a soak deadline in `GUARD_MANIFEST`.
- **1** (`monitoring.mcpProcessReaper`) is dry-run by design for everyone, as the `devGatedFeatures.ts` exclusion note says.
- **53** have no forcing function. Nothing fires their flip, and nothing records that the soak should end.

Dawn hit this exact failure. X's RIG gate shipped in shadow on 2026-04-26 with a written plan to "flip after ~24h." It was still in shadow 4 days later when the next incident hit. A written soak deadline with nothing to fire it is a hope, not a plan.

Some of those 53 are probably deliberate long soaks. The lint below does not decide which ones. It makes each feature say which kind it is, and it stops new ones from arriving undeclared.

## Proposed patch

One new test file. No `src/` changes. The frozen baseline means it lands green, and it can only ratchet down.

```diff
--- /dev/null
+++ b/tests/unit/lint-dryrun-soak-deadline.test.ts
@@ -0,0 +1,     120 @@
+/**
+ * lint-dryrun-soak-deadline — "Shadow-Mode Without Forcing Function" ratchet
+ * (cross-pollinated from Dawn, PROP-1210-candidate).
+ *
+ * WHY: a default of `dryRun: true` / `shadowMode: true` is a phase, not a
+ * destination. The G3 soak clause (guardManifest soakWindowDays +
+ * declaredLoadBearingAt) already turns an unflipped LOAD-BEARING guard into
+ * visible debt — but only for manifest entries that opt in. Every other dry-run
+ * default soaks forever with nothing that fires the flip. This lint requires
+ * each dry-run default to be EITHER soak-deadlined in GUARD_MANIFEST OR listed
+ * in PERMANENT_DRY_RUN with a written reason. The baseline freezes today's
+ * un-deadlined set so the lint lands green and only ratchets DOWN.
+ */
+import { describe, it, expect } from 'vitest';
+import { getInitDefaults } from '../../src/config/ConfigDefaults.js';
+import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
+
+/** Dry-run by design for everyone (destructive / operator-owned flip). */
+export const PERMANENT_DRY_RUN: Record<string, string> = {
+  'monitoring.mcpProcessReaper': 'Destructive (kills processes); ships dry-run for everyone by design per devGatedFeatures exclusion note.',
+};
+
+/** Frozen at adoption. Remove entries as they gain a soak deadline; never add. */
+const BASELINE_UNDEADLINED = new Set<string>([
+  "commitments.agentOwnedFollowthrough",
+  "commitments.autoExpiry",
+  "conversationIdentity.followThrough",
+  "dashboard.liveInsights",
+  "evolutionActions.autoExpiry",
+  "evolutionActions.undatedResurfacer",
+  "feedbackFactory.consumer",
+  "models.tierEscalation",
+  "monitoring.agentSleep",
+  "monitoring.agentWorktreeReaper",
+  "monitoring.autonomousHeartbeat",
+  "monitoring.autonomousLivenessReconciler",
+  "monitoring.blockerLifecycleLedger",
+  "monitoring.completionClaimVerification",
+  "monitoring.durableOutputScrub",
+  "monitoring.externalHogSentinel",
+  "monitoring.goalRealignment",
+  "monitoring.missingLoginSession",
+  "monitoring.promiseBeacon.escalation",
+  "monitoring.sessionReaper",
+  "monitoring.singleMachineFailoverGap",
+  "monitoring.standDown",
+  "monitoring.windowRunLiveness.cadenceExecutor",
+  "multiMachine.coherenceJournal.replication.compaction",
+  "multiMachine.leaseSelfHeal.churnDetector",
+  "multiMachine.mutualSsh",
+  "multiMachine.nobodyPollingRecovery",
+  "multiMachine.observedEndpoints",
+  "multiMachine.pollFollowsLease",
+  "multiMachine.recoveryKeyEscrow",
+  "multiMachine.seamlessOrchestrator",
+  "multiMachine.sessionPool.commitmentCustodyTransfer",
+  "multiMachine.sessionPool.duplicateReconciler",
+  "multiMachine.sessionPool.failoverRunner",
+  "multiMachine.sessionPool.judgmentArbiters",
+  "multiMachine.sessionPool.moveIntent",
+  "multiMachine.sessionPool.ownershipCheckedSpawn",
+  "multiMachine.sessionPool.ownershipGatedSpawn",
+  "multiMachine.stateSync.classReview",
+  "multiMachine.stateSync.threadlinePairing",
+  "multiMachine.writeAdmission",
+  "multiMachine.zombieRelinquish",
+  "playwrightRegistry",
+  "prGate.classClosure",
+  "subscriptionPool.assistedRelogin",
+  "subscriptionPool.credentialRepointing",
+  "subscriptionPool.proactiveSwap.loginLoss",
+  "threadline.canonicalHistory.conversationDiscipline",
+  "threadline.hubIntent",
+  "threadline.singleNegotiator",
+  "threadline.verifiedPairing",
+  "topicProfiles",
+  "topicProfiles.intentClassifier",
+]);
+
+function collectDryRunPaths(obj: unknown, prefix = '', out: string[] = []): string[] {
+  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
+  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
+    if ((k === 'dryRun' || k === 'shadowMode') && v === true && prefix) out.push(prefix);
+    else collectDryRunPaths(v, prefix ? `${prefix}.${k}` : k, out);
+  }
+  return [...new Set(out)];
+}
+
+function soakDeadlined(path: string): boolean {
+  return GUARD_MANIFEST.some(e => {
+    const x = e as { configPath?: string; dryRunConfigPath?: string; soakWindowDays?: number; declaredLoadBearingAt?: string };
+    const hit = [x.configPath, x.dryRunConfigPath].some(p => p && (p === path || p.startsWith(`${path}.`)));
+    return hit && (x.soakWindowDays ?? 0) > 0 && !!x.declaredLoadBearingAt;
+  });
+}
+
+describe('dry-run defaults carry a forcing function', () => {
+  const found = collectDryRunPaths(getInitDefaults('standalone'))
+    .concat(collectDryRunPaths(getInitDefaults('managed-project')));
+  const paths = [...new Set(found)].sort();
+  const undeadlined = paths.filter(p => !soakDeadlined(p) && !(p in PERMANENT_DRY_RUN));
+
+  it('finds dry-run defaults at all (guards against a vacuous pass)', () => {
+    expect(paths.length).toBeGreaterThan(0);
+  });
+
+  it('every PERMANENT_DRY_RUN reason is substantive', () => {
+    for (const [k, r] of Object.entries(PERMANENT_DRY_RUN)) expect(r.replace(/\s/g, '').length, k).toBeGreaterThanOrEqual(12);
+  });
+
+  it('baseline only shrinks (a baselined path that gained a deadline must be removed)', () => {
+    const stale = [...BASELINE_UNDEADLINED].filter(p => !undeadlined.includes(p));
+    expect(stale).toEqual([]);
+  });
+
+  it('no NEW dry-run default ships without a soak deadline or a permanent reason', () => {
+    const fresh = undeadlined.filter(p => !BASELINE_UNDEADLINED.has(p));
+    expect(fresh).toEqual([]);
+  });
+});
```

## Test evidence

Run in a detached worktree of `JKHeadley/main` @ `c3996e866`, using a minimal vitest config that includes only this file. The repo's global setup typechecked the whole tree and failed on a missing `ssh2` in the borrowed `node_modules`, which has nothing to do with this change.

- Clean: `Tests 4 passed (4)`
- Mutation A: removed `topicProfiles.intentClassifier` from the baseline, so an undeclared dry-run default appears. Result: `1 failed | 3 passed`, and the output names `topicProfiles.intentClassifier`.
- Mutation B: added a stale baseline row, `no.such.feature`. The "baseline only shrinks" test failed and named it.
- Restored: `Tests 4 passed (4)`

## Typecheck status

`tsc --noEmit --strict` on the test file returned no errors in the file itself. The full-repo `tsc` was **not** run: the borrowed `node_modules` is missing `ssh2`, which breaks unrelated `src/core/*Ssh*` files. Run the full typecheck in a proper install before landing.

## Files touched

- `tests/unit/lint-dryrun-soak-deadline.test.ts` (new). It walks the real defaults and requires each dry-run path to have either a soak deadline in `GUARD_MANIFEST` or a written reason in `PERMANENT_DRY_RUN`. Its baseline is frozen and can only shrink.

## Adoption steps for /instar-dev

1. Write a short spec, e.g. `docs/specs/dryrun-soak-deadline-lint.md`, and run `/spec-converge`. Open question: should `PERMANENT_DRY_RUN` live in `guardManifest.ts` next to `NOT_A_GUARD`, with the same reason bar of 12 or more non-whitespace characters, instead of in the test?
2. Apply the diff. Regenerate the baseline from a clean install; it is 53 paths at `c3996e866`.
3. Work the baseline down afterward. Each entry either gets a manifest row with `soakWindowDays` or moves to `PERMANENT_DRY_RUN` with a reason. Every removal is a feature that has declared whether its soak ends.
4. Run `/instar-dev` for the trace and side-effects artifact. The change is test-only with no runtime behavior. Commit through the normal gate.
