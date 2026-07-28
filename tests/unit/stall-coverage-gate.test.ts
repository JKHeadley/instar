// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests — ApprenticeshipStallGate (framework-stall-coverage-matrix PR-B,
 * spec §5 gate rows).
 *
 * Covers, with both sides of every boundary:
 *  - the grandfathering predicate (createdAt vs ship date × version vs
 *    required-since minor — Frontloaded Decision 10);
 *  - live-read config resolution incl. the malformed-block safe default;
 *  - install provenance (derive / record / read / tamper-evidence);
 *  - degradation honesty: fleet → matrix-unverifiable-no-source (never a
 *    presence refusal); source-carrying + stripped tree → refusal;
 *    validator timeout → retryable reason distinct from invalidity;
 *    ledger-unreachable → retryable reason distinct from invalidity;
 *  - posture cross-check both sides AT THE GATE callsite (covered⇒live,
 *    contradictions, missing guard, exempt vacuous-with-reason);
 *  - closePath liveness both sides incl. delivered-commitment-as-dead-ref;
 *  - dryRun suppression of BOTH presence and validity refusals;
 *  - wiring integrity: the DEFAULT gate delegates to the REAL validator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import {
  ApprenticeshipStallGate,
  appendTamperEvidentDecisionRow,
  canonicalRowHash,
  degradedAcceptanceHash,
  deriveInstallProvenance,
  hasInstallProvenanceRecord,
  readInstallProvenance,
  recordInstallProvenanceIfAbsent,
  resolveStallGateConfig,
  runStallGateValidation,
  stallMatrixRequirement,
  versionBelowRequiredMinor,
  STALL_MATRIX_SHIP_DATE,
  type StallGateInstanceRef,
  type StallGateValidationInput,
} from '../../src/core/ApprenticeshipStallGate.js';
import { MatrixAcceptanceStore } from '../../src/core/ApprenticeshipMatrixAcceptance.js';
import { ApprenticeshipProgram } from '../../src/core/ApprenticeshipProgram.js';
import { STALL_CLASSES } from '../../src/data/stall-classes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GUARD_KEY = 'apprenticeship.stallCoverageGate.enabled'; // a REAL manifest key

let tmpDir: string;
let repoDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-gate-'));
  repoDir = path.join(tmpDir, 'repo');
  stateDir = path.join(tmpDir, 'repo', '.instar');
  fs.mkdirSync(path.join(repoDir, 'docs', 'frameworks'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'docs', 'specs', 'framework-stall-coverage-matrix.md'), '# stub\n');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/stall-coverage-gate.test.ts' });
});

// ── Fixture builders ─────────────────────────────────────────────────────────

function gapRow(classId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: classId,
    status: 'declared-gap',
    reason: 'no detector yet',
    issueRef: `stallclass::${classId}::testfw::gap`,
    closePath: 'CMT-OPEN',
    'liveness-surface': 'DEFECT: registry shows running',
    ...over,
  };
}

function coveredRow(classId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: classId,
    status: 'covered',
    detector: 'src/fake/Det.ts#FakeStallDetector',
    recovery: 'src/fake/Rec.ts#FakeStallRecovery',
    guardKey: GUARD_KEY,
    posture: 'live',
    evidence: `fixtures/ev-${classId}.md`,
    'liveness-surface': 'standby reports the truthful stuck state',
    ...over,
  };
}

function writeMatrix(rows: Array<Record<string, unknown>>, framework = 'testfw'): string {
  const fm = yaml.dump({ framework, 'stall-coverage': rows });
  const file = path.join(repoDir, 'docs', 'frameworks', `${framework}-stall-coverage.md`);
  fs.writeFileSync(file, `---\n${fm}---\n\nHuman notes.\n`);
  return file;
}

function fullGapMatrix(closePath = 'CMT-OPEN'): Array<Record<string, unknown>> {
  return STALL_CLASSES.map((c) => gapRow(c.id, { closePath, issueRef: `stallclass::${c.id}::testfw::gap` }));
}

