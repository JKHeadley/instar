// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the canary heal ladder is ALIVE on the production path
 * (context-budget-layered-summaries §9.1, §7.8). An agent home whose
 * compaction hook family was never installed: a compaction with no recovery
 * block is detected by the canary, the ladder (built by the production
 * `productionCanaryHealAndPress` with the REAL PostUpdateMigrator) re-runs the
 * hook migration, the real install check then passes, and the verification
 * epoch restarts — read through the real route. WIRED: server.ts builds the
 * ladder and the press behind both dev gates and hands the CompactionSentinel
 * the server's marker writer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { productionCanaryHealAndPress, compactionHookInstallCheck } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { readSeedMarkerFile } from '../../src/monitoring/compactionSeedMarker.js';
import { recordPostCompact } from '../../src/monitoring/PostCompactStore.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-heal-ladder-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = '0f706e54-1995-4c2b-ba35-2f936f003eb1';
const MIN = 60_000;
const allow = async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const });

describe('canary heal ladder — alive on the production path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('hook not installed ⇒ the real migration re-runs, the real install check passes, the epoch restarts', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-heal-e2e-')); dirs.push(projectDir);
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4999, projectName: 'echo' }));
    // An agent from before the compaction hooks: its settings file exists (init always writes one) but has none of them.
    fs.mkdirSync(path.join(projectDir, '.claude'));
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const migratorConfig = { projectDir, stateDir, port: 4999, hasTelegram: true, projectName: 'echo' };
    expect(compactionHookInstallCheck(projectDir, stateDir).installed).toBe(false);

    const transcript = path.join(projectDir, `${SID}.jsonl`); fs.writeFileSync(transcript, '');
    let clock = Date.now() - 60 * MIN;
    const canary = new CompactionCanary({ stateDir, machineId: 'm_self', now: () => clock });
    canary.scan([], true); clock = Date.now();
    const sessions = [{ id: 'inst-topic', name: 'echo-141133', tmuxSession: 'echo-141133', telegramTopicId: 141133, framework: 'claude-code' as const, claudeSessionId: SID, status: 'running', startedAt: '' }];
    const sessionManager = { listRunningSessions: () => sessions as never[], killSessionByTmuxName: () => false, getProtectedSessions: () => [], isSessionActivelyWorking: () => false, classifyPaneState: () => 'ready', injectInternalControlCommand: () => true };
    const { heal, press } = await productionCanaryHealAndPress({
      stateDir, projectDir, machineId: 'm_self', canary, sessions: sessionManager as never,
      topicForSession: () => 141133, poolLive: () => false, compactionSentinel: () => null, reseedText: () => null,
      repairHooks: () => new PostUpdateMigrator(migratorConfig as never).repairCompactionRecoveryHooks(),
      readMarker: (cid) => readSeedMarkerFile(stateDir, cid),
      attention: () => {}, healAdmit: allow, pressAdmit: allow, consumeToken: () => ({ proceed: true, valid: true }),
    });
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: 'm_self', coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: allow, consumeToken: () => ({ proceed: true, valid: true }), episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: canary, sessions: () => [{ topicKey: '141133', claudeSessionId: SID, transcriptPath: transcript, engine: 'claude-code' }], switchOn: () => true },
      heal, press,
    });
    const at = Date.now() - 15 * MIN;
    fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-E2E', timestamp: new Date(at).toISOString(), compactMetadata: { trigger: 'auto' }, version: '2.1.321' }) + '\n');
    recordPostCompact(stateDir, { topicKey: '141133', instarSessionId: 'inst-topic', claudeSessionId: SID, trigger: 'auto', summary: 's', receivedAt: at + 500 });
    await sentinel.tick();

    expect(compactionHookInstallCheck(projectDir, stateDir)).toEqual({ installed: true, missing: [] });
    const ctx = { config: { projectName: 'echo', projectDir, stateDir, port: 0 } as never, sessionManager: { listRunningSessions: () => [] } as never, state: { getJobState: () => null, getSession: () => null } as never, startTime: new Date(), contextBudgetSentinel: sentinel } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
    const r = await request(app).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    expect(r.body.heal.recent.find((x: { epoch: string }) => x.epoch === 'boundary-E2E')).toMatchObject({ cause: 'hook-not-installed', action: 're-run-migration', outcome: 'healed:repaired' });
    expect(r.body.canary.groups[0].state).not.toBe('diverged');
    expect(r.body.lastError).toBeNull();
  }, 60_000);

  it('WIRED: server.ts builds the ladder and press behind both gates, passes them to the sentinel, and gives the CompactionSentinel the marker writer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("if (liveConfig.get<boolean>('contextBudget.sentinel.enabled', false) === true) {");
    expect(src).toMatch(/const healAndPress = contextLayersEnabled\(/);
    expect(src).toContain("sentinelGovernor.for('context-budget-canary-heal')");
    expect(src).toContain("sentinelGovernor.for('context-budget-synthetic-press')");
    expect(src).toContain('...(healAndPress ? { heal: healAndPress.heal, press: healAndPress.press } : {}),');
    expect(src).toContain('compactionSentinel: () => _compactionSentinelForHeal,');
    expect(src).toContain('_compactionSentinelForHeal = compactionSentinel;');
    expect(src).toContain('writeSeedMarker: (sessionName: string, boundaryUuid: string, source:');
    expect(src).toContain('}).repairCompactionRecoveryHooks(),');
  });
});
