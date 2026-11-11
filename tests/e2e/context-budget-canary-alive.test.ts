// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the standing compaction canary is ALIVE on the production path
 * (context-budget-layered-summaries §9.1, §7.8): the sentinel built with the
 * production canary session helper (real Claude Code transcript resolution
 * under a session's config home), ticked, and read through the real
 * GET /context-budget/sentinel route — a compaction with both of its
 * recovery artifacts reads complete. WIRED: server.ts gives the sentinel its
 * canary and passes the sentinel to AgentServer.
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
import { productionCanarySessions } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { recordPostCompact } from '../../src/monitoring/PostCompactStore.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-canary-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = '0f706e54-1995-4c2b-ba35-2f936f003ea7';

describe('compaction canary — alive on the production path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('a real-shaped compaction with its PostCompact record and recovery block reads complete through the route', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-canary-e2e-')); dirs.push(stateDir);
    const configHome = path.join(stateDir, 'claude-home');
    const projectDir = path.join(stateDir, 'project');
    // Where Claude Code would write this session's transcript (the production resolver's own path).
    const transcript = path.join(configHome, 'projects', projectDir.replace(/[/.]/g, '-'), `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '');
    const sessions = {
      listRunningSessions: () => [{ id: 's1', name: 'echo-141133', tmuxSession: 'echo-141133', telegramTopicId: 141133, framework: 'claude-code', claudeSessionId: SID } as never],
      killSessionByTmuxName: () => false,
      configHomeForSession: () => configHome,
    };
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: new CompactionCanary({ stateDir, machineId: built.holderId }), sessions: productionCanarySessions({ sessions, projectDir }), switchOn: () => true },
    });
    await sentinel.tick();
    const at = Date.now();
    fs.appendFileSync(transcript, [
      JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 968913, postTokens: 34011 }, uuid: 'b1', timestamp: new Date(at).toISOString(), sessionId: SID, version: '2.1.321' }),
      // The attachment exactly as Claude Code 2.1.321 writes it for Instar's session-start hook.
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', hookEvent: 'SessionStart', command: 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"', stdout: '=== IDENTITY RECOVERY (post-compaction) ===\nI am Echo.', content: '=== IDENTITY RECOVERY (post-compaction) ===\nI am Echo.', exitCode: 0 }, uuid: 'h1', sessionId: SID }),
      '',
    ].join('\n'));
    recordPostCompact(stateDir, { topicKey: '141133', instarSessionId: 'inst1', claudeSessionId: SID, trigger: 'auto', summary: 'summary', receivedAt: at + 500 });
    await sentinel.tick();

    const ctx = {
      config: { projectName: 'echo', projectDir, stateDir, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      startTime: new Date(), contextBudgetSentinel: sentinel,
    } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
    const r = await request(app).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    expect(r.body.canary.groups[0]).toMatchObject({ engine: 'claude-code', version: '2.1.321', detected: 1, complete: 1, pending: 0, state: 'accruing' });
  });

  it('WIRED: server.ts gives the sentinel its canary and passes the sentinel to AgentServer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    // One canary instance shared with the heal ladder (S11), scoped to Codex only when the Codex canary is on (S16).
    expect(src).toContain("const canaryInstance = new CompactionCanary({ stateDir: config.stateDir, machineId: built.holderId, engineInScope: (e) => e !== 'codex-cli' || codexCanaryOn() });");
    expect(src).toContain('instance: canaryInstance,');
    expect(src).toContain('sessions: productionCanarySessions({');
    expect(src).toContain('sessions: sessionManager, projectDir: config.projectDir,');
    expect(src).toContain('pressChecks: productionPressChecks(');
    expect(src).toContain('enabled: codexCanaryOn,');
    expect(src).toContain("switchOn: () => liveConfig.get<boolean>('contextBudget.compactionRecovery.enabled', true) !== false");
    expect(src).toContain('contextBudgetSentinel: _contextBudgetSentinel ?? undefined');
  });
});
