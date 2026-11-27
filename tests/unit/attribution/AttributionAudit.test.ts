import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttributionAudit, AUDIT_BUDGET, splitBlocks, type AuditDeps } from '../../../src/core/attribution/AttributionAudit.js';
import { AttributionLedger } from '../../../src/core/attribution/AttributionLedger.js';
import type { CheckResult } from '../../../src/core/attribution/AttributionService.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const passed: CheckResult = { verdict: 'pass', findings: [], malformed: [] };
const noModel: CheckResult = { verdict: 'unchecked', findings: [], malformed: [] };

describe('splitBlocks', () => {
  it('a changed heading changes the hash of the lines under it', () => {
    const [a] = splitBlocks('f', '# One\n- line\n');
    const [b] = splitBlocks('f', '# Two\n- line\n');
    expect(a.hash).not.toBe(b.hash);
    expect(b.text).toBe('# Two\n- line');
  });

  it('a changed neighbour changes the hash too', () => {
    const one = splitBlocks('f', 'first\n\nmiddle\n\nlast');
    const two = splitBlocks('f', 'first changed\n\nmiddle\n\nlast');
    expect(one[1].hash).not.toBe(two[1].hash);
  });
});

describe('AttributionAudit', () => {
  let dir: string;
  let note: string;
  let ledger: AttributionLedger;
  let clock: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-audit-'));
    note = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(note, '# Notes\nJustin said to do it.\n');
    ledger = new AttributionLedger({ stateDir: dir, machineId: 'm1' });
    clock = Date.parse('2026-11-05T00:00:00Z');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/AttributionAudit.test.ts:cleanup' }); });

  const make = (check: AuditDeps['check'], extra: Partial<AuditDeps> = {}) => new AttributionAudit({
    stateDir: dir, machine: 'm1', listFiles: () => [note], check, ledger, knownPeople: () => ['Justin'],
    holdsLease: () => true, isEnabled: () => true, report: vi.fn(), now: () => clock, ...extra,
  });

  it('writes nothing to any note', async () => {
    const before = fs.readFileSync(note, 'utf8');
    const stat = fs.statSync(note).mtimeMs;
    await make(async () => ({ verdict: 'refuse', malformed: [], findings: [{ span: 'Justin said', person: 'Justin', verdict: 'refuse', reason: 'unsourced', relation: 'unsourced' }] })).run();
    expect(fs.readFileSync(note, 'utf8')).toBe(before);
    expect(fs.statSync(note).mtimeMs).toBe(stat);
  });

  it('reports unsourced claims and keeps cannot-check apart from false', async () => {
    const report = await make(async () => ({
      verdict: 'pass', malformed: [],
      findings: [
        { span: 'a', person: 'J', verdict: 'refuse', reason: 'unsourced', relation: 'unsourced' },
        { span: 'b', person: 'J', verdict: 'refuse', reason: 'overstated', relation: 'unsourced' },
        { span: 'c', person: 'J', verdict: 'pass', outcome: 'not-found', relation: 'unconfirmed' },
        { span: 'd', person: 'J', verdict: 'pass', outcome: 'unreachable', relation: 'unconfirmed' },
      ],
    })).run();
    expect(report!.unsourced.map((i) => i.claim)).toEqual(['a']);
    expect(report!.falseCitations.map((i) => i.claim)).toEqual(['b']);
    expect(report!.notFoundOnLiveMachines.map((i) => i.claim)).toEqual(['c']);
    expect(report!.cannotCheckNow.map((i) => i.claim)).toEqual(['d']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'attribution', 'report.json'), 'utf8')).unsourced).toHaveLength(1);
  });

  it('stores a block hash only after a successful judgment, so a failure is re-checked', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => noModel);
    const audit = make(check);
    await audit.run();
    await audit.run();
    expect(check).toHaveBeenCalledTimes(2);
    check.mockResolvedValue(passed);
    await audit.run();
    await audit.run();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('re-checks the lines under a changed heading', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => passed);
    const audit = make(check);
    await audit.run();
    fs.writeFileSync(note, "# Justin's standing rules\nJustin said to do it.\n");
    await audit.run();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('splits its calls so nothing starves: new blocks stop at 20, the sample at 10', async () => {
    const text = [
      ...Array.from({ length: 30 }, (_, i) => `Justin said ${i}.`),
      ...Array.from({ length: 30 }, (_, i) => `Build took ${i} seconds.`),
    ].join('\n\n');
    fs.writeFileSync(note, text);
    let used = { newBlocks: 0, sampled: 0, retries: 0 };
    const check = vi.fn(async (_text: string, _context: unknown, slice: keyof typeof AUDIT_BUDGET): Promise<CheckResult> => { used[slice] += 1; return passed; });
    await make(check as never, { callsUsed: (slice) => used[slice], beforeRun: async () => { used = { newBlocks: 0, sampled: 0, retries: 0 }; } }).run();
    expect(used.newBlocks).toBe(AUDIT_BUDGET.newBlocks);
    expect(used.sampled).toBe(AUDIT_BUDGET.sampled);
    expect(AUDIT_BUDGET.newBlocks + AUDIT_BUDGET.sampled + AUDIT_BUDGET.retries).toBe(40);
  });

  it('the sample measures the filter\'s misses', async () => {
    fs.writeFileSync(note, 'Build took 40 seconds.\n');
    const sample = vi.fn();
    await make(async () => ({ verdict: 'pass', malformed: [], findings: [{ span: 'x', person: 'J', verdict: 'pass', relation: 'unsourced' }] }), { counters: { sample } }).run();
    expect(sample).toHaveBeenCalledWith(true);
  });

  it('backs off on failure, then a breaker stops it and reports, and it re-opens after 24h', async () => {
    const report = vi.fn();
    const check = vi.fn(async (): Promise<CheckResult> => noModel);
    const audit = make(check, { report });
    await audit.tick();
    expect(audit.snapshot().consecutiveFailures).toBe(1);
    expect(await audit.tick()).toBeNull();
    clock += 60 * 60_000;
    await audit.tick();
    expect(audit.snapshot().consecutiveFailures).toBe(2);
    clock += 2 * 60 * 60_000;
    await audit.tick();
    expect(report).toHaveBeenCalledTimes(1);
    clock += 23 * 60 * 60_000;
    expect(await audit.tick()).toBeNull();
    clock += 2 * 60 * 60_000;
    check.mockResolvedValue(passed);
    await audit.tick();
    expect(audit.snapshot().consecutiveFailures).toBe(0);
  });

  it('a successful run waits a day', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => passed);
    const audit = make(check);
    await audit.tick();
    expect(await audit.tick()).toBeNull();
    clock += 24 * 60 * 60_000 + 1;
    expect(await audit.tick()).not.toBeNull();
  });

  it('only the lease holder runs it, and off means off', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => passed);
    expect(await make(check, { holdsLease: () => false }).tick()).toBeNull();
    expect(await make(check, { isEnabled: () => false }).tick()).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('retries an unreachable claim whatever its hash, its interval doubling', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => ({ verdict: 'pass', malformed: [], findings: [{ span: 'x', person: 'J', verdict: 'pass', outcome: 'unreachable', relation: 'unconfirmed', failed: ['laptop'] }] }));
    const audit = make(check);
    await audit.run();
    expect(check).toHaveBeenCalledTimes(1);
    expect(audit.snapshot().retries).toBe(1);
    await audit.run();
    expect(check).toHaveBeenCalledTimes(1);
    clock += 25 * 60 * 60_000;
    await audit.run();
    expect(check).toHaveBeenCalledTimes(2);
    clock += 25 * 60 * 60_000;
    await audit.run();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('retries at once when the machine that was down returns', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => ({ verdict: 'pass', malformed: [], findings: [{ span: 'x', person: 'J', verdict: 'pass', outcome: 'unreachable', relation: 'unconfirmed', failed: ['laptop'] }] }));
    const answering = vi.fn(async () => [] as string[]);
    const audit = make(check, { machinesAnswering: answering });
    await audit.run();
    await audit.run();
    expect(check).toHaveBeenCalledTimes(1);
    answering.mockResolvedValue(['laptop']);
    await audit.run();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('re-judges unchecked rows from any surface, oldest first, each once', async () => {
    ledger.record({ surface: 'send', person: 'unnamed', claim: 'msg', kind: 'unchecked-text', verdict: 'unchecked', relation: 'unconfirmed', context: { text: 'Justin told me so' }, ts: '2026-11-01T00:00:00Z' });
    fs.writeFileSync(note, '');
    const check = vi.fn(async (): Promise<CheckResult> => passed);
    const audit = make(check);
    await audit.run();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]).toContain('Justin told me so');
    await audit.run();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('read-back marks a passed row whose text never reached the file', async () => {
    ledger.record({ surface: 'note-write', path: note, person: 'Justin', claim: 'never landed', kind: 'rule', verdict: 'pass', relation: 'unsourced', ts: '2026-11-01T00:00:00Z' });
    ledger.record({ surface: 'note-write', path: note, person: 'Justin', claim: 'Justin said to do it.', kind: 'rule', verdict: 'pass', relation: 'unsourced', ts: '2026-11-01T00:00:00Z' });
    const report = await make(async () => passed).run();
    expect(report!.notWritten.map((i) => i.claim)).toEqual(['never landed']);
    expect(ledger.rows().some((row) => row.claim === 'Justin said to do it.' && row.verdict === 'not-written')).toBe(false);
    const id = ledger.claimIdFor('Justin', 'never landed')!;
    expect(ledger.firstSeen(id)).toBeNull();
  });

  it('lists what the memory routes and peer messages found, once', async () => {
    ledger.record({ surface: 'memory-route', path: '/semantic/remember', person: 'Justin', claim: 'Justin told me', kind: 'rule', verdict: 'unsourced', relation: 'unsourced', ts: '2026-11-01T00:00:00Z' });
    ledger.record({ surface: 'threadline', person: 'Justin', claim: 'Justin authorized this', kind: 'rule', verdict: 'overstated', relation: 'unsourced', ts: '2026-11-01T00:00:01Z' });
    ledger.record({ surface: 'memory-route', person: 'Justin', claim: 'fine', kind: 'rule', verdict: 'pass', relation: 'origin', ts: '2026-11-01T00:00:02Z' });
    const report = await make(async () => passed).run();
    expect(report!.unsourced.map((i) => i.claim)).toEqual(['Justin told me']);
    expect(report!.falseCitations.map((i) => i.claim)).toEqual(['Justin authorized this']);
  });

  it('scrubs what it writes to its own files', async () => {
    const audit = make(async () => ({ verdict: 'pass', malformed: [], findings: [{ span: 'said sk-secret', person: 'J', verdict: 'refuse', reason: 'unsourced', relation: 'unsourced', outcome: 'unreachable', failed: ['m'] }] }), { scrub: (t) => t.replace('sk-secret', '[x]') });
    fs.writeFileSync(note, 'Justin said sk-secret\n');
    const report = await audit.run();
    expect(report!.unsourced[0].claim).toBe('said [x]');
    const files = ['report.json', 'audit-state.json'].map((f) => fs.readFileSync(path.join(dir, 'attribution', f), 'utf8'));
    for (const text of files) expect(text).not.toContain('sk-secret');
  });

  it('reports the backlog size and age', async () => {
    ledger.record({ surface: 'send', person: 'unnamed', claim: 'old', kind: 'unchecked-text', verdict: 'unchecked', relation: 'unconfirmed', context: { text: 'x' }, ts: '2026-11-04T00:00:00Z' });
    const report = await make(async () => noModel).run();
    expect(report!.backlog.size).toBeGreaterThan(0);
    expect(report!.backlog.oldestAgeHours).toBe(24);
  });
});