/** A matrix whose first class is covered (with resolvable symbols + evidence). */
function matrixWithCovered(effectiveGuardOverrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  fs.mkdirSync(path.join(repoDir, 'src', 'fake'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'fake', 'Det.ts'), 'export const FakeStallDetector = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'fake', 'Rec.ts'), 'export const FakeStallRecovery = 1;\n');
  const first = STALL_CLASSES[0].id;
  fs.writeFileSync(
    path.join(repoDir, 'fixtures', `ev-${first}.md`),
    `FakeStallDetector fires on the raw tail below.\nstall-class: ${first}\nRAW: '· esc to interrupt' frozen frame\n`,
  );
  return [coveredRow(first, effectiveGuardOverrides), ...STALL_CLASSES.slice(1).map((c) => gapRow(c.id, { issueRef: `stallclass::${c.id}::testfw::gap` }))];
}

function writeGateConfig(cfg: unknown): void {
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ port: 4042, apprenticeship: { stallCoverageGate: cfg } }),
  );
}

function writeProvenance(installClass: 'source-carrying' | 'fleet'): void {
  appendTamperEvidentDecisionRow(path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl'), {
    ts: new Date().toISOString(),
    gate: 'install-provenance',
    installClass,
    signals: { developmentAgent: false, frameworksDir: true, specFile: true },
  });
}

type FetchRule = (route: string, init?: RequestInit) => { status: number; body: unknown } | 'network-error';

function makeFetch(rule: FetchRule): { impl: typeof fetch; calls: Array<{ route: string; method: string }> } {
  const calls: Array<{ route: string; method: string }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const route = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    calls.push({ route, method: init?.method ?? 'GET' });
    const out = rule(route, init);
    if (out === 'network-error') throw new TypeError('fetch failed');
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const healthyFetch = (over?: FetchRule): FetchRule => (route, init) => {
  if (over) {
    const o = over(route, init);
    if (o !== undefined && o !== null) return o;
  }
  if (route === '/guards') return { status: 200, body: { guards: [{ key: GUARD_KEY, effective: 'on-confirmed' }] } };
  if (route.startsWith('/commitments/CMT-OPEN')) return { status: 200, body: { status: 'pending' } };
  if (route.startsWith('/commitments/CMT-DONE')) return { status: 200, body: { status: 'delivered' } };
  if (route.startsWith('/commitments/')) return { status: 404, body: { error: 'not found' } };
  if (route === '/attention') return { status: 200, body: { ok: true } };
  if (route === '/evolution/actions') return { status: 200, body: { actions: [] } };
  return { status: 404, body: null };
};

function makeGate(opts: {
  fetchRule?: FetchRule;
  acceptance?: MatrixAcceptanceStore | null;
  currentVersion?: string;
  timeoutRun?: boolean;
  log?: (m: string) => void;
} = {}): { gate: ApprenticeshipStallGate; calls: Array<{ route: string; method: string }> } {
  const { impl, calls } = makeFetch(opts.fetchRule ?? healthyFetch());
  const gate = new ApprenticeshipStallGate({
    projectDir: repoDir,
    stateDir,
    loopback: { port: 4042, authToken: 't' },
    acceptance: opts.acceptance ?? null,
    fetchImpl: impl,
    getCurrentVersion: () => opts.currentVersion ?? '1.3.900',
    log: opts.log,
    // In-process real validator (behavior-parity path); the timeout case
    // injects a runner that reports timedOut.
    runValidation: opts.timeoutRun
      ? async () => ({ ok: false as const, timedOut: true })
      : async (input: StallGateValidationInput) => ({ ok: true as const, output: runStallGateValidation(input) }),
  });
  return { gate, calls };
}

const inst = (over: Partial<StallGateInstanceRef> = {}): StallGateInstanceRef => ({
  id: 'test-instance',
  instanceType: 'mentorship',
  framework: 'testfw',
  createdAt: '2026-07-19T00:00:00.000Z', // post-ship
  ...over,
});

/** Mint + bind a whole-set acceptance for the current matrix content. */
function acceptCurrent(store: MatrixAcceptanceStore, instanceId: string): string {
  const out = runStallGateValidation({ repoRoot: repoDir, framework: 'testfw', nowIso: new Date().toISOString() });
  const hash = out.result!.contentHash;
  const ch = store.mintChallenge({ instanceId, framework: 'testfw', scope: 'whole-set', contentHash: hash, rowIds: [] });
  const bound = store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: hash });
  expect(bound.ok).toBe(true);
  return hash;
}

