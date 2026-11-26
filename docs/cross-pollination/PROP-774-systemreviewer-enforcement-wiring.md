# PROP-774 — Wire SystemReviewer probe failures into the Remediator (enforcement-over-advisory)

**Source:** Dawn `instar-feature-parity` job (run 42, 2026-06-18)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Dawn pattern ported:** `enforcement-over-advisory` standard + `advisory-audit.py` (Dawn, shipped 2026-06-15)

## Problem

Dawn's hardest-won infrastructure lesson of mid-June 2026 (the "Advisory-Only
Infrastructure" trap, 2026-06-15) is this: **every detector/scanner/probe must
either ENFORCE (block/defer/actuate) or FEED BACK (write state another automated
step consumes). A detector whose only consumer is a human reading a report is
mis-wired** — it makes the human the actuator and the measured problem never
actually changes. Dawn codified this as a standing standard
(`.claude/standards/enforcement-over-advisory.md`) plus a forcing-function audit
(`advisory-audit.py`) that registers confirmed advisory-only gaps and escalates
them as OVERDUE until each loop is closed.

Instar has the **enforcement spine already built** but one of its two primary
detectors is not plugged into it:

- `DegradationReporter` → `reportStructured()` → `Remediator.dispatch()` →
  runbook match → execution + `AuditWriter`. **Actuating. Good.**
- `SystemReviewer` runs 5-tier functional health probes. On failure it only
  `this.emit('review:probe-failed', result)` (SystemReviewer.ts:469 and :487),
  optionally files feedback, and writes a `doctor-dead-letter.jsonl`. **It never
  reaches the Remediator.** Probe failures rot in the dead-letter file with no
  automated remediation and no visibility into whether they were actionable.

The architecture even *anticipates* this wiring and was left unfinished:
`ErrorCodeExtractor.ts:23` already defines a `'probe-id'` `ErrorProvenance` and a
`ProbeEmission` contract (probeId + errorCode + HMAC signature) explicitly so
probe-emitted failures can produce a non-`free-text` event that is *allowed to
match runbook prefilters* under §A6. The contract exists; SystemReviewer simply
never produces one. This is a textbook advisory-only gap: a detector that
measures correctly and actuates nothing.

**Why it matters for every agent:** SystemReviewer is the canonical end-to-end
health check (sessions stuck, scheduler down, Telegram broken). Today, when those
probes fail, the only path to a fix is a human noticing a dead-letter line or a
Telegram alert and reacting. Wiring it to the Remediator means a probe failure
with a matching runbook self-heals — which is the entire point of the remediation
subsystem already shipped in `src/remediation/`.

## Proposed patch

Give `SystemReviewer` an optional `reportDegradation` dependency (a thin callback,
injected to avoid a circular import with `DegradationReporter`). On every probe
failure, in addition to the existing `emit`, build a `NormalizedDegradationEvent`
with `provenance: 'subsystem-explicit'` (non-`free-text`, so §A6 permits runbook
matching) and route it through the callback — which the bootstrap wires to
`degradationReporter.reportStructured(...)`, i.e. straight into the existing
Remediator dispatch path. Advisory detector becomes an actuating one, reusing the
entire enforcement spine with zero new remediation code.

