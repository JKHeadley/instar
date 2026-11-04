import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureEvidenceLog, featureEvidence, setFeatureEvidenceLog } from '../../src/monitoring/FeatureEvidenceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => {
  setFeatureEvidenceLog(null);
  for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'FeatureEvidenceLog.test' });
});
function make() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-evidence-'));
  roots.push(projectDir);
  return new FeatureEvidenceLog({ projectDir, machine: 'm1', instarVersion: '1.2.3', now: () => 1_000_000 });
}
const rows = (log: FeatureEvidenceLog) => fs.readFileSync(log.filePath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

describe('FeatureEvidenceLog', () => {
  it('stamps what the caller cannot claim', () => {
    const log = make();
    const id = log.record('x', { kind: 'fired', reason: 'why', context: { n: 1, ok: true, none: null } });
    const [r] = rows(log);
    expect(r).toMatchObject({ eventId: id, machine: 'm1', instarVersion: '1.2.3', featureId: 'x', kind: 'fired', reason: 'why', context: { n: 1, ok: true, none: null } });
    expect(r.at).toBe(new Date(1_000_000).toISOString());
  });

  it('bounds and scrubs text, and drops bad context', () => {
    const log = make();
    log.record('x', { kind: 'error', reason: `token sk-ant-api03-${'a'.repeat(90)} ${'b'.repeat(500)}`, context: { 'bad key': 'x', big: 'y'.repeat(900), obj: { a: 1 } as unknown as string } });
    const [r] = rows(log);
    expect(r.reason.length).toBeLessThanOrEqual(240);
    expect(r.reason).not.toContain('sk-ant-api03');
    expect(r.context.big.length).toBeLessThanOrEqual(240);
    expect(r.context['bad key']).toBeUndefined();
    expect(r.context.obj).toBeUndefined();
  });

  it('never throws when the write fails', () => {
    const log = make();
    fs.mkdirSync(log.filePath, { recursive: true });
    expect(log.record('x', { kind: 'fired', reason: 'r' })).toBeNull();
  });

  it('the shared call does nothing before boot, then writes', () => {
    expect(featureEvidence.record('x', { kind: 'fired', reason: 'r' })).toBeNull();
    const log = make();
    setFeatureEvidenceLog(log);
    expect(featureEvidence.record('x', { kind: 'fired', reason: 'r' })).toBeTypeOf('string');
    expect(rows(log)).toHaveLength(1);
  });
});
