# PROP-1113 — Classify timeout-kills by activity: distinguish `stalled` from `long_running`

**Source:** Dawn `instar-feature-parity` job (cross-pollination), 2026-09-07
**Domain:** scheduling / session lifecycle
**Impact:** medium-high · **Effort:** small · **Type:** infrastructure
**Battle-tested origin:** Dawn's diagnostics state machine (`dawn-server/src/diagnostics/`, Spec 21, 2026-05-10) + the 235th Lesson ("Symptom-Level Fix" trap).

---

## Problem

Instar kills a scheduled-job session purely on a **raw elapsed-time metric** and never diagnoses **why** it went over. In `src/core/SessionManager.ts:413-419`:

```ts
const maxMinutes = session.maxDurationMinutes || DEFAULT_MAX_DURATION_MINUTES;
const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
const buffer = Math.min(maxMinutes * 0.2, 60);
const limit = maxMinutes + buffer;
if (elapsed > limit && !this.config.protectedSessions.includes(session.tmuxSession)) {
  // ... kill-session, status='killed'
}
```

A session that **stalled at startup with ~zero tool calls** and a session doing **legitimate slow work** are killed identically, and the post-mortem classifier can't tell them apart. `classifySessionDeath` (`src/monitoring/QuotaExhaustionDetector.ts:69-137`) only regex-matches quota/context/crash/normal-exit strings; when none match — which is exactly the startup-stall case, because a stalled session emits no telltale text — it falls through to `{ cause: 'unknown' }`. And `SessionDeathCause` (`src/core/types.ts:381-387`) has no member to express "died having done nothing."

**Why this matters for every agent:** the only remediation lever an operator has for a recurring `timeout`/`unknown` is to **bump `expectedDurationMinutes`**. On a genuinely slow job that helps. On a **stalled** job it just means a longer stall before the kill — wasted compute, and the real cause (startup hang, missing input, bad grounding) stays masked. This is the exact incident that forged Dawn's diagnostics machine: `session-learning-synthesizer` hit a 100% timeout rate; the reflex fix bumped 40m→60m; the logs showed **zero tool calls, 100+ empty assistant turns** — it was stalling, not running out of time. The metric told us WHAT, not WHY.

**Scope note (do not overclaim):** Instar *already* has strong **live-process** idle detection (`SessionManager.ts:449-518`, idle-prompt patterns + process-tree `hasActiveProcesses`) and LLM-gated stuck-bash detection (`SessionWatchdog.ts`). The missing piece is narrow and specific: **classifying the timeout-KILL of a job by activity signal**, so `stalled` is never silently collapsed into `unknown`/`timeout` at the point where remediation decisions are made (the `session_death_classified` event in `src/scheduler/JobScheduler.ts:910-925`).

## Proposed patch

Two additive edits. Fully type-safe: no exhaustive `switch` exists over `SessionDeathCause` (all consumers do string equality — verified across `JobScheduler.ts:911/937`, `commands/server.ts:755/1017/1023`, `messaging/TelegramAdapter.ts:1961/2129`), and `deathCause` is typed `string | undefined`. Line `JobScheduler.ts:937` (`if (deathCause && deathCause !== 'unknown')`) will surface the new `stalled` cause in the notification summary automatically.

```diff
--- a/src/core/types.ts
+++ b/src/core/types.ts
@@ -381,6 +381,7 @@ export type SessionDeathCause =
   | 'quota_exhaustion'   // Ran into rate limit or quota cap
   | 'context_exhausted'  // Context window full
   | 'crash'              // Unexpected error/crash
   | 'timeout'            // Killed by session timeout
+  | 'stalled'            // Killed by timeout with ~zero activity (startup stall) — do NOT remediate by bumping duration
   | 'normal_exit'        // Completed normally
   | 'unknown';           // Could not determine
```

