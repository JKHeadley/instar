# PROP-994 — State Freshness Reviewer (outbound stale-state gate)

**Source:** Dawn `instar-feature-parity` job (2026-08-10, AUT-10225-wo)
**Domain:** instar · **Type:** infrastructure · **Impact:** medium-high · **Effort:** small

## Problem

Dawn's `CoherenceGate` equivalent already ports most of Dawn's outbound-integrity
lenses (claim-provenance, settling, capability-accuracy, url-validity, …). One
distinct, incident-born lens is missing: **temporal staleness of once-true state
claims.**

`claim-provenance` catches claims that were **fabricated** (never in tool output)
or that **contradict the canonical registry**. It does NOT catch a claim that was
*true when the agent learned it* and has since **decayed**: a deadline that has
passed, a "still pending / currently suspended / account is locked" status the
agent never re-checked this turn, a count that a fresher source has moved. These
are not lies and not inventions — they are the agent repeating a stale fact in an
outbound message, and a human has to catch it.

This is a real, recurring, user-facing failure class in Dawn. The canonical
incident: an autonomous session told the collaborator "X appeal deadline in 2
days" when the account had already been reinstated days earlier — three state
files disagreed, nothing gated the outbound claim, and the human became the
detector. Dawn's structural answer was a pre-send freshness gate. Instar's
`CoherenceGate` is the natural home for the same lens, and it already carries the
two context inputs the reviewer needs (`toolOutputContext`, `canonicalStateContext`).

## Proposed patch

New reviewer + two-line registration. Mirrors the exact shape of
`claim-provenance.ts` (sonnet model, same context inputs, same JSON contract).

```diff
diff --git a/src/core/reviewers/state-freshness.ts b/src/core/reviewers/state-freshness.ts
new file mode 100644
--- /dev/null
+++ b/src/core/reviewers/state-freshness.ts
@@ -0,0 +1,90 @@
+/**
+ * State Freshness Reviewer — Catches outbound messages that assert time-sensitive
+ * or mutable state whose truth may have DECAYED since it was learned.
+ *
+ * Distinct from claim-provenance (which catches FABRICATED claims not traceable
+ * to tool output) and from url-validity. This reviewer catches claims that were
+ * TRUE WHEN LEARNED but have since gone STALE: deadlines that may have passed,
+ * "still pending / currently suspended / open / active" status assertions, counts
+ * and "in N days" phrasing whose correctness depends on elapsed time or on a
+ * canonical-state value that may have been updated after the claim was formed.
+ *
+ * The failure mode it defends against is not lying and not inventing — it is
+ * repeating a once-true fact that a fresher source of truth now contradicts, in
+ * an outbound message a human then has to catch. A canonical registry is the
+ * ground truth: a temporal/status assertion that contradicts it, or that has no
+ * fresh backing at all, is flagged for re-verification before send.
+ *
+ * Fail-open like the other CoherenceGate specialists.
+ */
+
+import { CoherenceReviewer } from '../CoherenceReviewer.js';
+import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';
+
+export class StateFreshnessReviewer extends CoherenceReviewer {
+  constructor(apiKey: string, options?: ReviewerOptions) {
+    super('state-freshness', apiKey, {
+      ...options,
+      model: options?.model ?? 'sonnet',
+    });
+  }
+
+  protected buildPrompt(context: ReviewContext): string {
+    const boundary = this.generateBoundary();
+    const preamble = this.buildAntiInjectionPreamble();
+
+    const toolContext = context.toolOutputContext
+      ? `Recent tool output (fresh evidence — a state assertion backed by this is NOT stale):\n${context.toolOutputContext}`
+      : 'No tool output context available. Any time-sensitive state assertion is unbacked — lean toward "warn".';
+
+    const canonicalContext = context.canonicalStateContext
+      ? `\nCanonical registry (current source of truth — a status/deadline claim that CONTRADICTS this is stale, not merely wrong):\n${context.canonicalStateContext}\n`
+      : '';
+
+    return `${preamble}
+
+You are a state-freshness reviewer. Your job: catch claims that were probably TRUE when the agent learned them but may now be STALE — where the truth depends on elapsed time or on a mutable status that a fresher source may have changed.
+
+Flag when the message:
+- Asserts a deadline or countdown ("deadline in 2 days", "expires tomorrow", "by Friday") — these decay with the calendar and are frequently stale
+- Reports a mutable STATUS as current ("still pending", "currently suspended", "account is locked", "the ticket is open", "not yet resolved") without fresh backing
+- States a count or metric as current ("we have 3 blockers", "12 items left") when a fresher source could have moved it
+- Describes another system/service/account state ("X is down", "the deploy is blocked") without evidence it was checked in THIS turn
+- Contradicts the canonical registry's current value for the same status/entity
+
+DO NOT flag:
+- Claims directly backed by the recent tool output provided below
+- Claims that MATCH the canonical registry's current value
+- Timeless facts, definitions, or descriptions of architecture
+- Statements about what the agent plans to do
+- Historical statements explicitly scoped to the past ("was suspended last week", "as of Monday")
+
+Severity guidance: a temporal/status assertion that CONTRADICTS the canonical registry → "block". A time-sensitive assertion with NO fresh backing (no tool output, not in registry) → "warn". The suggestion should tell the agent which source to re-check before sending.
+
+${toolContext}
+${canonicalContext}
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
@@ import { EscalationResolutionReviewer } from './reviewers/escalation-resolution.js';
+import { StateFreshnessReviewer } from './reviewers/state-freshness.js';
@@ reviewerDefs
       { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
+      { name: 'state-freshness', cls: StateFreshnessReviewer },
```

## Test evidence

Applied both edits into the `instar-main` worktree and typechecked, then reverted:

```
npx tsc --noEmit -p tsconfig.json  →  EXIT=0, 0 errors (clean)
```

No test was added in this patch (adoption step below covers it). The new file is a
pure sibling of `claim-provenance.ts` / `settling-detection.ts` — same base class,
same `ReviewContext` inputs (`toolOutputContext`, `canonicalStateContext`), same
JSON response contract already parsed by `CoherenceReviewer`.

## Typecheck status

Clean — `tsc --noEmit` exit 0, zero errors, with both edits applied to the worktree.

## Files touched

- `src/core/reviewers/state-freshness.ts` — NEW: the reviewer (prompt + class).
- `src/core/CoherenceGate.ts` — import line + one entry in the `reviewerDefs` array
  (registers the reviewer in the specialist pipeline).

## Adoption steps for /instar-dev

1. Open a spec scaffold for `state-freshness-reviewer`, run `/spec-converge`.
2. Apply the diff above. Add a unit test mirroring the existing reviewer tests
   (feed a stale-deadline message + a registry-backed fresh message; assert
   `pass=false severity=warn` on the former, `pass=true` on the latter).
3. **Recommended rollout:** register it in `observe` mode first
   (`config.reviewers['state-freshness'].mode = 'observe'`) so it logs verdicts via
   `getReviewerStats` without blocking, per Instar's shadow-first norm. Default
   base mode is `block`; do not ship it blocking on day one. Promote to `warn`
   after a soak once the false-positive rate on real outbound traffic is sane.
4. Run `/instar-dev` to produce the trace + side-effects artifact; commit through
   the normal gate.

## Why this respects the boundary

Filed as a docs-only PROP (passes Instar's pre-commit gate). Dawn proposes the
lens and the full patch; Instar's `/instar-dev` + `/spec-converge` own the landing
and the gate.
