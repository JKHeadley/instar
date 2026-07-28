/**
 * Durable-Output Chokepoint ratchet (Durable-Output Hygiene Standard §3 + §4,
 * docs/specs/durable-output-hygiene-standard.md).
 *
 * Guarantees, structurally (the test-side enforcement arm of the standard):
 *   1. EVERY chokepoint in the inventory is well-formed — a valid scrubStatus +
 *      benchAxis, an argued `reason` on every exemption, an `owner` on every
 *      `pending` (Close the Loop — a pending chokepoint may not be ownerless).
 *   2. The PENDING set is pinned SHRINK-ONLY — a chokepoint may graduate
 *      `pending → wired`, never regress, and a NEW durable-output persistence path
 *      cannot silently multiply the pending set (it must be classified + pinned,
 *      a visible reviewed act). Same shape as the llm-bench-coverage ratchet.
 *   3. The EXEMPT set is pinned shrink-only AND each exemption argues a real
 *      reason (≥ 20 chars — a lazy "n/a" is refused).
 *   4. At least ONE chokepoint is `wired` — the class is genuinely guarded
 *      somewhere (the machinery is real, not spec-only).
 *   5. The durable-secret bench AXIS exists (spec §4): at least one chokepoint
 *      declares `benchAxis: 'covered'` with a concrete `benchTaskId` contract.
 *
 * This is what the Standards Enforcement Coverage audit reads to grade the
 * "What Persists Must Be Clean" standard `gate`, not `spec-only`.
 */
import { describe, it, expect } from 'vitest';
import {
  DURABLE_OUTPUT_CHOKEPOINTS,
  wiredChokepoints,
  pendingChokepoints,
  type DurableOutputChokepoint,
} from '../../src/data/durableOutputChokepoints.js';

// ── Pinned baselines (2026-07-03). SHRINK-ONLY: graduating a chokepoint to
// `wired` removes its name here; ADDING a name means a new durable-output
// persistence path is shipping WITHOUT a wired scrub — wire it, or classify it
// exempt with a real argument (both are visible, reviewed acts). ──
const PENDING_BASELINE = [
  'CartographerSweep',
  'RelationshipManager',
  'SelfKnowledgeTree',
  'SessionActivitySentinel',
  'knowledge-base-synthesizer',
  'learnings-registry',
].sort();

const EXEMPT_BASELINE = [
  'correction-learning',
  'private-view-publisher',
  'vector-index-eval-artifacts',
].sort();

const VALID_SCRUB_STATUS = new Set(['wired', 'pending', 'exempt']);
const VALID_BENCH_AXIS = new Set(['covered', 'pending', 'exempt']);
const MIN_REASON_CHARS = 20;

describe('durable-output-chokepoint ratchet', () => {
  it('every chokepoint is well-formed (valid status/axis, argued exemptions, owned pendings)', () => {
    const problems: string[] = [];
    for (const c of DURABLE_OUTPUT_CHOKEPOINTS) {
      const label = c.component || c.store;
      if (!VALID_SCRUB_STATUS.has(c.scrubStatus)) {
        problems.push(`${label}: invalid scrubStatus "${c.scrubStatus}"`);
      }
      if (!VALID_BENCH_AXIS.has(c.benchAxis)) {
        problems.push(`${label}: invalid benchAxis "${c.benchAxis}"`);
      }
      if (c.scrubStatus === 'exempt' && (c.reason ?? '').trim().length < MIN_REASON_CHARS) {
        problems.push(`${label}: scrubStatus exempt needs an argued reason (≥ ${MIN_REASON_CHARS} chars)`);
      }
      if (c.benchAxis === 'exempt' && (c.reason ?? '').trim().length < MIN_REASON_CHARS) {
        problems.push(`${label}: benchAxis exempt needs an argued reason (≥ ${MIN_REASON_CHARS} chars)`);
      }
      if (c.scrubStatus === 'pending' && !(c.owner ?? '').trim()) {
        problems.push(`${label}: scrubStatus pending needs an owner (Close the Loop)`);
      }
      if (c.benchAxis === 'covered' && !(c.benchTaskId ?? '').trim()) {
        problems.push(`${label}: benchAxis covered needs a benchTaskId contract`);
      }
      // Replicated-store receive path (multi-machine posture) must itself be valid.
      if (c.receivePath) {
        const rp = c.receivePath;
        if (!VALID_SCRUB_STATUS.has(rp.scrubStatus)) {
          problems.push(`${label} receivePath: invalid scrubStatus "${rp.scrubStatus}"`);
        }
        if (rp.scrubStatus === 'pending' && !(rp.owner ?? '').trim()) {
          problems.push(`${label} receivePath: pending needs an owner`);
        }
        if (rp.scrubStatus === 'exempt' && (rp.reason ?? '').trim().length < MIN_REASON_CHARS) {
          problems.push(`${label} receivePath: exempt needs an argued reason`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('PENDING set matches the pinned baseline (shrink-only — no silent new pending chokepoints)', () => {
    const actual = pendingChokepoints().map((c) => c.component).sort();
    expect(
      actual,
      'The pending chokepoint set drifted from the pinned baseline.\n' +
        'Graduating a chokepoint to `wired` (or classifying a new one `exempt` with a real reason) ' +
        'means REMOVING its name from PENDING_BASELINE in this test — a visible, reviewed act. ' +
        'Adding a name means a new durable-output persistence path is shipping without a wired scrub. ' +
        'docs/specs/durable-output-hygiene-standard.md §3.',
    ).toEqual(PENDING_BASELINE);
  });

  it('EXEMPT set matches the pinned baseline (shrink-only)', () => {
    const actual = DURABLE_OUTPUT_CHOKEPOINTS.filter((c: DurableOutputChokepoint) => c.scrubStatus === 'exempt')
      .map((c) => c.component)
      .sort();
    expect(actual).toEqual(EXEMPT_BASELINE);
  });

  it('at least one chokepoint is WIRED (the class is genuinely guarded — not spec-only)', () => {
    const wired = wiredChokepoints().map((c) => c.component);
    expect(wired.length, 'no wired chokepoint — the Layer-B machinery is not demonstrated anywhere').toBeGreaterThanOrEqual(1);
    expect(wired).toContain('SessionSummarySentinel');
  });

  it('the durable-secret bench axis exists (spec §4 — ≥1 covered chokepoint with a bench contract)', () => {
    const covered = DURABLE_OUTPUT_CHOKEPOINTS.filter((c) => c.benchAxis === 'covered' && (c.benchTaskId ?? '').trim());
    expect(
      covered.length,
      'The durable-secret bench axis has no covered case. The consolidated axis requires ≥1 ' +
        '`axis: "durable-secret"` case whose correct output describes-without-quoting (spec §4). ' +
        'Declare a chokepoint benchAxis:"covered" with a benchTaskId contract.',
    ).toBeGreaterThanOrEqual(1);
  });

  it('no duplicate chokepoint components (each store is classified exactly once)', () => {
    const names = DURABLE_OUTPUT_CHOKEPOINTS.map((c) => c.component);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate chokepoint component(s): ${dupes.join(', ')}`).toEqual([]);
  });
});
