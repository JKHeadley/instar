// CompactionSentinel — the idle-gated, durable server fallback
// (context-budget-layered-summaries §9.1). When the seed wait ends with no
// seeded marker, the recovery text is staged durably and released only when
// the session is NOT actively working AND its pane shows a ready prompt,
// re-checked every tick within the bound; once per compaction epoch, never a
// re-inject; a late hook seed withdraws it; a restart resumes it under the same
// gate. Both sides of every boundary are exercised.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CompactionSentinel,
  type CompactionFallbackDeps,
  type StagedCompactionFallback,
} from '../../src/monitoring/CompactionSentinel.js';
import { PendingInjectStore, compactionFallbackKey, sweepPendingInjects } from '../../src/core/PendingInjectStore.js';
import { createCompactionFallbackDeps } from '../../src/monitoring/compactionFallbackStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = '11111111-2222-3333-4444-666666666666';
const OP = 'tests/unit/CompactionSentinel-idle-gated-fallback.test.ts';

describe('CompactionSentinel idle-gated fallback', () => {
  let root: string;
  let stateDir: string;
  let store: PendingInjectStore;
  let recoverFn: ReturnType<typeof vi.fn>;
  let injected: Array<{ name: string; text: string }>;
  let marker: { seededAt: number; epoch: string } | null;
  let working: boolean;
  let ready: boolean;
  let recoverable: boolean;
  let buildResult: { text: string } | 'declined' | 'unsupported';
  let injectAccepts: boolean;
  let enabled: boolean;
  let builds: number;
  let buildThrows: boolean;
  let events: string[];
  let fallback: CompactionFallbackDeps;

  const make = () => {
    fallback = createCompactionFallbackDeps({
      store,
      build: async () => { builds += 1; if (buildThrows) throw new Error('topic memory not ready'); return buildResult; },
      isReadyPrompt: () => ready,
      inject: (name, text) => { injected.push({ name, text }); return injectAccepts; },
    });
    const s = new CompactionSentinel(
      {
        recoverFn: recoverFn as never,
        projectDir: '/fake/project',
        jsonlRoot: root,
        getClaudeSessionId: () => UUID,
        getSessionFramework: () => 'claude-code',
        isCompactionRecoveryEnabled: () => enabled,
        readSeedMarker: () => marker,
        isActivelyWorking: () => working,
        isSessionRecoverable: () => recoverable,
        fallback,
      },
      { seedWaitMs: 30_000, seedMaxWaitMs: 180_000, seedPollMs: 2_000, verifyWindowMs: 25_000, fallbackIdleBoundMs: 60_000 },
    );
    for (const e of ['compaction:seeded', 'compaction:inject-attempted', 'compaction:fallback-staged', 'compaction:failed', 'compaction:recovered']) {
      s.on(e as never, () => events.push(e));
    }
    return s;
  };

  const transcript = () => path.join(root, `${UUID}.jsonl`);
  const writeTranscript = (lines: object[]) => fs.writeFileSync(transcript(), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const appendTranscript = (line: object) => fs.appendFileSync(transcript(), JSON.stringify(line) + '\n');
  const staged = (): StagedCompactionFallback[] => fallback.list();

  let sentinel: CompactionSentinel;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T07:00:00Z'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fallback-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fallback-state-'));
    store = new PendingInjectStore(stateDir);
    writeTranscript([{ type: 'user', timestamp: '2026-11-10T06:59:00Z' }]);
    recoverFn = vi.fn().mockResolvedValue(true);
    injected = [];
    marker = null;
    working = false;
    ready = true;
    recoverable = true;
    buildResult = { text: '[telegram:1] briefing' };
    injectAccepts = true;
    enabled = true;
    builds = 0;
    buildThrows = false;
    events = [];
    sentinel = make();
  });

  afterEach(() => {
    sentinel.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
    vi.useRealTimers();
  });

  /** Report, then let the 180 s no-boundary seed wait expire. */
  const reportAndMissSeed = async (name = 's1') => {
    sentinel.report(name, 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(182_000);
  };

  it('delivers once at an idle, ready prompt and never calls the bare recoverFn', async () => {
    await reportAndMissSeed();
    expect(injected).toEqual([{ name: 's1', text: '[telegram:1] briefing' }]);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(events).toContain('compaction:fallback-staged');
    expect(staged()).toHaveLength(0); // cleared after delivery
  });

  it('holds while the session is working, then delivers when it goes idle', async () => {
    working = true;
    await reportAndMissSeed();
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(1); // durably staged while waiting
    expect(sentinel.getState('s1')?.status).toBe('awaiting-idle');
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // zombie veto held
    working = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(1);
  });

  it('holds while the pane is not at a ready prompt even if not working', async () => {
    ready = false;
    await reportAndMissSeed();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(injected).toHaveLength(0);
    ready = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(1);
  });

  it('stands down (recovered) when the session works through the whole bound, withdrawing the record', async () => {
    working = true;
    await reportAndMissSeed();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
    expect(sentinel.getState('s1')?.status).toBe('recovered');
  });

  it('fails honestly when no ready prompt appears within the bound and the session is not working', async () => {
    ready = false;
    await reportAndMissSeed();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
    expect(sentinel.getState('s1')?.status).toBe('failed');
  });

  it('a late hook seed withdraws the staged fallback without injecting', async () => {
    working = true;
    await reportAndMissSeed();
    expect(staged()).toHaveLength(1);
    marker = { seededAt: Date.now(), epoch: '' };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
    expect(events).toContain('compaction:seeded');
  });

  it('never re-injects: no output after the one delivery fails instead of retrying', async () => {
    await reportAndMissSeed();
    expect(injected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26_000); // verify window, transcript did not grow
    expect(injected).toHaveLength(1);
    expect(sentinel.getState('s1')?.status).toBe('failed');
  });

  it('verifies as recovered when the transcript grows after the delivery', async () => {
    await reportAndMissSeed();
    appendTranscript({ type: 'assistant', timestamp: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(26_000);
    expect(sentinel.getState('s1')?.status).toBe('recovered');
  });

  it('is once per compaction epoch: a second report for the same boundary does not deliver again', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    appendTranscript({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-A' });
    await vi.advanceTimersByTimeAsync(34_000);
    expect(injected).toHaveLength(1);
    appendTranscript({ type: 'assistant', timestamp: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(40_000); // verify + finalize cleanup
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(injected).toHaveLength(1);
  });

  it('falls back to the legacy recoverFn path for a channel without a builder (unsupported)', async () => {
    buildResult = 'unsupported';
    await reportAndMissSeed();
    expect(recoverFn).toHaveBeenCalledTimes(1);
    expect(injected).toHaveLength(0);
  });

  it('declines (nothing staged) when there is no unanswered user message', async () => {
    buildResult = 'declined';
    await reportAndMissSeed();
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
    expect(sentinel.getState('s1')?.status).toBe('failed');
  });

  it('withdraws the fallback when the session ends while waiting', async () => {
    working = true;
    await reportAndMissSeed();
    recoverable = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
  });

  it('clear() (session complete) removes the staged record; stop() (shutdown) keeps it', async () => {
    working = true;
    sentinel.report('s1', 'watchdog-poll');
    sentinel.report('s2', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(182_000); // both miss their seed together
    expect(staged().map(r => r.tmuxSession).sort()).toEqual(['s1', 's2']);
    sentinel.clear('s1');
    expect(staged().map(r => r.tmuxSession)).toEqual(['s2']);
    sentinel.stop();
    expect(staged().map(r => r.tmuxSession)).toEqual(['s2']);
  });

  it('re-checks at release: a session that answered the user while waiting gets nothing', async () => {
    working = true;
    await reportAndMissSeed();
    expect(builds).toBe(1);
    buildResult = 'declined'; // the session replied meanwhile: no unanswered message now
    working = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(builds).toBe(2);
    expect(injected).toHaveLength(0);
    expect(staged()).toHaveLength(0);
  });

  it('a rebuild that throws at release keeps waiting and retries, never reads as recovered', async () => {
    working = true;
    await reportAndMissSeed();
    buildThrows = true;
    working = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(0);
    expect(sentinel.getState('s1')?.status).toBe('awaiting-idle');
    expect(staged()).toHaveLength(1);
    buildThrows = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(1);
  });

  it('delivers the text rebuilt at release, not the stage-time copy', async () => {
    working = true;
    await reportAndMissSeed();
    buildResult = { text: '[telegram:1] briefing with the newer history' };
    working = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toEqual([{ name: 's1', text: '[telegram:1] briefing with the newer history' }]);
  });

  it('an inject the session does not accept fails without retrying', async () => {
    injectAccepts = false;
    await reportAndMissSeed();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(injected).toHaveLength(1);
    expect(sentinel.getState('s1')?.status).toBe('failed');
    expect(staged()).toHaveLength(0);
  });

  it('waits while another inject (an initial message) is pending for the session', async () => {
    store.record({ tmuxSession: 's1', initialMessage: 'first user message' });
    await reportAndMissSeed();
    expect(injected).toHaveLength(0);
    store.clear('s1'); // the initial message went in
    await vi.advanceTimersByTimeAsync(2_000);
    expect(injected).toHaveLength(1);
  });

  it("a marker from an earlier compaction does not withdraw this one's fallback (boundary rule)", async () => {
    working = true;
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    const boundaryAt = Date.now();
    appendTranscript({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(boundaryAt).toISOString(), uuid: 'epoch-B' });
    await vi.advanceTimersByTimeAsync(34_000); // seed wait over → staged
    expect(staged()).toHaveLength(1);
    marker = { seededAt: boundaryAt - 30_000, epoch: '' }; // older than this boundary, inside the 120 s lookback
    await vi.advanceTimersByTimeAsync(2_000);
    expect(staged()).toHaveLength(1);
    expect(events).not.toContain('compaction:seeded');
  });

  it('verifies against the transcript at delivery, so compaction writes do not count as a response', async () => {
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(1_000);
    appendTranscript({ type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(), uuid: 'epoch-C' });
    await vi.advanceTimersByTimeAsync(34_000);
    expect(injected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(26_000); // no growth after the delivery
    expect(sentinel.getState('s1')?.status).toBe('failed');
  });

  describe('restart', () => {
    it('a staged fallback resumes under the same idle gate after a restart', async () => {
      working = true;
      await reportAndMissSeed();
      sentinel.stop(); // the old process dies; the record survives on disk
      const fresh = make();
      sentinel = fresh;
      const r = fresh.resumeStagedFallbacks();
      expect(r.resumed).toEqual(['s1']);
      expect(injected).toHaveLength(0); // still working: gated
      working = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(injected).toEqual([{ name: 's1', text: '[telegram:1] briefing' }]);
    });

    it('withdraws on resume when the session is gone, the switch is off, or a newer recovery owns it', async () => {
      working = true;
      sentinel.report('a', 'watchdog-poll');
      sentinel.report('b', 'watchdog-poll');
      sentinel.report('c', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(182_000);
      expect(staged()).toHaveLength(3);
      sentinel.stop();
      recoverable = false;
      sentinel = make();
      expect(sentinel.resumeStagedFallbacks().withdrawn.map(w => w.reason)).toEqual(Array(3).fill('session no longer running'));
      expect(staged()).toHaveLength(0);

      recoverable = true;
      fallback.stage({ tmuxSession: 'd', epoch: 'e', trigger: 'watchdog-poll', text: 't', stagedAt: Date.now() });
      enabled = false;
      sentinel.stop();
      sentinel = make();
      expect(sentinel.resumeStagedFallbacks().withdrawn).toEqual([{ tmuxSession: 'd', reason: 'compaction recovery is switched off' }]);
      expect(staged()).toHaveLength(0);

      enabled = true;
      fallback.stage({ tmuxSession: 'e', epoch: 'e', trigger: 'watchdog-poll', text: 't', stagedAt: Date.now() });
      sentinel.stop();
      sentinel = make();
      sentinel.report('e', 'watchdog-poll'); // a newer recovery is already running
      expect(sentinel.resumeStagedFallbacks().withdrawn).toEqual([{ tmuxSession: 'e', reason: 'a newer recovery already owns the session' }]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(injected).toHaveLength(0);
    });

    it('a stale or orphaned staged fallback is withdrawn and reported, never delivered', async () => {
      working = true;
      await reportAndMissSeed('old');
      sentinel.stop();
      vi.setSystemTime(Date.now() + 20 * 60_000);
      sentinel = make();
      const r = sentinel.resumeStagedFallbacks();
      expect(r.withdrawn).toEqual([{ tmuxSession: 'old', reason: 'staged too long ago' }]);
      expect(staged()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(injected).toHaveLength(0);
    });
  });

  describe('PendingInjectStore coexistence', () => {
    it("the staged record never overwrites the session's initial-message record and the generic sweep never replays it", async () => {
      store.record({ tmuxSession: 's1', initialMessage: 'the user first message' });
      working = true;
      await reportAndMissSeed('s1');
      const { records } = store.list();
      expect(records.map(r => r.tmuxSession).sort()).toEqual([compactionFallbackKey('s1'), 's1'].sort());
      const redelivered: string[] = [];
      await sweepPendingInjects(store, {
        sessionAlive: () => true,
        redeliver: async (rec) => { redelivered.push(rec.tmuxSession); },
        reportLoss: () => undefined,
      });
      expect(redelivered).toEqual(['s1']); // only the initial message
      expect(staged()).toHaveLength(1); // the fallback is left for the sentinel
    });
  });
});
