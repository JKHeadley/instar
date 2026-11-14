# PROP-1126: Decision-Visibility Gate — verify a decision reaches its consumer

- **Source:** Dawn `instar-feature-parity` job (AUT-11729-wo, 2026-09-10)
- **Domain:** instar
- **Type:** infrastructure
- **Impact:** high
- **Effort:** small–medium
- **Status:** PROPOSED (docs-only hand-off for `/instar-dev` to land through spec-converge)

## Problem

Instar records decisions but never verifies they reach the component that must
read them. `DecisionJournal.log()` appends a JSONL row (and optionally promotes
it to a `decision` MemoryEntity); `DispatchDecisionJournal` records dispatch
choices. Both are **write-only from a correctness standpoint** — nothing confirms
that the *next component in the chain* can actually retrieve what was written.

This is the failure mode Dawn hit five separate times in one week (AUT-26025-dm,
2026-09-08): automation worked perfectly — decisions recorded, actions completed —
but landed in the *wrong store*, the *wrong field*, or a *single-record store*
where an N-to-1 write silently dropped siblings. Every layer reported green while
the consumer read nothing. Examples: four of five tracked comments went unwatched
because the registry held one `commentId` per `postId`; a diagnosis was filed to a
queue nothing read at decision time; a status said "pending-on-Dawn" but was
mis-filed as "pending-on-Justin."

Dawn's standing rule (`.claude/standards/enforcement-over-advisory.md`, plus the
`loop-closure-guardian`): **before recording a decision, name its consumer and
verify the consumer can see it.** This is a *structural* prevention of an entire
bug category — silent decision-routing failure — that no existing Instar check
catches. `CoherenceMonitor` validates config/durability but never asks "did the
reader find what I just wrote?"

Multi-agent systems with registries, queues, and async chains are exactly where
this fails silently, so every agent built on Instar inherits the risk.

## Proposed patch

Two pieces: (1) an optional `consumer` field on the decision entry that names who
reads it; (2) a `DecisionVisibilityGate` that registers per-consumer retrieval
functions and, after each write, confirms the just-written decision is actually
retrievable by that consumer. Advise mode (default) degrade-reports a miss;
enforce mode throws. Backwards compatible: no gate wired ⇒ current behavior.

```diff
--- a/src/core/types.ts
+++ b/src/core/types.ts
@@ export interface DecisionJournalEntry {
   /** Tags for categorization */
   tags?: string[];
+  /**
+   * Name of the component that must READ this decision downstream (e.g.
+   * 'DispatchRouter', 'thread-tracker', 'evolution-queue'). When set and a
+   * DecisionVisibilityGate is wired, `log()` verifies this consumer can
+   * retrieve the decision immediately after write. Optional for backwards
+   * compatibility; recommended for any decision another component acts on.
+   */
+  consumer?: string;
   /**
    * Evidence supporting this decision (WikiClaim Phase 3).
```

```diff
--- /dev/null
+++ b/src/core/DecisionVisibilityGate.ts
@@
+/**
+ * DecisionVisibilityGate — verifies a recorded decision is retrievable by the
+ * component that must consume it.
+ *
+ * Cross-pollinated from Dawn (Portal). Prevents silent decision-routing
+ * failure: a decision written to the wrong store / wrong field / a single-record
+ * store where an N-to-1 write drops siblings, while every layer reports green.
+ *
+ * Usage:
+ *   const gate = new DecisionVisibilityGate('advise');
+ *   gate.registerConsumer('DispatchRouter', (entry) =>
+ *     router.canSee(entry));            // returns boolean
+ *   decisionJournal.setVisibilityGate(gate);
+ *
+ * After each `DecisionJournal.log()`, if the entry names a `consumer` and that
+ * consumer is registered, the gate runs its retrieval check. On failure: advise
+ * mode reports via DegradationReporter; enforce mode throws
+ * DecisionVisibilityError.
+ */
+import { DegradationReporter } from '../monitoring/DegradationReporter.js';
+import type { DecisionJournalEntry } from './types.js';
+
+export class DecisionVisibilityError extends Error {
+  constructor(message: string) {
+    super(message);
+    this.name = 'DecisionVisibilityError';
+  }
+}
+
+/** Returns true if the consumer can retrieve the given decision. */
+export type ConsumerRetrievalCheck = (entry: DecisionJournalEntry) => boolean;
+
+export type VisibilityMode = 'advise' | 'enforce';
+
+export interface VisibilityAuditResult {
+  consumer: string;
+  registered: boolean;
+  lastVerifiedOk: boolean | null;
+}
+
+export class DecisionVisibilityGate {
+  private consumers = new Map<string, ConsumerRetrievalCheck>();
+  private lastResult = new Map<string, boolean>();
+
+  constructor(private mode: VisibilityMode = 'advise') {}
+
+  /** Register the retrieval check a named consumer uses to see decisions. */
+  registerConsumer(name: string, check: ConsumerRetrievalCheck): void {
+    this.consumers.set(name, check);
+  }
+
+  /**
+   * Verify a just-written decision is visible to its named consumer.
+   * No-op when the entry names no consumer or the consumer is unregistered
+   * (a decision with no downstream reader is legitimately write-only).
+   */
+  verify(entry: DecisionJournalEntry): void {
+    const name = entry.consumer;
+    if (!name) return;
+    const check = this.consumers.get(name);
+    if (!check) return; // unregistered consumer — cannot verify, do not block
+
+    let ok = false;
+    try {
+      ok = check(entry);
+    } catch (err) {
+      ok = false;
+      DegradationReporter.getInstance().report({
+        feature: 'DecisionVisibilityGate.verify',
+        primary: `Run retrieval check for consumer '${name}'`,
+        fallback: 'Treat decision as not-visible',
+        reason: err instanceof Error ? err.message : String(err),
+        impact: `Decision '${entry.decision.slice(0, 80)}' visibility unverifiable`,
+      });
+    }
+    this.lastResult.set(name, ok);
+    if (ok) return;
+
+    const msg =
+      `Decision recorded but consumer '${name}' cannot retrieve it — ` +
+      `silent routing failure (wrong store/field or N-to-1 drop). ` +
+      `decision="${entry.decision.slice(0, 120)}"`;
+    if (this.mode === 'enforce') throw new DecisionVisibilityError(msg);
+    DegradationReporter.getInstance().report({
+      feature: 'DecisionVisibilityGate.verify',
+      primary: `Consumer '${name}' retrieves recorded decision`,
+      fallback: 'Decision persisted but unread by its consumer',
+      reason: msg,
+      impact: 'Downstream component acts on stale/absent decision',
+    });
+  }
+
+  /** Snapshot of last-verified state per registered consumer (for auditors). */
+  audit(): VisibilityAuditResult[] {
+    return Array.from(this.consumers.keys()).map(consumer => ({
+      consumer,
+      registered: true,
+      lastVerifiedOk: this.lastResult.has(consumer)
+        ? (this.lastResult.get(consumer) as boolean)
+        : null,
+    }));
+  }
+}
```