// ── Grandfathering predicate (Decision 10 — both sides of both boundaries) ──

describe('stallMatrixRequirement', () => {
  it('pre-ship instance below the required-since minor → grandfathered-warning', () => {
    expect(stallMatrixRequirement('mentorship', '2026-07-17T23:59:59Z', { currentVersion: '1.3.999' })).toBe('grandfathered-warning');
  });

  it('pre-ship instance AT/ABOVE the required-since minor → required', () => {
    expect(stallMatrixRequirement('mentorship', '2026-07-17T23:59:59Z', { currentVersion: '1.4.0' })).toBe('required');
    expect(stallMatrixRequirement('mentorship', '2026-01-01T00:00:00Z', { currentVersion: '2.0.0' })).toBe('required');
  });

  it('post-ship instance → required regardless of version (both instance types)', () => {
    expect(stallMatrixRequirement('mentorship', '2026-07-18T00:00:01Z', { currentVersion: '1.3.0' })).toBe('required');
    expect(stallMatrixRequirement('apprenticeship', '2027-01-01T00:00:00Z', { currentVersion: '1.3.0' })).toBe('required');
  });

  it('versionBelowRequiredMinor: both sides + unparseable is NOT below (strict direction)', () => {
    expect(versionBelowRequiredMinor('1.3.999', '1.4.0')).toBe(true);
    expect(versionBelowRequiredMinor('1.4.0', '1.4.0')).toBe(false);
    expect(versionBelowRequiredMinor('1.4.1', '1.4.0')).toBe(false);
    expect(versionBelowRequiredMinor('2.0.0', '1.4.0')).toBe(false);
    expect(versionBelowRequiredMinor('garbage', '1.4.0')).toBe(false);
  });

  it('ship-date boundary: an ISO datetime on the ship date sorts POST-ship', () => {
    expect(`${STALL_MATRIX_SHIP_DATE}T00:00:00Z` > STALL_MATRIX_SHIP_DATE).toBe(true);
  });
});

// ── Config resolution (Decision 11) ──────────────────────────────────────────

describe('resolveStallGateConfig', () => {
  it('absence resolves to the inline default {enabled:true, dryRun:true}', () => {
    expect(resolveStallGateConfig(undefined)).toEqual({ enabled: true, dryRun: true });
    expect(resolveStallGateConfig(null)).toEqual({ enabled: true, dryRun: true });
  });

  it('explicit values are honored; partial blocks default the rest', () => {
    expect(resolveStallGateConfig({ enabled: true, dryRun: false })).toEqual({ enabled: true, dryRun: false });
    expect(resolveStallGateConfig({ enabled: false })).toEqual({ enabled: false, dryRun: true });
  });

  it('a malformed block resolves to the SAFE default with one loud log line', () => {
    const logs: string[] = [];
    expect(resolveStallGateConfig('bogus', (m) => logs.push(m))).toEqual({ enabled: true, dryRun: true });
    expect(resolveStallGateConfig({ enabled: 'yes' }, (m) => logs.push(m))).toEqual({ enabled: true, dryRun: true });
    expect(resolveStallGateConfig([], (m) => logs.push(m))).toEqual({ enabled: true, dryRun: true });
    expect(logs.length).toBe(3);
    expect(logs[0]).toMatch(/malformed/);
  });
});

