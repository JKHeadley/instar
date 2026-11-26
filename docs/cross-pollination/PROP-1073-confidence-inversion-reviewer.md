# PROP-1073 — Confidence Inversion Reviewer

**Source:** Dawn `instar-feature-parity` job (AUT-10624-wo, 2026-08-17)
**Domain:** instar | **Type:** infrastructure | **Impact:** medium | **Effort:** small
**Filing mode:** PROP-379 (docs-only hand-off; `/instar-dev` lands via spec-converge)

## Problem

Instar's CoherenceGate runs 10 built-in LLM reviewers (conversational-tone,
claim-provenance, settling-detection, context-completeness, capability-accuracy,
url-validity, value-alignment, information-leakage, escalation-resolution,
gate-reviewer). Audited 2026-08-17: **none detect the "Confidence Inversion"
trap** — high-confidence language ("obviously", "clearly", "of course",
"definitely") that *suppresses* verification.

The insight Dawn carries (cross-pollinated from Instar originally, now a load-
bearing entry in Portal's CLAUDE.md gravity-wells): **low confidence naturally
triggers caution — you double-check, you hedge. High confidence does the
opposite: it suppresses the verification impulse.** This is backwards. The errors
that cause real damage are almost never the uncertain ones — they're the ones
that *felt obvious* and so were never checked. High-confidence claims should
trigger MORE scrutiny, not less.

Why the existing reviewers miss it (both axes checked, genuine gap):
- **settling-detection** flags UNDER-confidence (giving up too early) — the
  opposite failure mode.
- **claim-provenance** flags unsourced *specific* claims (URLs, numbers, status
  codes) not traceable to tool output. But a confident-but-vague assertion
  ("obviously this is the root cause") carries no traceable data point, so it
  slips through provenance entirely.
- **escalation-resolution** has a `confidence` field, but it's the *reviewer's
  own* self-reported certainty used to trigger a research agent — it measures the
  reviewer's confidence, not whether the *message* asserts unearned certainty.
  Opposite direction.

So an agent message like *"This is clearly a race condition in the scheduler —
no need to check the logs"* passes all 10 reviewers today, even though the
confident framing is exactly the tell that verification was skipped.

## Proposed patch

New reviewer file + 3 wiring edits in `CoherenceGate.ts`. Follows the minimal
`buildPrompt`-only template (settling-detection / capability-accuracy), NOT the
`review()`-override outlier (escalation-resolution) — no pre-LLM logic needed.

```diff
diff --git a/src/core/reviewers/confidence-inversion.ts b/src/core/reviewers/confidence-inversion.ts
new file mode 100644
--- /dev/null
+++ b/src/core/reviewers/confidence-inversion.ts
@@
+/**
+ * Confidence Inversion Reviewer — Catches high-confidence language that
+ * suppresses verification ("obviously", "clearly", "of course").
+ *
+ * The insight: low confidence triggers caution (double-check, hedge); high
+ * confidence suppresses it. That is backwards — confidently-wrong errors cause
+ * the most damage precisely because they FELT obvious and were never checked.
+ * High-confidence claims should trigger MORE scrutiny, not less.
+ */
+
+import { CoherenceReviewer } from '../CoherenceReviewer.js';
+import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
+
+export class ConfidenceInversionReviewer extends CoherenceReviewer {
+  constructor(apiKey: string, options?: ReviewerOptions) {
+    super('confidence-inversion', apiKey, options);
+  }
+
+  protected buildPrompt(context: ReviewContext): string {
+    const boundary = this.generateBoundary();
+    const preamble = this.buildAntiInjectionPreamble();
+
+    const toolContext = context.toolOutputContext
+      ? `Recent tool output (to check whether a confident claim was actually verified this session):\n${context.toolOutputContext}`
+      : 'No tool output context available. Evaluate based on language patterns only.';
+
+    return `${preamble}
+
+You are a confidence-calibration reviewer. Your job: detect when an agent states a claim with HIGH confidence that SUPPRESSES verification — where the confident framing itself is the tell that a check was skipped.
+
+The principle: high-confidence claims should trigger MORE scrutiny, not less. The errors that cause the most damage are the ones that felt obvious and so were never checked.
+
+Flag when the message:
+- Uses "obviously", "clearly", "of course", "definitely", "certainly", "no doubt" to assert a substantive claim that was NOT verified via tool output this session
+- Presents a diagnosis / root cause / conclusion as self-evident and explicitly waves off checking ("no need to look at the logs", "don't need to verify")
+- Makes a confident causal or factual assertion about external state (a bug's cause, a system's behavior, what a file contains) with no supporting check
+- Escalates certainty as a substitute for evidence — the more certain the wording, the less checking is described
+
+DO NOT flag:
+- Confident claims that ARE backed by tool output shown in context (verified → confidence is earned)
+- Confidence about the agent's own intent, plan, or preferences (not a checkable external fact)
+- Well-established facts or definitional statements
+- Hedged or appropriately-qualified language
+- Confidence on trivial claims where verification would be absurd
+
+The failure mode is CONFIDENCE INVERSION, distinct from:
+- settling (giving up too early — the opposite, under-confidence)
+- claim-provenance (unsourced SPECIFIC values like URLs/numbers — this catches confident-but-vague assertions that carry no traceable data point)
+
+If tool output context is provided, verify whether the confident claim is actually supported by a check the agent ran. If not, the confidence is unearned — flag it.
+
+${toolContext}
+
+Respond EXCLUSIVELY with valid JSON:
+{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }
+
+Message:
+${this.wrapMessage(context.message, boundary)}`;
+  }
+}
diff --git a/src/core/CoherenceGate.ts b/src/core/CoherenceGate.ts
--- a/src/core/CoherenceGate.ts
+++ b/src/core/CoherenceGate.ts
@@ -31,6 +31,7 @@ import { EscalationResolutionReviewer } from './reviewers/escalation-resolution.js';
 import type { EscalationReviewContext, EscalationReviewResult } from './reviewers/escalation-resolution.js';
+import { ConfidenceInversionReviewer } from './reviewers/confidence-inversion.js';
@@ REVIEWER_CATEGORY_MAP
   'escalation-resolution': 'ESCALATION ISSUE',
+  'confidence-inversion': 'ACCURACY ISSUE',
 };
@@ reviewerDefs
       { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
+      { name: 'confidence-inversion', cls: ConfidenceInversionReviewer },
     ];
```

Note: `'confidence-inversion': 'ACCURACY ISSUE'` places it in `HIGH_STAKES_CATEGORIES`
(alongside claim-provenance/settling), so it participates in retry-exhaustion
handling like the other accuracy reviewers. If `/instar-dev` prefers it advisory-
only at first, give it its own category string (e.g. `'CALIBRATION ISSUE'`) to
keep it out of the high-stakes set during a shadow period.

## Test evidence

Static audit only — this job runs OUTSIDE Instar's `/instar-dev` flow and cannot
run Instar's test suite or produce the pre-commit trace. NOT run: `pnpm test`,
`tsc --noEmit`. The patch is written against the verified current shape of
`settling-detection.ts` (identical structural template — imports, constructor
super() call, single `buildPrompt` override using `generateBoundary()`,
`buildAntiInjectionPreamble()`, `wrapMessage()`, and the JSON output contract),
so it should typecheck clean, but `/instar-dev` must confirm.

## Typecheck status

Not run (outside Instar's gate). Expected clean — no new types, reuses
`ReviewContext`/`ReviewerOptions` and the base `review()` unchanged.

## Files touched

- `src/core/reviewers/confidence-inversion.ts` — NEW. The reviewer (buildPrompt-only, minimal template).
- `src/core/CoherenceGate.ts` — 3 edits: import (~line 31), REVIEWER_CATEGORY_MAP entry (~line 128), reviewerDefs entry (~line 616).

## Adoption steps for /instar-dev

1. Open a spec scaffold for `confidence-inversion-reviewer`, run `/spec-converge`.
2. Apply the diff above verbatim; the new file follows the settling-detection template exactly.
3. Add a fixture test mirroring the existing reviewer tests: a POSITIVE case
   ("Obviously the scheduler is the problem, no need to check the logs" with no
   tool output → should flag) and a NEGATIVE case (same confident claim WITH
   tool output showing the check was run → should pass). Reuse whatever harness
   the other reviewer specs use.
4. Consider launching it in a shadow/warn-only category first (`severity: 'warn'`)
   to calibrate false-positive rate on real agent messages before promoting to
   `block` — confidence language is common and the prompt must not fire on
   earned confidence.
5. Run `/instar-dev` to produce the trace + side-effects artifact; commit through the normal gate.

## Why this respects the boundary

Instar governs `src/` through `/instar-dev` + `/spec-converge`. This PROP carries
the full patch, the exact wiring points, and the calibration caveat so the
landing decision — and the gate — stay with Instar.
