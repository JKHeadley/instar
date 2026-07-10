// safe-fs-allow: test file — tmpdir fixtures only.

/**
 * Tier-1 — SelfActionGovernor durable admission state (FD14 / companion §5.2).
 *
 * Covers: admission state survives a bounce (count floor holds across
 * restart); a crash-loop bouncing FASTER than the flush cadence AND the
 * debounce still accretes the durable floor (leading-edge first-post-rehydrate
 * flush); recency validation drops stale state; missing/corrupt snapshot WITH
 * prior flush evidence → conservative posture + loud state-reset row +
 * attention signal; genuinely fresh install → silent empty; restart-shed row
 * on any boot with a non-zero last-known queue population; pessimistic
 * carry-forward with a NON-ZERO floor after unclean shutdown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SelfActionGovernorCore,
  initSelfActionGovernor,
  resetSelfActionGovernorModuleForTest,
  type SelfActionGovernorDeps,
} from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
import type { DerivedTarget, GovernorAttentionItem } from '../../src/monitoring/selfaction/types.js';

let tmp: string;
let vnow: number;
let attention: GovernorAttentionItem[];

function deps(over: Partial<SelfActionGovernorDeps> = {}): SelfActionGovernorDeps {
  return {
    stateDir: tmp,
    readEmergencyDisable: () => false,
    readClassesConfig: () => ({ 'age-kill-backoff': { mode: 'enforce' } }),
    emitAttention: (item) => {
      attention.push(item);
    },
    now: () => vnow,
    ...over,
  };
}

/** Simulate a process bounce: drop the in-process anchor WITHOUT a graceful
 *  dispose (unclean) or WITH one (clean), then re-init from disk. */
function bounce(gov: SelfActionGovernorCore | null, clean: boolean): SelfActionGovernorCore {
  if (gov && clean) gov.dispose();
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  return initSelfActionGovernor(deps());
}

const t = (key: string): DerivedTarget => ({ key, classId: 'session', keyIsVolatile: false });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-snap-'));
  vnow = 5_000_000_000;
  attention = [];
});

afterEach(() => {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/self-action-governor-snapshot.test.ts' });
});

const snapshotPath = () => path.join(tmp, 'state', 'self-action-governor.json');
const aggregatesPath = () => path.join(tmp, 'state', 'self-action-governor-aggregates.json');