```diff
--- a/src/core/DecisionJournal.ts
+++ b/src/core/DecisionJournal.ts
@@
 import { DegradationReporter } from '../monitoring/DegradationReporter.js';
 import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
+import type { DecisionVisibilityGate } from './DecisionVisibilityGate.js';
@@ export class DecisionJournal {
   private semanticMemory: SemanticMemory | null = null;
+  /**
+   * Optional visibility gate. When set, `log()` verifies (after append) that a
+   * decision naming a downstream `consumer` is retrievable by it. Unset ⇒
+   * current write-only behavior. See DecisionVisibilityGate.
+   */
+  private visibilityGate: DecisionVisibilityGate | null = null;
@@
   setSemanticMemory(
     memory: SemanticMemory,
     entityPrivacyScope: PrivacyScopeType = 'shared-project',
   ): void {
     this.semanticMemory = memory;
     this.entityPrivacyScope = entityPrivacyScope;
   }
+
+  /** Wire a DecisionVisibilityGate. Optional; backwards compatible. */
+  setVisibilityGate(gate: DecisionVisibilityGate): void {
+    this.visibilityGate = gate;
+  }
@@
     maybeRotateJsonl(this.journalFile);
     fs.appendFileSync(this.journalFile, JSON.stringify(full) + '\n');
+
+    // Consumer-visibility verification (cross-pollinated from Dawn). Runs
+    // AFTER the durable append so the check reads the same state the consumer
+    // will. Advise mode degrade-reports a miss; enforce mode throws.
+    if (this.visibilityGate) {
+      this.visibilityGate.verify(full);
+    }
     return full;
   }
```

## Test evidence

NOT RUN in this session. This job (`instar-feature-parity`, PROP-379 mode) is
PROP-filing-only and runs outside Instar's `/instar-dev` gate — it cannot produce
the trace/side-effects artifact the pre-commit hook requires, so I did not run
`pnpm test`/`tsc` against the Instar tree. The diff is grounded in the real
current source (read 2026-09-10): `DecisionJournal.log()` at
`src/core/DecisionJournal.ts:118`, `DecisionJournalEntry` at `src/core/types.ts:1175`,
`DegradationReporter` import already present at `DecisionJournal.ts:33`.

Suggested tests for `/instar-dev` to add:
- `verify()` no-ops when `entry.consumer` is undefined.
- `verify()` no-ops when consumer is named but unregistered.
- advise mode: registered consumer returning `false` ⇒ one DegradationReporter
  report, no throw.
- enforce mode: registered consumer returning `false` ⇒ throws
  `DecisionVisibilityError`.
- registered consumer returning `true` ⇒ no report, `audit()` shows
  `lastVerifiedOk: true`.
- `log()` with a wired gate + passing consumer ⇒ row still appended, return value
  unchanged.

## Typecheck status

NOT RUN (see Test evidence). The diff uses only existing imports and types
(`DecisionJournalEntry`, `DegradationReporter`, `MemoryEvidence` unaffected) and a
new self-contained module, so it is expected to typecheck clean; `/instar-dev`
should confirm with `tsc --noEmit`.

## Files touched

- `src/core/types.ts` — add optional `consumer?: string` to `DecisionJournalEntry`.
- `src/core/DecisionVisibilityGate.ts` — NEW: the gate (register consumers, verify
  visibility, audit).
- `src/core/DecisionJournal.ts` — add `setVisibilityGate()` + post-append
  `verify()` call. Backwards compatible (no gate ⇒ unchanged).

Optional follow-on (not in this diff, name for `/instar-dev` to scope):
`DispatchDecisionJournal.record()` gets the same hook, and `CoherenceMonitor`
gains a periodic "visibility coherence" check that calls `gate.audit()`.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "Decision-Visibility Gate" and run `/spec-converge`
   (frame: verify decisions reach their consumer; advise-by-default, enforce
   opt-in; backwards compatible).
2. Apply the diff above; add the six tests listed under Test evidence.
3. Wire one real consumer as proof (e.g. `DispatchRouter`) so the gate has a live
   registration, then run `/instar-dev` to produce the trace + side-effects
   artifact.
4. `tsc --noEmit` + `pnpm test`; commit through the normal gate.

## Why this respects the boundary

Instar governs its own `src/` through `/instar-dev` + `/spec-converge`. This PROP
supplies the pattern and a concrete, grounded diff; the landing decision and the
gate stay with Instar. Dawn is the source of infrastructure wisdom, not the
committer.
