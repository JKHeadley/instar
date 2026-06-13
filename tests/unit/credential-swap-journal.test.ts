/**
 * Step 5a — CredentialSwapJournal: the durable in-flight swap record that makes a crash mid-swap
 * decidable. Hermetic (temp dir + fixed clock). The load-bearing property: a non-terminal phase
 * keeps the swap (and therefore its staging escrow) in the in-flight set; only `done`/`aborted`
 * removes it and archives it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialSwapJournal, isTerminalPhase } from '../../src/core/CredentialSwapJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const BEGIN = {
  swapId: 'swap-0001',
  slotA: '/h/.claude',
  slotB: '/h/.claude-b',
  accountA: 'acct-a',
  accountB: 'acct-b',
  stagingRef: 'instar-credential-swap-staging-swap-0001',
};

describe('CredentialSwapJournal', () => {
  let dir: string;
  let logsDir: string;
  let clock: number;
  const now = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapjrnl-'));
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapjrnl-logs-'));
    clock = 0;
  });
  afterEach(() => {
    for (const d of [dir, logsDir]) {
      try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'credential-swap-journal.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
    }
  });

  it('begin records a swap in the in-flight set with phase begin', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    const e = j.begin(BEGIN);
    expect(e.phase).toBe('begin');
    expect(e.stagingRef).toBe(BEGIN.stagingRef);
    const live = j.inFlight();
    expect(live).toHaveLength(1);
    expect(live[0].swapId).toBe('swap-0001');
  });

  it('begin, exchanged, and committed ALL keep the swap in-flight (staging stays protected)', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    j.begin(BEGIN);
    j.advance('swap-0001', 'exchanged');
    expect(j.inFlight()).toHaveLength(1);
    j.advance('swap-0001', 'committed');
    expect(j.inFlight()).toHaveLength(1); // committed is NOT terminal — staging is the heal source
    expect(j.get('swap-0001')?.phase).toBe('committed');
  });

  it('done removes the swap from in-flight and archives it to history', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, logsDir, now });
    j.begin(BEGIN);
    j.advance('swap-0001', 'committed');
    j.advance('swap-0001', 'done', 're-verify passed');
    expect(j.inFlight()).toHaveLength(0);
    expect(j.get('swap-0001')).toBeNull();
    const history = fs.readFileSync(path.join(logsDir, 'credential-swaps.jsonl'), 'utf-8').trim();
    const row = JSON.parse(history);
    expect(row.swapId).toBe('swap-0001');
    expect(row.phase).toBe('done');
    expect(row.detail).toBe('re-verify passed');
  });

  it('aborted removes the swap from in-flight (nothing destructive happened)', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    j.begin(BEGIN);
    j.advance('swap-0001', 'aborted', 'precondition failed');
    expect(j.inFlight()).toHaveLength(0);
  });

  it('a re-begin of the same swapId replaces the prior row (idempotent restart)', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    j.begin(BEGIN);
    j.begin({ ...BEGIN, stagingRef: 'instar-credential-swap-staging-RETRY' });
    const live = j.inFlight();
    expect(live).toHaveLength(1);
    expect(live[0].stagingRef).toBe('instar-credential-swap-staging-RETRY');
  });

  it('in-flight entries survive a reload from disk (crash-recovery read)', () => {
    const j1 = new CredentialSwapJournal({ stateDir: dir, now });
    j1.begin(BEGIN);
    j1.advance('swap-0001', 'committed');
    // A fresh instance (simulating a process restart) reads the in-flight swap back.
    const j2 = new CredentialSwapJournal({ stateDir: dir, now });
    const live = j2.inFlight();
    expect(live).toHaveLength(1);
    expect(live[0].phase).toBe('committed');
    expect(live[0].stagingRef).toBe(BEGIN.stagingRef);
  });

  it('advance on an unknown swapId returns null and changes nothing', () => {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    expect(j.advance('nope', 'done')).toBeNull();
    expect(j.inFlight()).toHaveLength(0);
  });

  it('isTerminalPhase: done/aborted terminal; begin/exchanged/committed not', () => {
    expect(isTerminalPhase('done')).toBe(true);
    expect(isTerminalPhase('aborted')).toBe(true);
    expect(isTerminalPhase('begin')).toBe(false);
    expect(isTerminalPhase('exchanged')).toBe(false);
    expect(isTerminalPhase('committed')).toBe(false);
  });
});
