// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the Codex adapter's compaction channel is ALIVE on the production path
 * (context-budget-layered-summaries §9.6 Codex column, §9.1; Phase 1 S16):
 * the sentinel built with the production canary session helper and its Codex
 * gate, a real-layout rollout under the session's CODEX_HOME
 * (`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`), the canary's DEFAULT engine
 * hooks (the adapter's real `trackContextUsage` caller and post-compaction
 * producer), read through the real GET /context-budget/sentinel route.
 * Gate off ⇒ no Codex group, exactly today's behaviour.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { createCompactionLifecycle, _resetCompactionState } from '../../src/providers/adapters/openai-codex/control/compactionLifecycle.js';
import { sessionHandle } from '../../src/providers/types.js';
import type { PostCompactNotice, PreCompactNotice } from '../../src/providers/primitives/control/compactionLifecycle.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-codex-canary-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = '019a0000-1111-7222-8333-444455556666';

async function run(gateOn: boolean, dirs: string[]) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-codex-e2e-')); dirs.push(stateDir);
  const codexHome = path.join(stateDir, 'codex-home');
  const d = new Date();
  const day = path.join(codexHome, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-11-10T10-00-00-${SID}.jsonl`);
  fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: d.toISOString(), type: 'session_meta', payload: { id: SID, cli_version: '0.167.0', cwd: '/p' } })}\n`);
  const sessions = {
    listRunningSessions: () => [{ id: 's2', name: 'echo-200', tmuxSession: 'echo-200', telegramTopicId: 200, framework: 'codex-cli', claudeSessionId: SID } as never],
    killSessionByTmuxName: () => false,
  };
  const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
  const sentinel = new ContextBudgetSentinel({
    stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
    ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
    admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
    episodeStore: new InMemorySelfHealEpisodeStore(),
    canary: {
      instance: new CompactionCanary({ stateDir, machineId: built.holderId }),
      sessions: productionCanarySessions({ sessions, projectDir: '/p', codex: { enabled: () => gateOn, homeForSession: () => codexHome } }),
      switchOn: () => true,
    },
  });
  // Subscribe to the adapter's own lifecycle, as a consumer would.
  const lc = createCompactionLifecycle(); const ac = new AbortController();
  const pre: PreCompactNotice[] = []; const post: PostCompactNotice[] = [];
  void (async () => { for await (const n of lc.subscribePreCompact(sessionHandle(SID), { signal: ac.signal })) pre.push(n); })();
  void (async () => { for await (const n of lc.subscribePostCompact(sessionHandle(SID), { signal: ac.signal })) post.push(n); })();
  await sentinel.tick();
  const t = new Date().toISOString();
  fs.appendFileSync(rollout, [
    JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 231_000 }, model_context_window: 258_400 } } }),
    JSON.stringify({ timestamp: t, type: 'token_usage_record', payload: {} }),
    JSON.stringify({ timestamp: t, type: 'compacted', payload: { message: '', window_id: 'w-e2e-1', first_window_id: 'w0', previous_window_id: 'w0', window_number: 1, replacement_history: [], latest_token_usage_record: { usage: { input_tokens: 231_000 } } } }),
    '',
  ].join('\n'));
  await sentinel.tick();
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const ctx = {
    config: { projectName: 'echo', projectDir: '/p', stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    startTime: new Date(), contextBudgetSentinel: sentinel,
  } as unknown as RouteContext;
  const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
  const r = await request(app).get('/context-budget/sentinel');
  return { r, pre, post };
}

describe('Codex compaction channel — alive on the production path', () => {
  const dirs: string[] = [];
  beforeEach(() => _resetCompactionState());
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('gate ON: the rollout compaction is detected, counted (marked synthesized), and the adapter emits both notices', async () => {
    const { r, pre, post } = await run(true, dirs);
    expect(r.status).toBe(200);
    const g = r.body.canary.groups.find((x: { engine: string }) => x.engine === 'codex-cli');
    expect(g).toMatchObject({ engine: 'codex-cli', version: '0.167.0', detected: 1, state: 'counted', marking: 'synthesized', synthesizedSignals: 1 });
    expect(g.profile.healByInjection).toBe(false);
    expect(pre).toHaveLength(1);
    expect(pre[0].source).toBe('synthesized');
    expect(post).toHaveLength(1);
    expect(post[0].summary).toBeNull();
  });

  it('gate OFF: no Codex group and no notices — exactly today\'s behaviour', async () => {
    const { r, pre, post } = await run(false, dirs);
    expect(r.status).toBe(200);
    expect(r.body.canary.groups.map((x: { engine: string }) => x.engine)).toEqual(['claude-code']);
    expect(pre).toEqual([]); expect(post).toEqual([]);
  });

  it('WIRED: server.ts gives the canary its Codex scope under the contextBudget.enabled dev gate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("const codexCanaryOn = () => contextLayersEnabled(config as { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }, liveConfig.get<boolean | undefined>('contextBudget.enabled', undefined));");
    expect(src).toContain('enabled: codexCanaryOn,');
    expect(src).toContain("engineInScope: (e) => e !== 'codex-cli' || codexCanaryOn()");
    expect(src).toContain('homeForSession: (t) => codexHomeForTmuxSession(t, undefined, config.sessions.tmuxPath),');
    // The canary's default engine hooks are the adapter's real functions (not no-ops).
    const canary = fs.readFileSync(path.join(ROOT, 'src/monitoring/compactionCanary.ts'), 'utf-8');
    expect(canary).toContain('onUsage: (s, used, win) => trackContextUsage(sessionHandle(s.claudeSessionId), used, win ?? undefined),');
    expect(canary).toContain('onCompaction: (s, d, before) => emitPostCompactFromTranscript(');
    expect(canary).toContain('onRearm: (s) => rearmContextUsage(sessionHandle(s.claudeSessionId)),');
  });
});