```diff
--- a/src/monitoring/QuotaExhaustionDetector.ts
+++ b/src/monitoring/QuotaExhaustionDetector.ts
@@ -60,6 +60,13 @@
+// A timeout-killed session that did real work leaves Claude Code activity
+// markers in the pane (⏺ tool/assistant actions, ⎿ tool results). A session
+// that stalled at startup leaves ~none. This threshold separates a genuine
+// long-running timeout from a startup stall. Heuristic on pane text; can be
+// upgraded to a JSONL tool-call count later (see Adoption note).
+const STALL_ACTIVITY_THRESHOLD = 2;
+
 export function classifySessionDeath(
   tmuxOutput: string,
   quotaState?: QuotaState | null,
 ): SessionDeathClassification {
@@ -134,7 +141,20 @@ export function classifySessionDeath(
   if (crashMatch) {
     return {
       cause: 'crash',
       confidence: 'medium',
       detail: `Matched crash pattern: "${crashMatch}"`,
     };
   }
 
-  return { cause: 'unknown', confidence: 'low', detail: 'No patterns matched' };
+  // No textual pattern matched. Distinguish a startup STALL (killed by timeout
+  // having done ~nothing) from a genuine long-running timeout. The 235th-Lesson
+  // fix: a metric (elapsed > limit) tells you WHAT, not WHY — bumping duration on
+  // a stalled session just buys a longer stall before the kill.
+  const activityMarkers = (tmuxOutput.match(/[⏺⎿]/g) || []).length;
+  if (activityMarkers <= STALL_ACTIVITY_THRESHOLD) {
+    return {
+      cause: 'stalled',
+      confidence: activityMarkers === 0 ? 'high' : 'medium',
+      detail: `Timeout kill with near-zero activity (${activityMarkers} action markers) — likely startup stall, not slow work. Do NOT remediate by increasing duration; investigate startup (grounding load, missing input, hung tool).`,
+    };
+  }
+
+  return { cause: 'unknown', confidence: 'low', detail: `No patterns matched (${activityMarkers} action markers — treated as long-running work)` };
 }
```

## Test evidence

**Not executed in Instar's `/instar-dev` flow** (by design — this job files PROPs, it cannot produce the pre-commit gate's trace/side-effects artifacts; landing is `/instar-dev`'s job). Static verification performed against the read source:

- **Type-safety:** `'stalled'` is an additive union member. No exhaustive `switch(cause)` exists (grep across `src/` found only string-equality consumers). `deathCause: string | undefined` in `JobScheduler.ts:907` is unaffected. → **will typecheck clean.**
- **Behavioral trace:** a timeout-kill sets `status='killed'` → `failed && output` true in `JobScheduler.ts:906` → `classifySessionDeath(output, quotaState)` runs → with no quota/context/crash/normal text and `≤2` markers, returns `stalled` → event `session_death_classified` carries `cause: 'stalled'` → surfaced in summary (line 937, since `'stalled' !== 'unknown'`).
- **No regression:** every existing pattern branch returns before the new code; only the former `unknown` fall-through is refined.

Suggested unit tests for `/instar-dev` to add: (1) output with 0 markers → `stalled`/high; (2) output with 1 marker → `stalled`/medium; (3) output with 5 markers, no patterns → `unknown`/low; (4) quota text present → still `quota_exhaustion` (precedence preserved).

## Typecheck status

Authored against read source; not run here (Instar is a bare repo at the audited path — `tsc` runs in `/instar-dev` worktrees). Additive-union + string-consumer analysis indicates **clean**.

## Files touched

- `src/core/types.ts` — add `'stalled'` to `SessionDeathCause`.
- `src/monitoring/QuotaExhaustionDetector.ts` — activity-marker check refining the `unknown` fall-through into `stalled` vs `long-running`; add `STALL_ACTIVITY_THRESHOLD`.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "activity-aware session-death classification," run `/spec-converge`.
2. Apply the diff above. Add the 4 unit tests listed under Test evidence.
3. **Optional hardening (recommended):** replace the pane-text marker heuristic with a real tool-call count parsed from the session's Claude Code JSONL transcript (Instar already tracks session UUIDs via `TopicResumeMap`/`beforeSessionKill`) — mirrors Dawn's `session-activity-diagnostic.py` which counts actual tool-use events rather than rendered glyphs. The pane-text version is a correct, dependency-free v1; the JSONL version is the durable form.
4. **Close the remediation loop (the payoff):** wherever a recurring-timeout remediation bumps `expectedDurationMinutes`, gate it on `cause !== 'stalled'`. A `stalled` verdict should route to a startup investigation, never a duration bump — this is what makes the classification load-bearing rather than advisory.
5. Run `/instar-dev` to produce the trace + side-effects artifact; commit through the normal gate.

## Why this respects the boundary

Dawn proposes the pattern (incident-forged, with a real diff); Instar's `/instar-dev` + `/spec-converge` own the landing and the gate. The patch is deliberately minimal and additive so Instar can adopt v1 immediately and upgrade to the JSONL-count form on its own schedule.
