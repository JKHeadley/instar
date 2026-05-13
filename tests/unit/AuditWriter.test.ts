/**
 * Unit tests for AuditWriter — verified-append audit log.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A12 / A29 / A42.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditWriter, type AuditEntry } from '../../src/remediation/audit/AuditWriter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    entryId: overrides?.entryId ?? crypto.randomUUID(),
    attemptId: overrides?.attemptId ?? 'attempt-001',
    outcome: overrides?.outcome ?? 'started',
    runbookId: overrides?.runbookId ?? 'node-abi-mismatch',
    subsystem: overrides?.subsystem ?? 'memory',
    reason: overrides?.reason,
    timestamp: overrides?.timestamp ?? Date.now(),
    monotonicTs: overrides?.monotonicTs ?? process.hrtime.bigint(),
    auditToken: overrides?.auditToken ?? Buffer.from('valid-token'),
  };
}

describe('AuditWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-writer-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/AuditWriter.test.ts:afterEach',
    });
  });

  it('persists entries whose token verifies', async () => {
    const writer = new AuditWriter(tmpDir, {
      machineId: 'm-test',
      tokenVerifier: (e) => e.auditToken.toString() === 'valid-token',
    });
    const result = await writer.append(makeEntry());
    expect(result.accepted).toBe(true);

    const projectionPath = path.join(
      tmpDir,
      'remediation',
      'audit-projection-m-test.jsonl'
    );
    expect(fs.existsSync(projectionPath)).toBe(true);
    const lines = fs.readFileSync(projectionPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    expect(writer.recentTail()).toHaveLength(1);
  });

  it('routes invalid-token entries to audit-rejected.jsonl', async () => {
    const writer = new AuditWriter(tmpDir, {
      machineId: 'm-test',
      tokenVerifier: (e) => e.auditToken.toString() === 'valid-token',
    });
    const result = await writer.append(
      makeEntry({ auditToken: Buffer.from('forged-token') })
    );
    expect(result.accepted).toBe(false);
    expect(result.rejectedReason).toBe('token-verify-failed');

    const projectionPath = path.join(
      tmpDir,
      'remediation',
      'audit-projection-m-test.jsonl'
    );
    expect(fs.existsSync(projectionPath)).toBe(false);
    const rejectedPath = path.join(tmpDir, 'remediation', 'audit-rejected.jsonl');
    expect(fs.existsSync(rejectedPath)).toBe(true);
    const rejected = fs.readFileSync(rejectedPath, 'utf8').trim().split('\n');
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0]!).reason).toBe('token-verify-failed');

    expect(writer.recentTail()).toHaveLength(0);
  });

  it('rejects entries that regress the per-surface high-watermark (A42)', async () => {
    const writer = new AuditWriter(tmpDir, {
      machineId: 'm-test',
      tokenVerifier: () => true,
    });
    const first = await writer.append(
      makeEntry({ attemptId: 'a', subsystem: 'memory', timestamp: 1_000_000 })
    );
    expect(first.accepted).toBe(true);
    const regress = await writer.append(
      makeEntry({ attemptId: 'a', subsystem: 'memory', timestamp: 999_999 })
    );
    expect(regress.accepted).toBe(false);
    expect(regress.rejectedReason).toBe('watermark-regression');
    const advance = await writer.append(
      makeEntry({ attemptId: 'a', subsystem: 'memory', timestamp: 1_000_001 })
    );
    expect(advance.accepted).toBe(true);
  });

  it('caps the in-memory tail at the configured size (default 1000)', async () => {
    const writer = new AuditWriter(tmpDir, {
      machineId: 'm-test',
      tokenVerifier: () => true,
      tailSize: 50, // smaller for test perf
    });
    for (let i = 0; i < 120; i++) {
      await writer.append(
        makeEntry({ attemptId: `a-${i}`, timestamp: 1_000_000 + i })
      );
    }
    const tail = writer.recentTail();
    expect(tail).toHaveLength(50);
    expect(tail[0]?.attemptId).toBe('a-70');
    expect(tail[49]?.attemptId).toBe('a-119');
  });
});
