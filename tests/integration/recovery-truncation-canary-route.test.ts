// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — a recovery block Claude Code cut to its preview (over the
 * hook-output limit; Phase 0 results check 4) reaches GET
 * /context-budget/sentinel as a truncated, diverged compaction — never as a
 * recovery — through the real sentinel tick and the real routes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { RouteContext } from '../../src/server/routes.js';

const OP = 'tests/integration/recovery-truncation-canary-route.test.ts';

function appFor(stateDir: string, sentinel: ContextBudgetSentinel | null): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextBudgetSentinel: sentinel,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /context-budget/sentinel — truncated recovery delivery', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('a recovery block replaced by the oversize preview reads truncated and diverged', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-trunc-')); dirs.push(stateDir);
    const transcript = path.join(stateDir, 't.jsonl');
    fs.writeFileSync(transcript, '');
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: new CompactionCanary({ stateDir, machineId: built.holderId }), sessions: () => [{ topicKey: '141133', claudeSessionId: 'sid', transcriptPath: transcript, engine: 'claude-code' }], switchOn: () => true },
    });
    await sentinel.tick();
    const ts = new Date().toISOString();
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: ts, sessionId: 'sid', version: '2.1.322' })}\n`);
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'attachment', uuid: 'a1', timestamp: ts, attachment: { type: 'hook_success', hookName: 'SessionStart:compact', command: 'bash "$CLAUDE_PROJECT_DIR/.instar/hooks/instar/session-start.sh"', exitCode: 0, stdout: '--- MACHINE LOAD ---\\n=== IDENTITY RECOVERY (post-compaction) ===\\n' + 'y'.repeat(45000), content: '<persisted-output>\nOutput too large (45.7KB). Full output saved to: /x\n\nPreview (first 2KB):\n=== IDENTITY RECOVERY (post-compaction) ===\n' } })}\n`);
    await sentinel.tick();
    const r = await request(appFor(stateDir, sentinel)).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    expect(r.body.canary.groups[0]).toMatchObject({ engine: 'claude-code', version: '2.1.322', state: 'diverged', truncated: 1, complete: 0 });
    expect(r.body.canary.recent[0]).toMatchObject({ recoveryBlock: false, recoveryTruncated: true });
  });
});
