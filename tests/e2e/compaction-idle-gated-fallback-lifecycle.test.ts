// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §9.1 — e2e lifecycle of the idle-gated,
 * durable server fallback:
 *
 *  1. REAL disk, REAL timers, across a "restart": sentinel A misses the seed,
 *     stages the fallback in a real PendingInjectStore while the session is
 *     working, and dies (stop()). Sentinel B, built the way server.ts builds
 *     it, resumes the record at boot and delivers it only once the session is
 *     idle at a ready prompt, then verifies on transcript growth.
 *  2. WIRED source check (dead-code guard): server.ts passes `fallback:
 *     createCompactionFallbackDeps(...)` with a real PendingInjectStore, the
 *     pane classifier and injectMessage, and calls resumeStagedFallbacks() at
 *     boot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { createCompactionFallbackDeps } from '../../src/monitoring/compactionFallbackStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/compaction-idle-gated-fallback-lifecycle.test.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
};

describe('idle-gated compaction fallback — lifecycle across a restart', () => {
  const dirs: string[] = [];
  const sentinels: CompactionSentinel[] = [];
  afterEach(() => {
    for (const s of sentinels) s.stop();
    for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  it('stages while working, survives the restart, delivers once at an idle prompt, verifies on output', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fb-e2e-'));
    const jsonlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-fb-e2e-jsonl-'));
    dirs.push(stateDir, jsonlRoot);
    const transcript = path.join(jsonlRoot, 'sess.jsonl');
    fs.writeFileSync(transcript, '{"type":"user"}\n');
    let working = true;
    const typed: string[] = [];
    const build = (store: PendingInjectStore) => new CompactionSentinel({
      recoverFn: async () => { throw new Error('the bare recoverFn must not run'); },
      projectDir: stateDir,
      jsonlRoot,
      getSessionFramework: () => 'claude-code',
      isCompactionRecoveryEnabled: () => true,
      readSeedMarker: () => null,
      isActivelyWorking: () => working,
      isSessionRecoverable: () => true,
      fallback: createCompactionFallbackDeps({
        store,
        build: async () => ({ text: '[telegram:9] briefing after compaction' }),
        isReadyPrompt: () => !working,
        inject: (_s, t) => { typed.push(t); fs.appendFileSync(transcript, '{"type":"assistant"}\n'); return true; },
      }),
    }, { seedMaxWaitMs: 300, seedPollMs: 50, verifyWindowMs: 300, fallbackIdleBoundMs: 10_000 });

    const a = build(new PendingInjectStore(path.join(stateDir, 'state')));
    sentinels.push(a);
    a.report('echo-topic-9', 'watchdog-poll');
    expect(await until(() => a.getState('echo-topic-9')?.status === 'awaiting-idle')).toBe(true);
    const ledgerDir = path.join(stateDir, 'state', 'pending-injects');
    expect(fs.readdirSync(ledgerDir)).toHaveLength(1);
    a.stop(); // the process dies; the staged record stays on disk
    expect(fs.readdirSync(ledgerDir)).toHaveLength(1);

    const b = build(new PendingInjectStore(path.join(stateDir, 'state')));
    sentinels.push(b);
    expect(b.resumeStagedFallbacks().resumed).toEqual(['echo-topic-9']);
    await sleep(200);
    expect(typed).toEqual([]); // still working: gated
    working = false;
    expect(await until(() => typed.length === 1)).toBe(true);
    expect(typed).toEqual(['[telegram:9] briefing after compaction']);
    expect(fs.readdirSync(ledgerDir)).toHaveLength(0);
    expect(await until(() => b.getState('echo-topic-9')?.status === 'recovered')).toBe(true);
    await sleep(400);
    expect(typed).toHaveLength(1); // once, never re-injected
  });

  it('server.ts wires the fallback deps to real collaborators and resumes staged fallbacks at boot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');
    const ctor = src.slice(src.indexOf('const compactionSentinel = new CompactionSentinel('), src.indexOf('// ── RateLimitSentinel'));
    expect(ctor).toContain('fallback: createCompactionFallbackDeps({');
    expect(ctor).toContain("store: new PendingInjectStore(path.join(config.stateDir, 'state'))");
    expect(ctor).toContain("sessionManager.classifyPaneState(sessionName) === 'ready'");
    expect(ctor).toContain('inject: (sessionName, text) => sessionManager.injectMessage(sessionName, text)');
    expect(ctor).toContain('buildTelegramCompactionText(sessionName, trigger)');
    expect(src).toContain('compactionSentinel.resumeStagedFallbacks()');
  });
});
