// safe-git-allow: test file — direct fs usage is fixture setup only.
/**
 * appendAuditEntry rotation (token-audit-completeness spec).
 *
 * Per-call SafeFs deletions make destructive-ops.jsonl a hot-path log; it
 * rotates at 16 MB keeping one predecessor, and the first entry of each fresh
 * segment is a rotation-marker entry so "the audit log shrank" stays
 * auditable. Below-cap writes never rotate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendAuditEntry } from '../../src/core/SafeGitExecutor.js';

const CAP = 16 * 1024 * 1024;

let auditDir: string;
let prevDir: string | undefined;
let prevDisabled: string | undefined;

function logPath(): string {
  return path.join(auditDir, 'destructive-ops.jsonl');
}

function sampleEntry(op = 'rm') {
  return {
    timestamp: new Date().toISOString(),
    executor: 'fs' as const,
    operation: op,
    target: '/tmp/x',
    outcome: 'allowed' as const,
  };
}

beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rot-'));
  prevDir = process.env.INSTAR_AUDIT_LOG_DIR;
  prevDisabled = process.env.INSTAR_AUDIT_LOG_DISABLED;
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
  delete process.env.INSTAR_AUDIT_LOG_DISABLED;
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.INSTAR_AUDIT_LOG_DIR;
  else process.env.INSTAR_AUDIT_LOG_DIR = prevDir;
  if (prevDisabled === undefined) delete process.env.INSTAR_AUDIT_LOG_DISABLED;
  else process.env.INSTAR_AUDIT_LOG_DISABLED = prevDisabled;
  try {
    fs.rmSync(auditDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('appendAuditEntry rotation', () => {
  it('below the cap: appends without rotating, no marker', () => {
    appendAuditEntry(sampleEntry('first') as never);
    appendAuditEntry(sampleEntry('second') as never);
    const lines = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(fs.existsSync(logPath() + '.1')).toBe(false);
    for (const line of lines) {
      expect(JSON.parse(line).kind).toBeUndefined();
    }
  });

  it('at the cap: rotates to .1 and writes a rotation-marker as the first entry of the fresh segment', () => {
    // Seed a log at the cap with a known entry count.
    const row = JSON.stringify(sampleEntry('seed')) + '\n';
    const repeats = Math.ceil(CAP / row.length);
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(logPath(), row.repeat(repeats));
    const seededSize = fs.statSync(logPath()).size;
    expect(seededSize).toBeGreaterThanOrEqual(CAP);

    appendAuditEntry(sampleEntry('post-rotation') as never);

    // Predecessor holds the aged-out content.
    const pred = logPath() + '.1';
    expect(fs.existsSync(pred)).toBe(true);
    expect(fs.statSync(pred).size).toBe(seededSize);

    // Fresh segment: marker first, then the triggering entry.
    const lines = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const marker = JSON.parse(lines[0]);
    expect(marker.kind).toBe('rotation-marker');
    expect(marker.agedOutEntries).toBe(repeats);
    expect(marker.predecessor).toBe('destructive-ops.jsonl.1');
    expect(typeof marker.timestamp).toBe('string');
    const entry = JSON.parse(lines[1]);
    expect(entry.operation).toBe('post-rotation');
  });

  it('does not rotate again on the next append (fresh segment is below cap)', () => {
    const row = JSON.stringify(sampleEntry('seed')) + '\n';
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(logPath(), row.repeat(Math.ceil(CAP / row.length)));
    appendAuditEntry(sampleEntry('first-after') as never);
    const predContentAfterFirst = fs.readFileSync(logPath() + '.1', 'utf-8');

    appendAuditEntry(sampleEntry('second-after') as never);

    // Predecessor unchanged — no double rotation clobbering the fresh history.
    expect(fs.readFileSync(logPath() + '.1', 'utf-8')).toBe(predContentAfterFirst);
    const lines = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3); // marker + 2 entries
    expect(JSON.parse(lines[2]).operation).toBe('second-after');
  });

  it('a second rotation replaces the predecessor (keeps exactly one)', () => {
    const row = JSON.stringify(sampleEntry('gen1')) + '\n';
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(logPath(), row.repeat(Math.ceil(CAP / row.length)));
    appendAuditEntry(sampleEntry('after-gen1') as never);

    // Grow the fresh segment past the cap and trigger again.
    const row2 = JSON.stringify(sampleEntry('gen2')) + '\n';
    fs.appendFileSync(logPath(), row2.repeat(Math.ceil(CAP / row2.length)));
    appendAuditEntry(sampleEntry('after-gen2') as never);

    const pred = fs.readFileSync(logPath() + '.1', 'utf-8');
    expect(pred).toContain('gen2'); // newest predecessor, gen1 segment aged out
    const lines = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).kind).toBe('rotation-marker');
    expect(JSON.parse(lines[1]).operation).toBe('after-gen2');
  });
});