// ── Install provenance ───────────────────────────────────────────────────────

describe('install provenance', () => {
  it('derives source-carrying from the analyzable tree, fleet from its absence', () => {
    expect(deriveInstallProvenance(repoDir).installClass).toBe('source-carrying');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
    try {
      expect(deriveInstallProvenance(bare).installClass).toBe('fleet');
      // The dev-agent signal alone also classifies source-carrying.
      expect(deriveInstallProvenance(bare, { developmentAgent: true }).installClass).toBe('source-carrying');
    } finally {
      SafeFsExecutor.safeRmSync(bare, { recursive: true, force: true, operation: 'tests/unit/stall-coverage-gate.test.ts' });
    }
  });

  it('recordInstallProvenanceIfAbsent is presence-scan idempotent', () => {
    const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    expect(hasInstallProvenanceRecord(logPath)).toBe(false);
    expect(recordInstallProvenanceIfAbsent(repoDir, stateDir)).toBe('recorded');
    expect(recordInstallProvenanceIfAbsent(repoDir, stateDir)).toBe('present');
    const read = readInstallProvenance(logPath);
    expect(read).toEqual({ ok: true, installClass: 'source-carrying' });
    expect(fs.readFileSync(logPath, 'utf8').trim().split('\n').length).toBe(1);
  });

  it('a tampered provenance row reads INVALID (tamper-evident integrity hash)', () => {
    recordInstallProvenanceIfAbsent(repoDir, stateDir);
    const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    const tampered = fs.readFileSync(logPath, 'utf8').replace('"source-carrying"', '"fleet"');
    fs.writeFileSync(logPath, tampered);
    expect(readInstallProvenance(logPath)).toEqual({ ok: false, error: 'invalid' });
  });

  it('no record → missing', () => {
    expect(readInstallProvenance(path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl'))).toEqual({ ok: false, error: 'missing' });
  });
});

// ── Degradation honesty (spec §5) ────────────────────────────────────────────

describe('gate degradation honesty', () => {
  it('NO provenance record → refuse "provenance-record-missing — re-run update/migration"', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    const { gate } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('provenance-record-missing — re-run update/migration');
  });

  it('fleet provenance → matrix-unverifiable-no-source verdict, NEVER a presence refusal; acceptance carries the sign-off', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('fleet');
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate } = makeGate({ acceptance: store });

    // Without acceptance: refused for acceptance, not for matrix presence.
    const refused = await gate.evaluateForTransition(inst(), 'full');
    expect(refused.allow).toBe(false);
    expect(refused.report.verdict === 'matrix-unverifiable-no-source' || refused.reason.includes('matrix-unverifiable-no-source')).toBe(true);
    expect(refused.reason).not.toContain('matrix-file-missing');

    // With a recorded degraded acceptance: allowed.
    const hash = degradedAcceptanceHash('test-instance', 'testfw');
    const ch = store.mintChallenge({ instanceId: 'test-instance', framework: 'testfw', scope: 'degraded', contentHash: hash, rowIds: [] });
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: hash }).ok).toBe(true);
    const allowed = await gate.evaluateForTransition(inst(), 'full');
    expect(allowed.allow).toBe(true);
    expect(allowed.report.verdict).toBe('matrix-unverifiable-no-source');
  });

  it('source-carrying provenance + stripped tree → REFUSAL with a named reason (degrade path cannot be manufactured)', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    SafeFsExecutor.safeRmSync(path.join(repoDir, 'docs', 'frameworks'), { recursive: true, force: true, operation: 'tests/unit/stall-coverage-gate.test.ts' });
    const { gate } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('source-tree-unanalyzable');
    expect(v.reason).not.toContain('matrix-unverifiable-no-source');
  });

  it('validator timeout fails CLOSED with a reason DISTINCT from invalidity', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix());
    const { gate } = makeGate({ timeoutRun: true });
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('validator-timeout (retry)');
    expect(v.reason).toContain('NOT a matrix-invalid verdict');
  });

  it('ledger unreachable → named retryable refusal, never conflated with matrix invalidity', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix());
    const { gate } = makeGate({ fetchRule: () => 'network-error' });
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('ledger-unreachable (retry)');
    expect(v.reason).toContain('NOT a matrix-invalid verdict');
  });
});

