import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateBetweenWindowAdmission } from '../../src/core/BetweenWindowAdmissionGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { validAdmissionPackage, writeAdmissionStore } from '../helpers/betweenWindowAdmissionFixture.js';

const tmpDirs: string[] = [];

function tmpState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'between-window-gate-'));
  tmpDirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  writeAdmissionStore(stateDir);
  return stateDir;
}

function receipt(pkg: Record<string, unknown>, idx = 0): Record<string, unknown> {
  const receipts = pkg.fullHistoryReceipts as Record<string, unknown>[];
  return receipts[idx].receipt as Record<string, unknown>;
}

function issueCodes(pkg: Record<string, unknown>, stateDir = tmpState()): string[] {
  return evaluateBetweenWindowAdmission({ stateDir, package: pkg }).issues.map((issue) => issue.code);
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/between-window-admission-gate.test.ts:28' });
  }
});

describe('BetweenWindowAdmissionGate', () => {
  it('admits a structurally valid package and surfaces the two known corpus mismatches', () => {
    const result = evaluateBetweenWindowAdmission({ stateDir: tmpState(), package: validAdmissionPackage() });

    expect(result.admitted).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.corpusMismatches.map((m) => m.scope)).toEqual([
      'pathway',
      'observer-1-topic-36966',
    ]);
  });

  it('refuses a window-only read', () => {
    const pkg = structuredClone(validAdmissionPackage());
    receipt(pkg).historyScope = 'window-only';

    expect(issueCodes(pkg)).toContain('WINDOW_ONLY_READ');
  });

  it('refuses a count without hash or rule', () => {
    const pkg = structuredClone(validAdmissionPackage());
    const r = receipt(pkg);
    delete r.corpusHash;
    r.extractionContract = { note: 'counted rows only' };

    expect(issueCodes(pkg)).toContain('COUNT_WITHOUT_HASH_OR_RULE');
  });

  it('refuses an assessment marked posted but absent from the store', () => {
    const pkg = structuredClone(validAdmissionPackage());
    const r = receipt(pkg);
    r.assessment = {
      status: 'posted',
      summary: 'claimed posted',
      storedMessageIds: [999999],
    };

    expect(issueCodes(pkg)).toContain('POSTED_ASSESSMENT_MISSING_FROM_STORE');
  });

  it('refuses an agent-account row classified as Justin', () => {
    const pkg = structuredClone(validAdmissionPackage());
    const artifact = receipt(pkg).semanticAuthorArtifact as Record<string, unknown>;
    artifact.agentThroughOperatorRows = [
      { account: 'observer-agent-account', accountKind: 'agent', classifiedAs: 'justin' },
    ];

    expect(issueCodes(pkg)).toContain('AGENT_ACCOUNT_CLASSIFIED_AS_JUSTIN');
  });

  it('refuses two full-history receipts from the same observer', () => {
    const pkg = structuredClone(validAdmissionPackage());
    const receipts = pkg.fullHistoryReceipts as Record<string, unknown>[];
    receipts[1].observer = 'observer-1';

    expect(issueCodes(pkg)).toContain('OBSERVER_RECEIPT_MISSING');
  });

  it('refuses when the known corpus mismatch disclosure is absent', () => {
    const pkg = structuredClone(validAdmissionPackage());
    delete pkg.knownCorpusMismatches;

    expect(issueCodes(pkg)).toContain('KNOWN_CORPUS_MISMATCH_NOT_SURFACED');
  });
});
