// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the adapter verification suite on the production path
 * (context-budget-layered-summaries §9.6): the sentinel's production trigger
 * (`productionAdapterSuite`) sees an engine version with no recorded result,
 * spawns the suite's own process (the real `adapterSuiteCli` entry), which
 * drives an engine CLI binary (a fake headless Claude Code that runs the real
 * probe hooks) and records the result; the sentinel's status then carries it,
 * and the next tick does not re-run it. WIRED: server.ts gates it behind its
 * own switch and gives it the configured Claude binary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { productionAdapterSuite } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { configureClaudeChildAuth } from '../../src/core/claudeChildAuth.js';

const OP = 'tests/e2e/adapter-suite-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('adapter verification suite — production trigger, real child process', () => {
  const dirs: string[] = [];
  afterEach(() => { configureClaudeChildAuth(null); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('an unrecorded engine version is verified once in its own process and the result reaches the sentinel status', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-e2e-')); dirs.push(stateDir);
    const fakeHome = path.join(stateDir, 'fake-claude'); fs.mkdirSync(fakeHome);
    process.env.FAKE_CLAUDE_HOME = fakeHome;
    // A key-configured agent: every engine call of the suite must carry the configured key.
    configureClaudeChildAuth(() => 'sk-ant-oat-e2e-configured');
    const suite = productionAdapterSuite({
      stateDir, machine: 'm_e2e', claudePath: path.join(ROOT, 'tests/fixtures/fake-claude-headless.mjs'),
      cli: [path.join(ROOT, 'node_modules/.bin/vite-node'), path.join(ROOT, 'src/monitoring/adapterSuiteCli.ts'), '--'],
    });
    // The real `--version` probe against the binary, asynchronous: null until it answers.
    expect(suite.currentVersion()).toBeNull();
    for (let i = 0; i < 100 && suite.currentVersion() === null; i++) await new Promise((r) => setTimeout(r, 50));
    expect(suite.currentVersion()).toBe('2.1.322');
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    let runs = 0;
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
      adapterSuite: { currentVersion: suite.currentVersion, run: () => { runs++; return suite.run(); } },
    });
    await sentinel.tick();
    expect(sentinel.status().adapterSuite.running).toBe(true);
    const deadline = Date.now() + 120_000;
    while (sentinel.status().adapterSuite.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const st = sentinel.status().adapterSuite;
    expect(st.running).toBe(false);
    expect(st.results[0]).toMatchObject({ engine: 'claude-code', version: '2.1.322', machine: 'm_e2e' });
    const caps = st.results[0].capabilities;
    for (const k of ['transcriptRead', 'controlCompact', 'controlClear', 'compactionDetection', 'preCompactionSteering', 'postCompactSummary', 'seedAfterCompaction', 'seedAfterClear', 'materialiseResume', 'perPromptDelta', 'toolPolicy', 'frameworkDiscriminator'] as const) {
      expect(caps[k].state, k).toBe('supported');
    }
    // The run's outcome is recorded; nothing of the throwaway project lives under the agent's state.
    expect(sentinel.status().adapterSuite.lastRun).toMatchObject({ ok: true, version: '2.1.322' });
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-budget', 'adapter-suite', 'work'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-archive'))).toBe(false); // the restore's checkpoint stayed in the throwaway dir
    const seen = fs.readFileSync(path.join(fakeHome, 'auth-seen'), 'utf-8').trim().split('\n');
    expect(seen.length).toBeGreaterThan(3);
    expect(new Set(seen)).toEqual(new Set(['sk-ant-oat-e2e-configured']));
    await sentinel.tick();
    expect(runs).toBe(1); // recorded: not re-run for this version
  }, 180_000);

  it('WIRED: server.ts gates the suite behind its own switch and passes the configured Claude binary', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("liveConfig.get<boolean>('contextBudget.adapterSuite.enabled', false) === true");
    expect(src).toContain('productionAdapterSuite({ stateDir: config.stateDir, machine: built.holderId, claudePath: config.sessions.claudePath })');
  });
});