// ── Posture cross-check at the GATE callsite (both sides) ────────────────────

describe('guard posture cross-check (gate callsite)', () => {
  async function fullGateWith(effective: string | null): Promise<ReturnType<ApprenticeshipStallGate['evaluateForTransition']>> {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(matrixWithCovered());
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate } = makeGate({
      acceptance: store,
      fetchRule: healthyFetch((route) => {
        if (route === '/guards') {
          return { status: 200, body: { guards: effective === null ? [] : [{ key: GUARD_KEY, effective }] } };
        }
        return undefined as never;
      }),
    });
    acceptCurrent(store, 'test-instance');
    return gate.evaluateForTransition(inst(), 'full');
  }

  it('covered row whose guard classifies LIVE passes', async () => {
    const v = await fullGateWith('on-confirmed');
    expect(v.allow).toBe(true);
    expect(v.report.guardPairs).toEqual([
      expect.objectContaining({ guardKey: GUARD_KEY, check: 'ok', effective: 'on-confirmed' }),
    ]);
  });

  it('covered row whose guard classifies OFF is refused (posture-contradicts-inventory)', async () => {
    const v = await fullGateWith('off');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('posture-contradicts-inventory');
    expect(v.reason).toContain(`class '${STALL_CLASSES[0].id}'`);
  });

  it('covered row whose guardKey is absent from the inventory is refused (guard-missing-from-inventory)', async () => {
    const v = await fullGateWith(null);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('guard-missing-from-inventory');
  });

  it('an exempt:<id> guardKey records vacuous-with-reason and passes', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    // StuckSignatureClassifier is a REAL manifest exemption (NOT_A_GUARD).
    writeMatrix(matrixWithCovered({ guardKey: 'exempt:StuckSignatureClassifier' }));
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate } = makeGate({ acceptance: store });
    acceptCurrent(store, 'test-instance');
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(true);
    expect(v.report.guardPairs).toEqual([
      expect.objectContaining({ guardKey: 'exempt:StuckSignatureClassifier', check: 'vacuous-with-reason' }),
    ]);
  });
});

// ── closePath liveness (both sides, incl. delivered-as-dead) ─────────────────

