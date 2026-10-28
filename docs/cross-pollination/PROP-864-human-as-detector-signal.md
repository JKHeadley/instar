# PROP-864 — Human-as-Detector Signal (detector-miss heat map)

**Source:** Dawn `instar-feature-parity` job (AUT-9016-wo, 2026-07-16)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Parity verdict:** PARTIAL — substrate exists (`ConvergenceChecker`, `SendGateway`), the inversion signal does not.

## Problem

Dawn treats **every human correction as a first-class diagnostic signal about which
automated layer failed** — not merely a bug report. When Justin points out a stale
claim, a sycophantic reply, or a fabricated experience, Dawn logs it to
`.claude/metrics/human-as-detector.jsonl` with the question "which detector *should*
have caught this, and why didn't it?" Over time this builds a **heat map of where the
human is doing the system's job** — the highest-signal input for deciding which
detector to tune next. (Origin: Dawn CLAUDE.md, "Justin Pointing Things Out = Guardian
Failure" trap, 2026-04-26.)

Instar has the detection substrate but not the inversion:

- `src/core/ConvergenceChecker.ts` — `checkConvergence(content)` flags 7 categories
  (`capability_claims`, `commitment_overreach`, `settling`,
  `experiential_fabrication`, `sycophancy`, `temporal_staleness`, `url_provenance`).
- `src/core/SendGateway.ts:179` — runs the checker pre-send and emits warnings.
- `src/monitoring/DegradationReporter.ts` / `CoherenceMonitor.ts` — log *machine-detected*
  degradation only.

**What's missing:** nothing records the cases the detectors LEAK. When a human catches
a `sycophancy` issue the regex didn't match, that miss is invisible — so no one learns
that the `sycophancy` pattern needs widening. There is no heat map of detector misses,
and no distinction between "detector never fired" (`detector_miss`) vs. "detector fired
but the message went out anyway" (`warned_but_sent`). Both are load-bearing: the first
says *tune the detector*, the second says *tune enforcement*.

## Proposed patch

Add one self-contained module + unit test. Zero changes to existing behavior; a wiring
call from the correction/feedback path is the only integration `SendGateway`/feedback
handlers add (one line, shown in adoption steps).

```diff
diff --git a/src/monitoring/HumanDetectorSignal.ts b/src/monitoring/HumanDetectorSignal.ts
new file mode 100644
--- /dev/null
+++ b/src/monitoring/HumanDetectorSignal.ts
@@
+/**
+ * HumanDetectorSignal — treats human corrections as first-class diagnostic signals.
+ *
+ * Ported from Dawn's human-as-detector pattern. When a human points out a problem
+ * that one of Instar's automated detectors SHOULD have caught, that is not merely a
+ * bug report — it is evidence that a detection layer leaked. Every recorded signal
+ * answers: "which automated layer should have caught this, and did it?" Over time the
+ * JSONL builds a heat map of where the human is doing the system's job — i.e. which
+ * detector category most needs tuning.
+ */
+
+import fs from 'node:fs';
+import path from 'node:path';
+import { checkConvergence } from '../core/ConvergenceChecker.js';
+
+export type DetectorVerdict =
+  | 'detector_miss'      // checker did NOT flag the category the human caught
+  | 'warned_but_sent'    // checker flagged it, but the message went out anyway
+  | 'no_local_detector'; // no automated detector exists for this category
+
+export interface HumanDetectorSignal {
+  timestamp: string;
+  /** The convergence category the human's correction maps to. */
+  category: string;
+  /** Which layer failed. */
+  verdict: DetectorVerdict;
+  /** The offending content (truncated to 280 chars). */
+  contentPreview: string;
+  /** Free-text human note. */
+  note?: string;
+}
+
+export interface DetectorMissHeatmap {
+  total: number;
+  byCategory: Record<string, { misses: number; warnedButSent: number; noDetector: number }>;
+  /** Categories sorted by miss count, worst first. */
+  worst: Array<{ category: string; misses: number }>;
+}
+
+const SIGNALS_FILE = 'human-detector-signals.jsonl';
+
+/** Convergence categories that HAVE an automated detector today. */
+const KNOWN_CATEGORIES = new Set([
+  'capability_claims', 'commitment_overreach', 'settling',
+  'experiential_fabrication', 'sycophancy', 'temporal_staleness', 'url_provenance',
+]);
+
+function classify(content: string, category: string): DetectorVerdict {
+  if (!KNOWN_CATEGORIES.has(category)) return 'no_local_detector';
+  const result = checkConvergence(content);
+  const flagged = result.issues.some((i) => i.category === category);
+  return flagged ? 'warned_but_sent' : 'detector_miss';
+}
+
+/**
+ * Record a human correction as a detector-failure signal.
+ * @returns the signal that was persisted.
+ */
+export function recordHumanDetection(opts: {
+  stateDir: string;
+  content: string;
+  category: string;
+  note?: string;
+}): HumanDetectorSignal {
+  const verdict = classify(opts.content, opts.category);
+  const signal: HumanDetectorSignal = {
+    timestamp: new Date().toISOString(),
+    category: opts.category,
+    verdict,
+    contentPreview: opts.content.slice(0, 280),
+    note: opts.note,
+  };
+  fs.mkdirSync(opts.stateDir, { recursive: true });
+  fs.appendFileSync(path.join(opts.stateDir, SIGNALS_FILE), JSON.stringify(signal) + '\n', 'utf8');
+  return signal;
+}
+
+/** Build a heat map of detector misses from the persisted signals. */
+export function summarizeDetectorMisses(stateDir: string): DetectorMissHeatmap {
+  const file = path.join(stateDir, SIGNALS_FILE);
+  const byCategory: DetectorMissHeatmap['byCategory'] = {};
+  let total = 0;
+  if (fs.existsSync(file)) {
+    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
+      if (!line.trim()) continue;
+      let sig: HumanDetectorSignal;
+      try { sig = JSON.parse(line) as HumanDetectorSignal; } catch { continue; }
+      total++;
+      const bucket = (byCategory[sig.category] ??= { misses: 0, warnedButSent: 0, noDetector: 0 });
+      if (sig.verdict === 'detector_miss') bucket.misses++;
+      else if (sig.verdict === 'warned_but_sent') bucket.warnedButSent++;
+      else bucket.noDetector++;
+    }
+  }
+  const worst = Object.entries(byCategory)
+    .map(([category, b]) => ({ category, misses: b.misses }))
+    .filter((e) => e.misses > 0)
+    .sort((a, b) => b.misses - a.misses);
+  return { total, byCategory, worst };
+}
```

```diff
diff --git a/tests/unit/human-detector-signal.test.ts b/tests/unit/human-detector-signal.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/unit/human-detector-signal.test.ts
@@
+import { describe, it, expect, beforeEach, afterEach } from 'vitest';
+import fs from 'node:fs';
+import path from 'node:path';
+import os from 'node:os';
+import { recordHumanDetection, summarizeDetectorMisses } from '../../src/monitoring/HumanDetectorSignal.js';
+
+describe('HumanDetectorSignal — human-as-detector heat map', () => {
+  let dir: string;
+  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hds-')); });
+  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
+
+  it('classifies a leaked correction as detector_miss', () => {
+    // Content the sycophancy regex does NOT match (no "absolutely right" etc.)
+    const sig = recordHumanDetection({ stateDir: dir, content: 'Sure, whatever you say sounds fine to me.', category: 'sycophancy' });
+    expect(sig.verdict).toBe('detector_miss');
+  });
+
+  it('classifies a caught-but-sent correction as warned_but_sent', () => {
+    // Content the sycophancy regex DOES match.
+    const sig = recordHumanDetection({ stateDir: dir, content: "You're absolutely right, I apologize for the confusion.", category: 'sycophancy' });
+    expect(sig.verdict).toBe('warned_but_sent');
+  });
+
+  it('classifies an unknown category as no_local_detector', () => {
+    const sig = recordHumanDetection({ stateDir: dir, content: 'anything', category: 'tone_mismatch' });
+    expect(sig.verdict).toBe('no_local_detector');
+  });
+
+  it('builds a heat map sorted worst-first', () => {
+    recordHumanDetection({ stateDir: dir, content: 'plain miss one', category: 'settling' });
+    recordHumanDetection({ stateDir: dir, content: 'plain miss two', category: 'settling' });
+    recordHumanDetection({ stateDir: dir, content: 'plain miss', category: 'temporal_staleness' });
+    const hm = summarizeDetectorMisses(dir);
+    expect(hm.total).toBe(3);
+    expect(hm.worst[0]).toEqual({ category: 'settling', misses: 2 });
+  });
+});
```

## Test evidence

Written but **not executed by this job** — the `instar-feature-parity` job runs outside
Instar's `/instar-dev` gate and does not build the Instar tree (PROP-379 constraint).
The test is designed against the real `checkConvergence` regex behavior:
- `"Sure, whatever you say sounds fine to me."` — no CHECKS[sycophancy] hit → `detector_miss`. ✅ (verified by reading the regex, `ConvergenceChecker.ts:73`)
- `"You're absolutely right, I apologize for the confusion."` — matches `you.re (absolutely...) right` AND `i apologize for` → flagged → `warned_but_sent`. ✅
- unknown category → `no_local_detector`. ✅

`/instar-dev` should run `pnpm vitest run tests/unit/human-detector-signal.test.ts` and
`pnpm tsc --noEmit` to confirm before landing.

## Typecheck status

Not run by this job (outside the Instar build). Module uses only `node:fs`, `node:path`,
and the existing `checkConvergence` export — no new deps, no ambient types. Expected clean.

## Files touched

- `src/monitoring/HumanDetectorSignal.ts` — new module (record + heat-map summarize).
- `tests/unit/human-detector-signal.test.ts` — new unit test (4 cases).
- (adoption) one call site in the human-correction/feedback path — see below.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "human-as-detector signal", run `/spec-converge`.
2. Apply the two-file diff above.
3. Wire one call site: wherever Instar ingests a human correction about a sent message
   (feedback handler in `src/messaging/*` or the `/feedback` command path), call
   `recordHumanDetection({ stateDir, content: offendingMessage, category, note })`.
   Map the human's complaint to a convergence category (a small `haiku`-tier classifier
   or a keyword map — reuse the fast-path style from `MessageSentinel`).
4. Optional surfacing: have `instar doctor` / a monitoring digest print
   `summarizeDetectorMisses(stateDir).worst` so leaking detectors surface routinely
   (mirrors Dawn surfacing the heat map at session start).
5. Run `/instar-dev` to produce the trace + side-effects artifact; commit through the gate.

## Why this respects the boundary

Pure additive module + test; no existing behavior changes until `/instar-dev` wires the
single call site through Instar's own governance. Dawn supplies the infrastructure wisdom;
Instar's `/spec-converge` + `/instar-dev` own the landing.