describe('durable admission state (FD14)', () => {
  it('the count floor HOLDS across a clean bounce mid-window (no budget refill)', () => {
    let gov = initSelfActionGovernor(deps());
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 5; i++) expect(h.admitSync(t('session:s1')).outcome).toBe('allow');
    gov.flushSnapshot(false);
    // Bounce mid-window (clean shutdown flushes via dispose).
    gov = bounce(gov, true);
    const h2 = gov.for('age-kill-backoff');
    vnow += 60_000; // still inside the 60-min window
    const after = h2.admitSync(t('session:s1'));
    // The rehydrated per-target count keeps binding — a restart never hands
    // the runaway loop a fresh count budget.
    expect(after.outcome).toBe('queue');
    expect(after.reason).toBe('per-target-ceiling');
  });

  it('a crash-loop bouncing FASTER than the flush debounce still accretes the durable floor (leading-edge flush)', () => {
    // Each incarnation: rehydrate, ONE admission (which fires the IMMEDIATE
    // leading-edge first-post-rehydrate flush), then an UNCLEAN death within
    // the 1s debounce. The window total must accrete across incarnations —
    // the loop can never regain a full budget per bounce.
    let gov: SelfActionGovernorCore | null = null;
    for (let i = 0; i < 70; i++) {
      gov = bounce(gov, false); // unclean — no dispose flush
      const h = gov.for('age-kill-backoff');
      h.admitSync(t(`session:s${i}`)); // distinct targets — the TOTAL window floor is the subject
      vnow += 200; // 200ms per incarnation — far inside cadence AND debounce
    }
    gov = bounce(gov, false);
    const h = gov.for('age-kill-backoff');
    const posture = gov.getPosture().classes.find((c) => c.controllerId === 'age-kill-backoff')!;
    // Rehydrated carry reflects the accreted admissions (pessimistic
    // carry-forward adds a non-zero increment per unclean interval).
    expect(posture.windowCount).toBeGreaterThanOrEqual(60);
    const verdict = h.admitSync(t('session:fresh'));
    expect(verdict.outcome).toBe('queue'); // the total ceiling binds — budget never refilled
  });

  it('recency validation DROPS state older than the class window (with a state-reset row when non-trivial)', () => {
    let gov = initSelfActionGovernor(deps());
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 5; i++) h.admitSync(t('session:s1'));
    gov.dispose();
    resetSelfActionGovernorModuleForTest();
    resetAnchorForTest();
    vnow += 3 * 60 * 60_000; // 3 hours later — well past the 60-min window
    gov = initSelfActionGovernor(deps());
    const h2 = gov.for('age-kill-backoff');
    // Stale history is DROPPED — a restored snapshot can only re-impose a
    // floor current conditions still justify.
    expect(h2.admitSync(t('session:s1')).outcome).toBe('allow');
    expect(gov.readAllAuditRowsForTest().some((r) => r.type === 'state-reset')).toBe(true);
  });

  it('MISSING snapshot WITH prior flush evidence → conservative posture + loud state-reset + attention', () => {
    let gov = initSelfActionGovernor(deps());
    gov.for('age-kill-backoff').admitSync(t('session:s1'));
    gov.flushSnapshot(false); // writes snapshot AND aggregates (the evidence)
    gov.dispose();
    resetSelfActionGovernorModuleForTest();
    resetAnchorForTest();
    SafeFsExecutor.safeRmSync(snapshotPath(), { force: true, operation: 'tests/unit/self-action-governor-snapshot.test.ts' }); // the budget-refill lever: delete the snapshot only
    gov = initSelfActionGovernor(deps());
    expect(gov.readAllAuditRowsForTest().some((r) => r.type === 'state-reset')).toBe(true);
    expect(attention.some((i) => i.id.includes('state-reset'))).toBe(true);
  });

  it('CORRUPT snapshot WITH prior flush evidence → same loud conservative disposition', () => {
    let gov = initSelfActionGovernor(deps());
    gov.for('age-kill-backoff').admitSync(t('session:s1'));
    gov.flushSnapshot(false);
    gov.dispose();
    resetSelfActionGovernorModuleForTest();
    resetAnchorForTest();
    fs.writeFileSync(snapshotPath(), '{ not json !!!');
    gov = initSelfActionGovernor(deps());
    expect(gov.readAllAuditRowsForTest().some((r) => r.type === 'state-reset')).toBe(true);
  });

  it('a genuinely FRESH install (no prior flush evidence) starts empty and SILENT', () => {
    const gov = initSelfActionGovernor(deps());
    expect(fs.existsSync(aggregatesPath())).toBe(false);
    expect(gov.readAllAuditRowsForTest().some((r) => r.type === 'state-reset')).toBe(false);
    expect(attention.length).toBe(0);
  });

  it('ANY boot with a non-zero last-known queue population writes ONE restart-shed row (clean-tagged)', () => {
    let gov = initSelfActionGovernor(deps());
    const h = gov.for('age-kill-backoff');
    // Fill the per-target ceiling, then queue an intent.
    for (let i = 0; i < 6; i++) h.admitSync(t('session:s1'));
    const posture = gov.getPosture().classes.find((c) => c.controllerId === 'age-kill-backoff')!;
    expect(posture.queueDistinctTargets).toBe(1);
    gov = bounce(gov, true); // clean shutdown — the COMMON path must not be a silent shed
    const rows = gov.readAllAuditRowsForTest().filter((r) => r.type === 'restart-shed');
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain('clean');
  });

  it('the snapshot + aggregates files land under state/ with the self-action-governor prefix (backup-excluded)', () => {
    const gov = initSelfActionGovernor(deps());
    gov.for('age-kill-backoff').admitSync(t('session:s1'));
    gov.flushSnapshot(false);
    expect(fs.existsSync(snapshotPath())).toBe(true);
    expect(fs.existsSync(aggregatesPath())).toBe(true);
    // Both share the BLOCKED_PATH_PREFIXES prefix 'state/self-action-governor'.
    expect(path.relative(tmp, snapshotPath()).startsWith('state/self-action-governor')).toBe(true);
    expect(path.relative(tmp, aggregatesPath()).startsWith('state/self-action-governor')).toBe(true);
  });
});