```diff
--- a/src/monitoring/SystemReviewer.ts
+++ b/src/monitoring/SystemReviewer.ts
@@
-import path from 'path';
+import path from 'path';
+import type { NormalizedDegradationEvent } from './DegradationReporter.js';
@@ export interface SystemReviewerDeps {
   stateDir: string;
   /** Optional: submit feedback items */
   submitFeedback?: (item: {
     type: 'bug';
     title: string;
     description: string;
     agentName: string;
     instarVersion: string;
     nodeVersion: string;
   }) => Promise<unknown>;
   /** Optional: send Telegram alert */
   sendAlert?: (topicId: number | undefined, text: string) => Promise<unknown>;
   /** Optional: redact secrets from strings */
   redactSecrets?: (text: string) => string;
+  /**
+   * Optional: route a probe failure into the Remediator dispatch path.
+   * Bootstrap wires this to `degradationReporter.reportStructured(event)`
+   * so SystemReviewer probe failures actuate runbooks instead of being
+   * advisory-only. Injected (rather than importing DegradationReporter
+   * directly) to avoid a circular module dependency.
+   */
+  reportDegradation?: (event: NormalizedDegradationEvent) => void;
 }
@@ private async runProbe(probe: Probe): Promise<ProbeResult> {
       if (!result.passed) {
         this.emit('review:probe-failed', result);
+        this.routeToRemediation(result);
       }

       return result;

     } catch (err) {
@@
       this.emit('review:probe-failed', result);
+      this.routeToRemediation(result);
       return result;
     }
   }
+
+  /**
+   * Convert a failed ProbeResult into a NormalizedDegradationEvent and hand it
+   * to the injected Remediator dispatch surface. No-op when no reporter is
+   * wired (preserves current advisory behavior for callers that haven't
+   * adopted the dependency yet). Provenance is 'subsystem-explicit' — a
+   * non-free-text source, which §A6 permits to match runbook prefilters,
+   * unlike legacy free-text `.report(...)` events.
+   */
+  private routeToRemediation(result: ProbeResult): void {
+    if (!this.deps.reportDegradation) return;
+    const redact = this.deps.redactSecrets ?? ((s: string) => s);
+    const full = result.error ?? result.description;
+    const monotonicTs =
+      typeof performance !== 'undefined' && typeof performance.now === 'function'
+        ? performance.now()
+        : Date.now();
+    const event: NormalizedDegradationEvent = {
+      subsystem: result.name,
+      errorCode: `PROBE_FAILED_${result.probeId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
+      provenance: 'subsystem-explicit',
+      reason: { redacted: redact(full), full },
+      timestamp: new Date().toISOString(),
+      monotonicTs,
+    };
+    try {
+      this.deps.reportDegradation(event);
+    } catch (err) { // @silent-fallback-ok — remediation routing must never break the review loop
+      // Dispatch failures already surface on the Remediator side; never let
+      // routing throw out of a probe run.
+    }
+  }
```

Bootstrap wiring (wherever SystemReviewer is constructed — e.g. the doctor/server
bootstrap that already builds the `DegradationReporter`):

```diff
   const reviewer = new SystemReviewer(reviewerConfig, {
     stateDir,
     submitFeedback,
     sendAlert,
     redactSecrets,
+    reportDegradation: (event) => degradationReporter.reportStructured(event),
   });
```

## Test evidence

Not run from this job — Dawn's `instar-feature-parity` job is PROP-filing-only and
runs outside Instar's `/instar-dev` gate (PROP-379), so it cannot produce the
pre-commit trace/side-effects artifact required to land `src/`. The diff is built
against the current tree (verified file/line references below) and is designed to
typecheck additively. The `/instar-dev` adoption pass should run:

```
pnpm test src/monitoring          # SystemReviewer + DegradationReporter suites
npx tsc --noEmit                  # additive deps field + typed helper
```

Suggested new tests:
1. Probe fails → `reportDegradation` called once with `provenance:'subsystem-explicit'`
   and `errorCode` derived from `probeId`.
2. No `reportDegradation` injected → behavior identical to today (advisory-only).
3. `reportDegradation` throws → probe run still returns its `ProbeResult` (no leak).

## Typecheck status

Not run (filing-only job). The change is additive: one optional deps field, one
type import, one private method. No existing signatures change.

## Files touched

- `src/monitoring/SystemReviewer.ts` — add optional `reportDegradation` dep, a
  `routeToRemediation()` helper, and two call sites at the existing probe-failure
  points (lines ~469 and ~487). Verified against current tree 2026-06-18.
- Bootstrap site that constructs `SystemReviewer` alongside `DegradationReporter`
  — one-line wiring (`reportDegradation: (e) => degradationReporter.reportStructured(e)`).

## Adoption steps for /instar-dev

1. Open a spec scaffold for "SystemReviewer → Remediator enforcement wiring";
   run `/spec-converge`. Tie it to SELF-HEALING-REMEDIATOR-V2-SPEC §A6 (provenance
   gating) and §A33 (NormalizedDegradationEvent contract).
2. Apply the diff above. Decide provenance rigor:
   - **Simple (this diff):** `provenance:'subsystem-explicit'` — no HMAC, matches
     runbooks today.
   - **Rigorous (preferred long-term):** produce a signed `ProbeEmission`
     (`ErrorCodeExtractor.ts`) and use `provenance:'probe-id'`. Requires wiring the
     HMAC signer/verifier already contemplated in `ErrorCodeExtractor`.
3. Add the three tests above; run `/instar-dev` to produce the trace +
   side-effects artifact; commit through the normal gate.
4. **Close the meta-gap too (the real Dawn lesson):** add a lightweight audit —
   one test or a startup assertion — that fails if a registered detector
   (SystemReviewer, DegradationReporter, future probes) is constructed *without* a
   path to the Remediator. This is the Instar analog of Dawn's `advisory-audit.py`:
   it prevents the next detector from silently shipping advisory-only. Without this
   step the wiring fixes one detector; with it, the *class* of bug is closed.

## Why this respects the boundary

Instar governs its own `src/` through `/instar-dev` + `/spec-converge`. This PROP
carries the full diff and adoption path but lands nothing — the gate decision and
the merge stay with Instar.
