import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionLedger, type LedgerInput } from '../../../src/core/attribution/AttributionLedger.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const base: LedgerInput = { surface: 'note-write', person: 'Justin', claim: 'corrected me', kind: 'rule', verdict: 'pass', relation: 'unsourced' };

describe('AttributionLedger', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-ledger-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/AttributionLedger.test.ts:cleanup' }); });
  const make = (extra = {}) => new AttributionLedger({ stateDir: dir, machineId: 'm1', ...extra });

  it('shows the laptop-rule chain in order across rewordings', () => {
    const ledger = make();
    const a = ledger.record({ ...base, ts: '2026-07-30T00:00:00Z' }).row;
    const b = ledger.record({ ...base, claim: 'standing rule', parentClaimId: a.claimId, linkedBy: 'judge', ts: '2026-11-04T00:00:00Z' }).row;
    const c = ledger.record({ ...base, claim: 'I broke your rule', surface: 'send', parentClaimId: b.claimId, linkedBy: 'judge', ts: '2026-11-04T01:00:00Z' }).row;
    expect(ledger.chain(c.claimId).map((row) => row.claim)).toEqual(['corrected me', 'standing rule', 'I broke your rule']);
    expect(ledger.firstSeen(c.claimId)).toBe('2026-07-30T00:00:00Z');
  });

  it('never treats a refused attempt as where a claim began', () => {
    const ledger = make();
    const a = ledger.record({ ...base, verdict: 'unsourced', ts: '2026-07-01T00:00:00Z' }).row;
    expect(ledger.firstSeen(a.claimId)).toBeNull();
    ledger.record({ ...base, claimId: a.claimId, verdict: 'pass', ts: '2026-07-02T00:00:00Z' });
    expect(ledger.firstSeen(a.claimId)).toBe('2026-07-02T00:00:00Z');
  });

  it('adds no row when wording and verdict are unchanged, and adds one when either changes', () => {
    const ledger = make();
    const first = ledger.record(base);
    expect(first.written).toBe(true);
    expect(ledger.record({ ...base, claimId: first.row.claimId }).written).toBe(false);
    expect(ledger.record({ ...base, claimId: first.row.claimId, verdict: 'unsourced' }).written).toBe(true);
    expect(ledger.rows()).toHaveLength(2);
  });

  it('remembers what it wrote across a restart', () => {
    const first = make().record(base);
    expect(make().record({ ...base, claimId: first.row.claimId }).written).toBe(false);
  });

  it('scrubs stored text and writes a private file', () => {
    const ledger = make({ scrub: (text: string) => text.replace('sk-secret', '[redacted]') });
    ledger.record({ ...base, claim: 'said sk-secret', quote: 'sk-secret here' });
    const [row] = ledger.rows();
    expect(row.claim).toBe('said [redacted]');
    expect(row.quote).toBe('[redacted] here');
    expect(fs.statSync(path.join(dir, 'attribution', 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('keeps rotated history, never deleting it, and a chain can still reach it', () => {
    const ledger = make({ rotateAtRows: 2 });
    const a = ledger.record({ ...base, claim: 'one' }).row;
    ledger.record({ ...base, claim: 'two', parentClaimId: a.claimId });
    const c = ledger.record({ ...base, claim: 'three', parentClaimId: a.claimId }).row;
    expect(ledger.rows().map((row) => row.claim)).toEqual(['three']);
    expect(ledger.archivedRows().map((row) => row.claim)).toEqual(['one', 'two']);
    expect(ledger.chain(c.claimId).map((row) => row.claim)).toEqual(['three']);
    expect(ledger.chain(c.claimId, { includeArchives: true }).map((row) => row.claim).sort()).toEqual(['one', 'three']);
  });

  it('skips a torn last line instead of losing the ledger', () => {
    const ledger = make();
    ledger.record(base);
    fs.appendFileSync(path.join(dir, 'attribution', 'ledger.jsonl'), '{"torn":');
    expect(ledger.rows()).toHaveLength(1);
  });

  it('survives a parent loop', () => {
    const ledger = make();
    ledger.record({ ...base, claimId: 'a', parentClaimId: 'b' });
    ledger.record({ ...base, claimId: 'b', parentClaimId: 'a' });
    expect(ledger.chain('a')).toHaveLength(2);
  });
});
