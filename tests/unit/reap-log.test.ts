// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReapLog } from '../../src/monitoring/ReapLog.js';

describe('ReapLog (§P4)', () => {
  let stateDir: string;
  let logPath: string;

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reaplog-'));
    stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    logPath = path.join(root, 'logs', 'reap-log.jsonl');
  });
  afterEach(() => {
    try { fs.rmSync(path.dirname(stateDir), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns [] when no log exists yet (not an error)', () => {
    const log = new ReapLog(stateDir);
    expect(log.read()).toEqual([]);
  });

  it('records a reaped entry with all fields + machine id', () => {
    const log = new ReapLog(stateDir, () => 'machine-abc');
    log.recordReaped({ session: 's1', tmuxSession: 't1', reason: 'idle-zombie', disposition: 'terminal', origin: 'autonomous' });
    const entries = log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'reaped', session: 's1', tmuxSession: 't1', reason: 'idle-zombie',
      disposition: 'terminal', origin: 'autonomous', machine: 'machine-abc',
    });
    expect(typeof entries[0].ts).toBe('string');
  });

  it('records a skipped entry with the refusal reason', () => {
    const log = new ReapLog(stateDir);
    log.recordSkipped({ session: 's2', tmuxSession: 't2', reason: 'boot-purge-dead', skipped: 'not-lease-holder', origin: 'autonomous' });
    const entries = log.read();
    expect(entries[0]).toMatchObject({
      type: 'skipped',
      skipped: 'not-lease-holder',
      reason: 'boot-purge-dead',
      disposition: 'skipped:not-lease-holder',
    });
  });

  it('normalizes legacy skipped entries so every read entry has a disposition', () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({
      ts: '2026-05-29T00:00:00.000Z',
      type: 'skipped',
      session: 'legacy',
      tmuxSession: 'legacy-tmux',
      reason: 'session-recovery',
      skipped: 'pending-injection',
    }) + '\n');

    const entries = new ReapLog(stateDir).read();
    expect(entries[0]).toMatchObject({
      type: 'skipped',
      skipped: 'pending-injection',
      disposition: 'skipped:pending-injection',
    });
  });

  it('encodes a newline-laden reason as valid JSON (no injection)', () => {
    const log = new ReapLog(stateDir);
    log.recordReaped({ session: 'evil\nINJECTED LINE', tmuxSession: 't', reason: 'a\nb\nc', disposition: 'terminal' });
    // Exactly one physical record line despite embedded newlines.
    const raw = fs.readFileSync(logPath, 'utf-8').trimEnd();
    expect(raw.split('\n')).toHaveLength(1);
    const entries = log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].session).toBe('evil\nINJECTED LINE');
    expect(entries[0].reason).toBe('a\nb\nc');
  });

  it('reads only the most-recent N entries (tail)', () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 10; i++) log.recordReaped({ session: `s${i}`, tmuxSession: `t${i}`, reason: 'idle-zombie' });
    const tail = log.read(3);
    expect(tail).toHaveLength(3);
    expect(tail.map(e => e.session)).toEqual(['s7', 's8', 's9']);
  });

  it('tolerates a corrupt line without failing the whole read', () => {
    const log = new ReapLog(stateDir);
    log.recordReaped({ session: 'good1', tmuxSession: 't', reason: 'r' });
    fs.appendFileSync(logPath, '{ not valid json\n');
    log.recordReaped({ session: 'good2', tmuxSession: 't', reason: 'r' });
    const entries = log.read();
    expect(entries.map(e => e.session)).toEqual(['good1', 'good2']);
  });
});