describe('closePath liveness (gate callsite)', () => {
  async function gateWithClosePath(closePath: string): Promise<{ v: Awaited<ReturnType<ApprenticeshipStallGate['evaluateForTransition']>>; calls: Array<{ route: string; method: string }> }> {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix(closePath));
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate, calls } = makeGate({ acceptance: store });
    acceptCurrent(store, 'test-instance');
    const v = await gate.evaluateForTransition(inst(), 'full');
    return { v, calls };
  }

  it('an OPEN commitment ref passes', async () => {
    const { v } = await gateWithClosePath('CMT-OPEN');
    expect(v.allow).toBe(true);
    expect(v.report.flaggedRows).toEqual([]);
  });

  it('a 404 ref is a DEAD ref: rows flagged + refusal + ONE aggregated attention item', async () => {
    const { v, calls } = await gateWithClosePath('CMT-GONE');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('closepath-dead-ref');
    expect(v.report.flaggedRows.length).toBe(STALL_CLASSES.length);
    // ONE aggregated attention POST — never one per row.
    expect(calls.filter((c) => c.route === '/attention' && c.method === 'POST').length).toBe(1);
  });

  it('a DELIVERED commitment is a dead ref (a closed anchor is no anchor)', async () => {
    const { v } = await gateWithClosePath('CMT-DONE');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('closepath-dead-ref');
  });

  it('a NON-404 HTTP error (500) on the commitments ledger is ledger-unreachable — never a dead ref', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix('CMT-ERR'));
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate } = makeGate({
      acceptance: store,
      fetchRule: healthyFetch((route) => {
        if (route.startsWith('/commitments/CMT-ERR')) return { status: 500, body: { error: 'boom' } };
        return undefined as never;
      }),
    });
    acceptCurrent(store, 'test-instance');
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('ledger-unreachable (retry)');
    expect(v.reason).not.toContain('closepath-dead-ref');
    expect(v.report.flaggedRows).toEqual([]);
  });

  it('the aggregated attention item is DEDUPED per (instance, matrix content) via a deterministic id', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix('CMT-GONE'));
    const store = new MatrixAcceptanceStore({ stateDir });
    const attentionIds: string[] = [];
    const { gate } = makeGate({
      acceptance: store,
      fetchRule: (route, init) => {
        if (route === '/attention' && init?.method === 'POST') {
          attentionIds.push((JSON.parse(String(init.body)) as { id: string }).id);
          return { status: 200, body: { ok: true } };
        }
        return healthyFetch()(route, init)!;
      },
    });
    acceptCurrent(store, 'test-instance');
    await gate.evaluateForTransition(inst(), 'full');
    await gate.evaluateForTransition(inst(), 'full'); // retry over the SAME matrix state
    expect(attentionIds.length).toBe(2);
    expect(attentionIds[0]).toMatch(/^stall-matrix-[0-9a-f]{24}$/);
    expect(attentionIds[1]).toBe(attentionIds[0]); // same id ⇒ createAttentionItem dedupes server-side
  });

  it('pending-mint rows are exempt from liveness (the live-check job owns the mint)', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(STALL_CLASSES.map((c) => gapRow(c.id, {
      issueRef: `stallclass::${c.id}::testfw::gap`,
      closePath: 'pending-mint',
      seededAt: new Date().toISOString().slice(0, 10),
      reason: 'new-class, unreviewed',
    })));
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate, calls } = makeGate({ acceptance: store });
    acceptCurrent(store, 'test-instance');
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(true);
    expect(calls.some((c) => c.route.startsWith('/commitments/'))).toBe(false);
  });
});

// ── dryRun suppression + grandfathered warning + provisional depth ───────────

describe('dryRun + grandfathering + provisional depth', () => {
  it('dryRun suppresses BOTH presence and validity refusals; would-refuse is logged', async () => {
    writeGateConfig({ enabled: true, dryRun: true });
    writeProvenance('source-carrying');
    const { gate } = makeGate();

    // Presence: no matrix file at all.
    const presence = await gate.evaluateForTransition(inst(), 'full');
    expect(presence.allow).toBe(true);
    expect(presence.dryRunSuppressed).toBe(true);
    expect(presence.reason).toContain('would refuse');

    // Validity: matrix missing a class row.
    writeMatrix(fullGapMatrix().slice(1));
    const validity = await gate.evaluateForTransition(inst(), 'full');
    expect(validity.allow).toBe(true);
    expect(validity.dryRunSuppressed).toBe(true);

    const log = fs.readFileSync(path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl'), 'utf8');
    const rows = log.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.gate === 'stall-matrix');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.verdict).toBe('would-refuse');
      expect(r.allow).toBe(true);
      expect(r.dryRun).toBe(true);
    }
  });

  it('a pre-ship instance is grandfathered with a WARNING row (allow) while version < required-since', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    const { gate } = makeGate({ currentVersion: '1.3.900' });
    const v = await gate.evaluateForTransition(inst({ createdAt: '2026-07-01T00:00:00Z' }), 'full');
    expect(v.allow).toBe(true);
    expect(v.report.verdict).toBe('grandfathered-warning');
    expect(v.report.warnings[0]).toContain('REQUIRED from v1.4.0');
  });

  it('provisional depth is hermetic ONLY: a valid matrix passes with ZERO loopback calls', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix('CMT-NEVER-CHECKED'));
    const { gate, calls } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'provisional');
    expect(v.allow).toBe(true);
    expect(calls.length).toBe(0); // no liveness, no guards, no acceptance at pending→active
  });

  it('provisional refuses on an invalid matrix with class-id + rule reasons (enforce mode)', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix().slice(1)); // one class row missing
    const { gate } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'provisional');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("rule 'class-row-missing'");
    expect(v.reason).toContain(`class '${STALL_CLASSES[0].id}'`);
  });

  it('gate disabled by config skips entirely', async () => {
    writeGateConfig({ enabled: false });
    const { gate } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(true);
    expect(v.report.verdict).toBe('skipped-disabled');
  });
});

