// CompactionSentinel — the heal ladder's re-inject and the server-written
// seeded marker (context-budget-layered-summaries §9.1). The heal re-inject
// runs the SAME idle-gated, durable path as the fallback (released only when not
// actively working AND at a ready prompt), once per (session, epoch), one
// injector at a time, never through `report`; a delivery writes the seeded
// marker for the compaction epoch, and a server marker never stands a NEWER
// compaction's seed wait down.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel, type CompactionFallbackDeps } from '../../src/monitoring/CompactionSentinel.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { createCompactionFallbackDeps } from '../../src/monitoring/compactionFallbackStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = '11111111-2222-3333-4444-777777777777';
const OP = 'tests/unit/CompactionSentinel-heal-reinject.test.ts';

describe('CompactionSentinel heal re-inject + server seeded marker', () => {
  let root: string; let stateDir: string; let store: PendingInjectStore;
  let injected: Array<{ name: string; text: string }>; let marker: { seededAt: number; epoch: string; source?: string } | null;
  let working: boolean; let ready: boolean; let recoverable: boolean; let builds: number; let written: Array<{ epoch: string; source: string }>;
  let recoverFn: ReturnType<typeof vi.fn>; let fallback: CompactionFallbackDeps; let sentinel: CompactionSentinel;

  const transcript = () => path.join(root, `${UUID}.jsonl`);
  const append = (line: object) => fs.appendFileSync(transcript(), JSON.stringify(line) + '\n');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T07:00:00Z'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reinject-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-reinject-state-'));
    store = new PendingInjectStore(stateDir);
    fs.writeFileSync(transcript(), JSON.stringify({ type: 'user', timestamp: '2026-11-10T06:59:00Z' }) + '\n');
    injected = []; marker = null; working = false; ready = true; recoverable = true; builds = 0; written = [];
    recoverFn = vi.fn().mockResolvedValue(true);
    fallback = createCompactionFallbackDeps({
      store,
      build: async () => { builds += 1; return { text: '[telegram:1] briefing' }; },
      isReadyPrompt: () => ready,
      inject: (name, text) => { injected.push({ name, text }); return true; },
    });
    sentinel = new CompactionSentinel({
      recoverFn: recoverFn as never, projectDir: '/fake', jsonlRoot: root, getClaudeSessionId: () => UUID, getSessionFramework: () => 'claude-code',
      isCompactionRecoveryEnabled: () => true, readSeedMarker: () => marker, isActivelyWorking: () => working, isSessionRecoverable: () => recoverable,
      fallback,
      writeSeedMarker: (_name, epoch, source) => { const at = Date.now(); written.push({ epoch, source }); marker = { seededAt: at, epoch, source }; return at; },
    }, { seedWaitMs: 30_000, seedMaxWaitMs: 180_000, seedPollMs: 2_000, verifyWindowMs: 25_000, fallbackIdleBoundMs: 60_000 });
  });
  afterEach(() => {
    sentinel.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
    vi.useRealTimers();
  });

  const heal = (epoch = 'epoch-A') => sentinel.healReinject('s1', { epoch, boundaryAt: Date.now() - 15 * 60_000, text: '[telegram:1] PACKET' });

  it('idle pane ⇒ delivers the re-staged packet once, writes the heal marker for the epoch, never via recoverFn or the builder', async () => {
    const p = heal();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('delivered');
    expect(injected).toEqual([{ name: 's1', text: '[telegram:1] PACKET' }]);
    expect(written).toEqual([{ epoch: 'epoch-A', source: 'heal' }]);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(builds).toBe(0);
    expect(fallback.list()).toHaveLength(0);
  });

  it('busy pane ⇒ staged durably and held; delivered when idle', async () => {
    working = true;
    let done: string | null = null;
    void heal().then((o) => { done = o; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(injected).toHaveLength(0);
    expect(fallback.list()).toHaveLength(1);
    expect(fallback.list()[0].trigger).toBe('heal');
    working = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(1);
    expect(done).toBe('delivered');
  });

  it('not at a ready prompt for the whole bound ⇒ failed, nothing typed', async () => {
    ready = false;
    const p = heal();
    await vi.advanceTimersByTimeAsync(62_000);
    await expect(p).resolves.toBe('failed');
    expect(injected).toHaveLength(0);
  });

  it('one injector at a time: a second heal or a report while one is staged is refused', async () => {
    working = true;
    void heal();
    await vi.advanceTimersByTimeAsync(10);
    await expect(heal('epoch-B')).resolves.toBe('busy');
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(10);
    expect(sentinel.getState('s1')?.trigger).toBe('heal');
  });

  it('idempotent on (session, epoch): a second heal for a delivered epoch does nothing', async () => {
    await vi.advanceTimersByTimeAsync(0);
    const p = heal(); await vi.advanceTimersByTimeAsync(10); await p;
    await vi.advanceTimersByTimeAsync(40_000); // verify + cleanup
    await expect(heal()).resolves.toBe('already-delivered');
    expect(injected).toHaveLength(1);
  });

  it('a session that is no longer running is refused', async () => {
    recoverable = false;
    await expect(heal()).resolves.toBe('not-recoverable');
  });

  it('the fallback delivery writes the server marker on its compact-boundary epoch; that marker never covers a NEWER compaction', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    append({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-A' });
    await vi.advanceTimersByTimeAsync(34_000); // no hook seed within 30 s of the boundary ⇒ fallback delivered
    expect(injected).toHaveLength(1);
    expect(written).toEqual([{ epoch: 'epoch-A', source: 'server-fallback' }]);
    append({ type: 'assistant', timestamp: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(40_000);
    // A new compaction 20 s later, inside the late-report lookback of the server marker.
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(1_000);
    append({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-B' });
    await vi.advanceTimersByTimeAsync(34_000);
    expect(injected).toHaveLength(2); // the server marker for A did not stand B's recovery down
    expect(written.map((w) => w.epoch)).toEqual(['epoch-A', 'epoch-B']);
  });

  it('a hook marker inside 30 s of the boundary still stands the server down (the short-circuit is unchanged)', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    append({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-C' });
    await vi.advanceTimersByTimeAsync(10_000);
    marker = { seededAt: Date.now(), epoch: '', source: 'compact' };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(injected).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it('a hook marker only AFTER the 30 s bound ⇒ the server fallback runs', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    append({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-D' });
    working = true;
    await vi.advanceTimersByTimeAsync(33_000);
    expect(sentinel.getState('s1')?.status).toBe('awaiting-idle');
  });

  it('a heal staged before a restart resumes only where the heal ladder is wired this boot', () => {
    fallback.stage({ tmuxSession: 's1', epoch: 'epoch-R', trigger: 'heal', text: '[telegram:1] PACKET', stagedAt: Date.now(), boundaryAt: Date.now() - 60_000 });
    const make = (healOn: boolean) => new CompactionSentinel({
      recoverFn: recoverFn as never, projectDir: '/fake', jsonlRoot: root, getClaudeSessionId: () => UUID, getSessionFramework: () => 'claude-code',
      isCompactionRecoveryEnabled: () => true, readSeedMarker: () => marker, isActivelyWorking: () => true, isSessionRecoverable: () => true,
      fallback, isHealEnabled: () => healOn,
    }, { fallbackIdleBoundMs: 60_000 });
    const off = make(false);
    expect(off.resumeStagedFallbacks().withdrawn).toEqual([{ tmuxSession: 's1', reason: 'the heal ladder is off on this boot' }]);
    off.stop();
    fallback.stage({ tmuxSession: 's1', epoch: 'epoch-R', trigger: 'heal', text: '[telegram:1] PACKET', stagedAt: Date.now(), boundaryAt: Date.now() - 60_000 });
    const on = make(true);
    expect(on.resumeStagedFallbacks().resumed).toEqual(['s1']);
    on.stop();
  });
});
