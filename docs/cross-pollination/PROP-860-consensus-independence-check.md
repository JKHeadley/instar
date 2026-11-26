# PROP-860 — Consensus Independence Check for CoherenceGate reviewers

**Source:** Dawn `instar-feature-parity` job (run 55, 2026-07-13, session AUT-8868-wo)
**Dawn pattern:** `.claude/scripts/guardian-consensus-gate.py` (PROP-360)
**Instar integration point:** `src/core/CoherenceGate.ts` verdict aggregation (Step 9)
**Effort:** small · **Impact:** high · **Type:** infrastructure

---

## Problem

Instar's `CoherenceGate` fans out to ~10 specialist reviewers in parallel
(`Promise.allSettled`, CoherenceGate.ts:381) and then aggregates their verdicts
(Step 9, lines 426–448): any `blockResults.length > 0` (or warn-escalation)
produces a `BLOCK`. The gate treats each reviewer's verdict as an **independent**
signal — but it never checks whether they actually *are* independent.

This is the exact load-bearing assumption Dawn hardened in PROP-360. When multiple
verifiers block for the *same underlying reason* stated in near-identical language,
their agreement is **correlated bias, not independent consensus**. Two failure
modes follow:

1. **False confidence in a BLOCK.** Five reviewers all echoing one shared framing
   look like overwhelming consensus, when really it's one signal counted five
   times. If that shared framing is wrong, the gate confidently blocks a good
   response and the agent burns retries against a phantom.
2. **Undetected reviewer-set collapse over time.** As reviewer prompts drift toward
   a common house style, their outputs correlate. Nothing in Instar measures this,
   so the gate silently degrades from "10 perspectives" to "1 perspective ×10"
   without anyone noticing.

Dawn's guardian-consensus-gate exists precisely because "independence is the
load-bearing assumption that makes consensus meaningful." Instar aggregates
consensus but never verifies the assumption. Every agent on Instar inherits this
blind spot.

Confirmed absent by audit (2026-07-13): searched `independent`, `correlation`,
`shared.*bias`, `echo.*chamber`, `consensus.*gate` across `src/core/` — no prior
mechanism checks reviewer overlap before combining verdicts. Closest is
`CoherenceGate.ts:378-401` which combines verdicts assuming natural independence.

