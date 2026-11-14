// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §9.1 — the idle-gated fallback wired the way
 * server.ts wires it: a REAL CompactionSentinel, a REAL SessionManager's
 * isSessionActivelyWorking and classifyPaneState (only the lowest-level tmux
 * capture is stubbed), and a REAL PendingInjectStore in the SessionManager's
 * own pending-injects directory, adapted by createCompactionFallbackDeps.
 *
 *  - mid-turn pane: staged on disk, nothing typed;
 *  - pane at a ready prompt: delivered once, record gone;
 *  - SessionManager.recoverPendingInjects (the real boot sweep) re-injects the
 *    session's initial message but never the staged fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { PendingInjectStore, compactionFallbackKey } from '../../src/core/PendingInjectStore.js';
import { createCompactionFallbackDeps } from '../../src/monitoring/compactionFallbackStore.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/compaction-idle-gated-fallback-wiring.test.ts';
const WORKING = '✻ Thinking… (15s · esc to interrupt)';
const READY = '╭──────────────────────────────╮\n│ >                            │\n╰──────────────────────────────╯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

describe('CompactionSentinel idle-gated fallback × SessionManager × PendingInjectStore', () => {
  let base: string;
  let jsonlRoot: string;
  let sm: SessionManager;
  let sentinel: CompactionSentinel;
  let store: PendingInjectStore;
  let pane: string;
  let typed: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fb-int-'));
    jsonlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fb-int-jsonl-'));
    fs.writeFileSync(path.join(jsonlRoot, 'x.jsonl'), '{}\n');
    const state = {
      baseDir: base,
      listSessions: vi.fn(() => []), getSession: vi.fn(() => null), saveSession: vi.fn(), removeSession: vi.fn(),
      getJobState: vi.fn().mockReturnValue(null), saveJobState: vi.fn(), getValue: vi.fn().mockReturnValue(undefined), setValue: vi.fn(),
    } as unknown as StateManager;
    sm = new SessionManager({
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: base, maxSessions: 5, protectedSessions: [], completionPatterns: [],
    } as SessionManagerConfig, state);
    pane = WORKING;
    typed = [];
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockImplementation(() => pane);
    vi.spyOn(sm, 'hasActiveProcesses').mockReturnValue(false);
    vi.spyOn(sm, 'injectMessage').mockImplementation((_s: string, t: string) => { typed.push(t); return true; });
    // The same directory SessionManager's own ledger uses (stateBase/state).
    store = new PendingInjectStore(path.join(base, 'state'));
    sentinel = new CompactionSentinel({
      recoverFn: vi.fn().mockResolvedValue(true) as never,
      projectDir: base,
      jsonlRoot,
      getSessionFramework: () => 'claude-code',
      isCompactionRecoveryEnabled: () => true,
      readSeedMarker: () => null,
      isActivelyWorking: (s) => sm.isSessionActivelyWorking(s),
      fallback: createCompactionFallbackDeps({
        store,
        build: async () => ({ text: '[telegram:7] post-compaction briefing' }),
        isReadyPrompt: (s) => sm.classifyPaneState(s) === 'ready',
        inject: (s, text) => sm.injectMessage(s, text),
      }),
    }, { seedMaxWaitMs: 4_000, seedPollMs: 1_000, verifyWindowMs: 5_000, fallbackIdleBoundMs: 60_000 });
  });

  afterEach(() => {
    sentinel.stop();
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: OP });
    SafeFsExecutor.safeRmSync(jsonlRoot, { recursive: true, force: true, operation: OP });
  });

  it('holds the staged fallback on disk while the real pane shows a working turn, then delivers at the ready prompt', async () => {
    sentinel.report('echo-topic-7', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(typed).toEqual([]);
    expect(fs.existsSync(path.join(base, 'state', 'pending-injects', `${compactionFallbackKey('echo-topic-7')}.json`))).toBe(true);
    pane = READY;
    expect(sm.classifyPaneState('echo-topic-7')).toBe('ready'); // positive control on the real classifier
    await vi.advanceTimersByTimeAsync(1_000);
    expect(typed).toEqual(['[telegram:7] post-compaction briefing']);
    expect(fs.existsSync(path.join(base, 'state', 'pending-injects', `${compactionFallbackKey('echo-topic-7')}.json`))).toBe(false);
  });

  it("the real boot sweep replays the session's initial message but never the staged fallback", async () => {
    store.record({ tmuxSession: 'echo-topic-7', initialMessage: 'first user message' });
    sentinel.report('echo-topic-7', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(6_000);
    const replayed: string[] = [];
    vi.spyOn(sm as unknown as { handleReadyAndInject: (...a: unknown[]) => Promise<void> }, 'handleReadyAndInject')
      .mockImplementation(async (...a: unknown[]) => { replayed.push(String(a[2])); });
    const r = await sm.recoverPendingInjects();
    expect(replayed).toEqual(['first user message']);
    expect(r.redelivered).toEqual(['echo-topic-7']);
    expect(store.list().records.some(x => x.tmuxSession === compactionFallbackKey('echo-topic-7'))).toBe(true);
  });
});
