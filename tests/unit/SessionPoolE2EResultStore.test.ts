/**
 * Tier-1 tests for SessionPoolE2EResultStore (§Rollout): signed, append-only E2E
 * result log — record/read latest-per-stage (a later red supersedes an earlier
 * green), append-only history preserved, and signature tamper-evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPoolE2EResultStore, canonicalE2ERow } from '../../src/core/SessionPoolE2EResultStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Trivial deterministic signer for the test (production wires HMAC/Ed25519).
const sign = (c: string) => `sig::${c}`;
const verifySig = (c: string, s: string) => s === `sig::${c}`;

describe('SessionPoolE2EResultStore (§Rollout)', () => {
  let dir: string;
  let store: SessionPoolE2EResultStore;
  let n: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-store-'));
    n = 0;
    store = new SessionPoolE2EResultStore({ filePath: path.join(dir, 'results.json'), sign, verifySig, now: () => 1_700_000_000_000 + (n++) });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/SessionPoolE2EResultStore.test.ts' }));

  it('records a signed row that reads back + verifies', () => {
    const row = store.recordResult(1, 'green', 'abc123', 'tests/e2e/x.test.ts');
    expect(store.getLatestForStage(1)).toMatchObject({ stage: 1, result: 'green', commitSha: 'abc123' });
    expect(store.verify(row)).toBe(true);
  });

  it('getLatestForStage returns the MOST RECENT row (a later red supersedes an earlier green)', () => {
    store.recordResult(1, 'green', 'abc', 'e1');
    store.recordResult(1, 'red', 'abc', 'e2');
    expect(store.getLatestForStage(1)?.result).toBe('red');
    // append-only: the green is still in the history.
    expect(store.all().filter(r => r.stage === 1).map(r => r.result)).toEqual(['green', 'red']);
  });

  it('keeps stages independent', () => {
    store.recordResult(0, 'green', 'abc', 'e0');
    store.recordResult(1, 'red', 'abc', 'e1');
    expect(store.getLatestForStage(0)?.result).toBe('green');
    expect(store.getLatestForStage(1)?.result).toBe('red');
    expect(store.getLatestForStage(2)).toBeNull();
  });

  it('a tampered row fails verification', () => {
    const row = store.recordResult(1, 'green', 'abc', 'e1');
    const tampered = { ...row, result: 'red' as const }; // signature still over the green canonical
    expect(store.verify(tampered)).toBe(false);
    // sanity: an honest re-sign of the tampered content WOULD verify (proves the canonical is what's signed)
    expect(verifySig(canonicalE2ERow(tampered), sign(canonicalE2ERow(tampered)))).toBe(true);
  });

  it('tolerates a missing file (empty) and a torn trailing line', () => {
    expect(store.getLatestForStage(0)).toBeNull();
    store.recordResult(0, 'green', 'abc', 'e0');
    fs.appendFileSync(path.join(dir, 'results.json'), '{ not json\n');
    expect(store.getLatestForStage(0)?.result).toBe('green'); // torn line skipped
  });
});