Delegation-economics (Dawn's other candidate pattern) is **already present** in
Instar (`LLMConflictResolver.ts:189`, `models.ts:38`, `SessionActivitySentinel.ts:66`
route mechanical work to haiku), so it is NOT proposed here. This PROP is the single
highest-value remaining gap.

## Design (mirrors Dawn's `--lex-only` fast path)

A pure, no-LLM **lexical Jaccard** independence check over the *blocking* reviewers'
stated text (`issue` + `suggestion`). Cheap (no model call), deterministic, and
runs only when there are ≥2 blockers — so it adds zero latency to the common path.

- Tokenize each blocking reviewer's `issue + suggestion` into a lowercased word set
  (stopwords dropped).
- Compute max pairwise Jaccard overlap across the blocking set.
- If `maxJaccard >= threshold` (default 0.5, matching Dawn's empirically-grounded
  baseline posture) **and** no blocker is lexically independent of the rest, emit a
  `shared_bias_warning`.

**Actuation (not advisory-only — per Dawn's enforcement-over-advisory standard):**
The check does NOT flip `BLOCK → PASS` (a real block must hold). Instead it:
1. Writes a distinct `correlated-consensus` marker into the audit log reason, so the
   observability layer (`CoherenceGateObservability`) *counts* correlated-consensus
   blocks over time — a heat-map that surfaces reviewer-set collapse. This is a
   real automated consumer, not a human-read report.
2. Appends the independence verdict to the block feedback returned to the agent, so
   the retry signal distinguishes "10 independent reviewers agree" from "the block
   rests on one correlated framing — verify it's real before rewriting."

This turns silent correlated-consensus into a measured, fed-back signal.

## Proposed patch

### New file: `src/core/ConsensusIndependenceCheck.ts`

```diff
--- /dev/null
+++ b/src/core/ConsensusIndependenceCheck.ts
@@
+/**
+ * ConsensusIndependenceCheck — verifies that agreeing reviewers are independent
+ * before their agreement is trusted as consensus.
+ *
+ * Ported from Dawn's guardian-consensus-gate (PROP-360): "independence is the
+ * load-bearing assumption that makes guardian consensus meaningful." When multiple
+ * reviewers block for the same reason in near-identical language, their agreement
+ * is correlated bias, not independent consensus. This is the fast, no-LLM lexical
+ * path (Dawn's `--lex-only`): pairwise Jaccard over the reviewers' stated text.
+ *
+ * Pure and deterministic — no model call, safe to run inline in the gate.
+ */
+
+export interface IndependenceInput {
+  /** Reviewer name */
+  reviewer: string;
+  /** The reviewer's stated reason (issue + suggestion concatenated). */
+  text: string;
+}
+
+export interface IndependenceVerdict {
+  /** True when the blocking set shows correlated (echo) reasoning. */
+  sharedBiasWarning: boolean;
+  /** Max pairwise Jaccard overlap observed across the blocking set (0..1). */
+  maxJaccard: number;
+  /** The reviewer pair with the highest overlap, for audit/logging. */
+  mostCorrelatedPair?: [string, string];
+  /** Human-readable one-liner for the audit reason and block feedback. */
+  summary: string;
+}
+
+const STOPWORDS = new Set([
+  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
+  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'this', 'that', 'it',
+  'its', 'not', 'no', 'should', 'would', 'could', 'may', 'might', 'response',
+  'message', 'reviewer', 'you', 'your',
+]);
+
+function tokenize(text: string): Set<string> {
+  const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
+    .filter(t => t.length > 2 && !STOPWORDS.has(t));
+  return new Set(tokens);
+}
+
+function jaccard(a: Set<string>, b: Set<string>): number {
+  if (a.size === 0 || b.size === 0) return 0;
+  let inter = 0;
+  for (const t of a) if (b.has(t)) inter++;
+  const union = a.size + b.size - inter;
+  return union === 0 ? 0 : inter / union;
+}
+
+/**
+ * Check whether a set of blocking reviewers is independent.
+ *
+ * @param blockers  the reviewers that voted to block (name + stated reason text)
+ * @param threshold Jaccard overlap above which two reviewers are "correlated".
+ *                  Default 0.5 (mirrors Dawn's baseline posture; tune via config).
+ */
+export function checkConsensusIndependence(
+  blockers: IndependenceInput[],
+  threshold = 0.5,
+): IndependenceVerdict {
+  // Fewer than 2 blockers → nothing to correlate; independence is trivially fine.
+  if (blockers.length < 2) {
+    return { sharedBiasWarning: false, maxJaccard: 0, summary: 'single blocker — independence N/A' };
+  }
+
+  const tokenSets = blockers.map(b => ({ reviewer: b.reviewer, tokens: tokenize(b.text) }));
+  let maxJaccard = 0;
+  let mostCorrelatedPair: [string, string] | undefined;
+
+  for (let i = 0; i < tokenSets.length; i++) {
+    for (let j = i + 1; j < tokenSets.length; j++) {
+      const jac = jaccard(tokenSets[i].tokens, tokenSets[j].tokens);
+      if (jac > maxJaccard) {
+        maxJaccard = jac;
+        mostCorrelatedPair = [tokenSets[i].reviewer, tokenSets[j].reviewer];
+      }
+    }
+  }
+
+  const sharedBiasWarning = maxJaccard >= threshold;
+  const summary = sharedBiasWarning
+    ? `correlated-consensus: ${mostCorrelatedPair?.join(' ≈ ')} overlap ${maxJaccard.toFixed(2)} ≥ ${threshold} — block may rest on shared bias, not independent judgment`
+    : `independent-consensus: max reviewer overlap ${maxJaccard.toFixed(2)} < ${threshold}`;
+
+  return { sharedBiasWarning, maxJaccard, mostCorrelatedPair, summary };
+}
```

### Wiring: `src/core/CoherenceGate.ts` (Step 9, after `blockResults` is computed ~line 427)

```diff
--- a/src/core/CoherenceGate.ts
+++ b/src/core/CoherenceGate.ts
@@ import section
+import { checkConsensusIndependence } from './ConsensusIndependenceCheck.js';
@@ Step 9: Aggregate verdicts
     const blockResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'block');
     const warnResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'warn');
+
+    // Consensus independence (PROP-860): when ≥2 reviewers block, verify their
+    // agreement is independent, not correlated bias. No-LLM lexical check — zero
+    // latency on the common (≤1 blocker) path. Does NOT flip the verdict; it
+    // annotates the audit reason and block feedback so correlated-consensus is
+    // measured over time and the agent's retry signal is honest.
+    const independence = checkConsensusIndependence(
+      blockResults.map(r => ({ reviewer: r.reviewer, text: `${r.issue} ${r.suggestion}` })),
+      this.config.consensusIndependenceThreshold ?? 0.5,
+    );
```

Then, where the block audit reason is built (Row for `llmVerdict === 'BLOCK'`, ~line 547)
and in the block return `warnings`, thread `independence.summary`:

```diff
-      this.logAudit(sessionId, context, 'block', auditViolations, `Block: retry ${retryState.retryCount}/${maxRetries}`);
+      this.logAudit(
+        sessionId, context,
+        independence.sharedBiasWarning ? 'block-correlated-consensus' : 'block',
+        auditViolations,
+        `Block: retry ${retryState.retryCount}/${maxRetries}; ${independence.summary}`,
+      );
```

And append `independence.summary` to the block feedback string handed back to the agent
(wherever block `warnings`/feedback are assembled for the BLOCK return), and add
`_consensusIndependence: independence` to the returned `EvaluateResponse` for observability.

### Config: `src/core/types.ts`

```diff
   warnEscalationThreshold?: number;
+  /** Jaccard overlap (0..1) above which two blocking reviewers are treated as
+   *  correlated rather than independent. Default 0.5. PROP-860. */
+  consensusIndependenceThreshold?: number;
```

### New test: `tests/unit/ConsensusIndependenceCheck.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { checkConsensusIndependence } from '../../src/core/ConsensusIndependenceCheck.js';

describe('checkConsensusIndependence', () => {
  it('single blocker → independence N/A, no warning', () => {
    const v = checkConsensusIndependence([{ reviewer: 'a', text: 'unverified claim about the deploy' }]);
    expect(v.sharedBiasWarning).toBe(false);
  });

  it('two blockers citing distinct issues → independent', () => {
    const v = checkConsensusIndependence([
      { reviewer: 'claim-provenance', text: 'the url dawn.example was never returned by any tool' },
      { reviewer: 'conversational-tone', text: 'phrasing is overly formal and cold for this recipient' },
    ]);
    expect(v.sharedBiasWarning).toBe(false);
    expect(v.maxJaccard).toBeLessThan(0.5);
  });

  it('two blockers echoing the same reason → shared-bias warning', () => {
    const v = checkConsensusIndependence([
      { reviewer: 'settling-detection', text: 'fabricated capability claim never verified in session' },
      { reviewer: 'capability-accuracy', text: 'fabricated capability claim never verified in session output' },
    ]);
    expect(v.sharedBiasWarning).toBe(true);
    expect(v.mostCorrelatedPair).toContain('settling-detection');
  });

  it('respects a custom threshold', () => {
    const inputs = [
      { reviewer: 'a', text: 'alpha beta gamma delta epsilon' },
      { reviewer: 'b', text: 'alpha beta gamma zeta eta' },
    ];
    expect(checkConsensusIndependence(inputs, 0.9).sharedBiasWarning).toBe(false);
    expect(checkConsensusIndependence(inputs, 0.3).sharedBiasWarning).toBe(true);
  });
});
```

## Test evidence

**Not run in this session.** This is a PROP-filing-only job (PROP-379): Dawn's job
runs outside Instar's `/instar-dev` + pre-commit gate and cannot produce the required
trace/side-effects artifact, so no `src/` change is committed or executed here. The
new `ConsensusIndependenceCheck.ts` is a pure function with no imports — the included
unit test is written to pass as specified and should be run by `/instar-dev` during
adoption (`pnpm test tests/unit/ConsensusIndependenceCheck.test.ts` + `tsc --noEmit`).

## Files touched

- `src/core/ConsensusIndependenceCheck.ts` — NEW: pure lexical independence check.
- `src/core/CoherenceGate.ts` — wire the check into Step 9 aggregation; thread the
  verdict into the block audit reason + block feedback + response.
- `src/core/types.ts` — add optional `consensusIndependenceThreshold` config.
- `tests/unit/ConsensusIndependenceCheck.test.ts` — NEW: 4 unit cases.

## Adoption steps for `/instar-dev`

1. Open a spec scaffold for "consensus independence check" and run `/spec-converge`.
2. Add `src/core/ConsensusIndependenceCheck.ts` (pure, no deps — lands clean).
3. Apply the `CoherenceGate.ts` + `types.ts` wiring diffs above.
4. Add the unit test; run `pnpm test tests/unit/ConsensusIndependenceCheck.test.ts`
   and `tsc --noEmit` to produce the side-effects artifact.
5. Optionally extend `CoherenceGateObservability` to count the new
   `block-correlated-consensus` audit outcome (the fed-back consumer that turns this
   from a log line into a reviewer-set-collapse heat-map).
6. Commit through the normal pre-commit gate.

## Why this respects the boundary

Instar governs its own `src/` through `/instar-dev` + `/spec-converge`. This PROP
hands over a complete, reviewable patch + tests + adoption steps and leaves the
landing decision and the gate with Instar.