// ── Wiring integrity (spec §5: the gate delegates to the REAL validator) ─────

describe('wiring integrity', () => {
  it('the DEFAULT gate (no injected runner) delegates to the REAL validator — a real rule violation surfaces', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix().slice(1)); // real defect: class-row-missing
    // NO runValidation injection: the default path (worker → in-process
    // fallback under vitest) must reach the real validateStallMatrixFile.
    const gate = new ApprenticeshipStallGate({
      projectDir: repoDir,
      stateDir,
      loopback: { port: 4042, authToken: 't' },
      acceptance: null,
      fetchImpl: makeFetch(healthyFetch()).impl,
      getCurrentVersion: () => '1.3.900',
      log: () => {},
    });
    const v = await gate.evaluateForTransition(inst(), 'provisional');
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("rule 'class-row-missing'"); // only the REAL validator produces this
  }, 15_000);

  it('ApprenticeshipProgram default-constructs a non-null stall gate (not a no-op dep)', () => {
    const p = new ApprenticeshipProgram({ stateDir, projectDir: repoDir });
    expect(p.getStallGate()).not.toBeNull();
    expect(p.getStallGate()).toBeInstanceOf(ApprenticeshipStallGate);
  });

  it('decision records carry the validated contentHash (single-read, no TOCTOU)', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    writeMatrix(fullGapMatrix());
    const store = new MatrixAcceptanceStore({ stateDir });
    const { gate } = makeGate({ acceptance: store });
    const expectedHash = acceptCurrent(store, 'test-instance');
    const v = await gate.evaluateForTransition(inst(), 'full');
    expect(v.allow).toBe(true);
    const rows = fs.readFileSync(path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.gate === 'stall-matrix');
    expect(rows.at(-1).contentHash).toBe(expectedHash);
  });

  it('refusal output never contains rejected raw field content (Decision 16)', async () => {
    writeGateConfig({ enabled: true, dryRun: false });
    writeProvenance('source-carrying');
    const SMOKING_GUN = 'SECRET-PAYLOAD-NEVER-ECHO';
    writeMatrix([
      { class: 'clean-turn-end', status: 'declared-gap', reason: SMOKING_GUN, issueRef: 'INVALID UPPER REF!', closePath: SMOKING_GUN, 'liveness-surface': SMOKING_GUN },
      ...fullGapMatrix().slice(1),
    ]);
    const { gate } = makeGate();
    const v = await gate.evaluateForTransition(inst(), 'provisional');
    expect(v.allow).toBe(false);
    expect(v.reason).not.toContain(SMOKING_GUN);
    expect(JSON.stringify(v.report.issues)).not.toContain(SMOKING_GUN);
  });
});

// ── canonicalRowHash (Decision 20 binding granularity) ───────────────────────

describe('canonicalRowHash', () => {
  it('is stable under key reordering and sensitive to any field change', () => {
    const a = { class: 'quota-wall', status: 'declared-gap', closePath: 'CMT-1' };
    const b = { closePath: 'CMT-1', class: 'quota-wall', status: 'declared-gap' };
    expect(canonicalRowHash(a)).toBe(canonicalRowHash(b));
    expect(canonicalRowHash({ ...a, closePath: 'CMT-2' })).not.toBe(canonicalRowHash(a));
  });
});
