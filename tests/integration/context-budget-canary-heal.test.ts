// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the canary heal ladder and the synthetic press through the
 * real pipeline (context-budget-layered-summaries §9.1, §7.8):
 *  - a topic session's compaction with no recovery block ⇒ the sentinel's tick
 *    runs the PRODUCTION heal wiring, which re-injects the re-staged packet
 *    through the real CompactionSentinel's idle-gated PendingInjectStore path
 *    (never `report`), writes the seeded marker on disk, and the route shows it;
 *  - with compaction recovery off, nothing acts;
 *  - the press goes only to the throwaway, never the topic session, and the
 *    PostCompact route files a throwaway's record under its press key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { createCompactionFallbackDeps } from '../../src/monitoring/compactionFallbackStore.js';
import { PendingInjectStore } from '../../src/core/PendingInjectStore.js';
import { productionCanaryHealAndPress, healReseedText } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { readSeedMarkerFile, writeSeedMarkerFile } from '../../src/monitoring/compactionSeedMarker.js';
import { recordPostCompact, listPostCompactRecords } from '../../src/monitoring/PostCompactStore.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-budget-canary-heal.test.ts';
const SID = '0f706e54-1995-4c2b-ba35-2f936f003ea9';
const MIN = 60_000;
const allow = async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const });

function appFor(stateDir: string, sentinel: ContextBudgetSentinel | null, sessionManager: unknown = { listRunningSessions: () => [] }): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: sessionManager as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    startTime: new Date(), contextBudgetSentinel: sentinel,
  } as unknown as RouteContext;
  const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
  return app;
}

describe('canary heal ladder + synthetic press — the real pipeline', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  const rig = (o: { recoveryOn: boolean; paneReady?: boolean }) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-heal-int-')); dirs.push(stateDir);
    const jsonlRoot = path.join(stateDir, 'jsonl'); fs.mkdirSync(jsonlRoot);
    const transcript = path.join(jsonlRoot, `${SID}.jsonl`); fs.writeFileSync(transcript, '');
    // The hook family is installed (so the cause is "no recovery block", not a missing hook).
    const hooks = path.join(stateDir, 'hooks', 'instar'); fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'session-start.sh'), "x '_seeded' fit-recovery-output.mjs");
    fs.writeFileSync(path.join(hooks, 'compaction-recovery.sh'), 'echo "=== IDENTITY RECOVERY (post-compaction) ==="');
    fs.writeFileSync(path.join(hooks, 'fit-recovery-output.mjs'), '');
    fs.writeFileSync(path.join(hooks, 'post-compact.sh'), '');
    fs.mkdirSync(path.join(stateDir, '.claude'));
    fs.writeFileSync(path.join(stateDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: 'compact', hooks: [{ command: 'bash x/session-start.sh' }] }],
      PostCompact: [{ matcher: '', hooks: [{ command: 'bash x/post-compact.sh' }] }],
    } }));
    let clock = Date.now() - 60 * MIN;
    const canary = new CompactionCanary({ stateDir, machineId: 'm_self', now: () => clock });
    canary.scan([], true); clock = Date.now();
    const typed: Array<{ name: string; text: string }> = []; const pressed: string[] = [];
    const sessions = [
      { id: 'inst-topic', name: 'echo-141133', tmuxSession: 'echo-141133', telegramTopicId: 141133, framework: 'claude-code' as const, claudeSessionId: SID, status: 'running', startedAt: '' },
      { id: 'inst-press', name: 'cb-press-canary', tmuxSession: 'echo-cb-press-canary', framework: 'claude-code' as const, claudeSessionId: 'press-sid', status: 'running', startedAt: '' },
    ];
    const sessionManager = {
      listRunningSessions: () => sessions as never[], killSessionByTmuxName: () => false,
      getProtectedSessions: () => [], isSessionActivelyWorking: () => false, classifyPaneState: () => (o.paneReady === false ? 'busy' : 'ready'),
      injectInternalControlCommand: (t: string, _c: string, cmd: string) => { pressed.push(`${t}:${cmd}`); return true; },
      getSessionById: (id: string) => sessions.find((s) => s.id === id),
    };
    const compaction = new CompactionSentinel({
      recoverFn: async () => { throw new Error('report path must not run'); }, projectDir: stateDir, jsonlRoot,
      getClaudeSessionId: () => SID, getSessionFramework: () => 'claude-code',
      isCompactionRecoveryEnabled: () => o.recoveryOn, isSessionRecoverable: () => true, isActivelyWorking: () => false,
      readSeedMarker: () => readSeedMarkerFile(stateDir, SID),
      writeSeedMarker: (_n, epoch, source) => { const at = Date.now(); return writeSeedMarkerFile(stateDir, SID, { boundaryUuid: epoch, source, seededAt: at }) ? at : null; },
      fallback: createCompactionFallbackDeps({
        store: new PendingInjectStore(path.join(stateDir, 'state')),
        build: async () => 'declined', isReadyPrompt: () => o.paneReady !== false,
        inject: (name, text) => { typed.push({ name, text }); return true; },
      }),
    }, { fallbackIdleBoundMs: 3_000, seedPollMs: 200 });
    return { stateDir, transcript, canary, typed, pressed, sessionManager, compaction, setClock: (t: number) => { clock = t; } };
  };

  const build = async (r: ReturnType<typeof rig>, recoveryOn: boolean, attention: unknown[] = []) => {
    const { heal, press } = await productionCanaryHealAndPress({
      stateDir: r.stateDir, projectDir: r.stateDir, machineId: 'm_self', canary: r.canary, sessions: r.sessionManager as never,
      topicForSession: (t) => (t === 'echo-141133' ? 141133 : null), poolLive: () => false,
      compactionSentinel: () => r.compaction, reseedText: (topic) => healReseedText(topic, 'STANDING PACKET', { tmpDir: path.join(r.stateDir, 'heal-tmp') }),
      repairHooks: () => ({ upgraded: [], errors: [] }), readMarker: (cid) => readSeedMarkerFile(r.stateDir, cid),
      attention: (n) => { attention.push(n); }, healAdmit: allow, pressAdmit: allow, consumeToken: () => ({ proceed: true, valid: true }),
    });
    const built = buildFoldCoordinator({ stateDir: r.stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    return new ContextBudgetSentinel({
      stateDir: r.stateDir, machineId: 'm_self', coordinator: built.coordinator, store: new FoldRecordStore(r.stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: allow, consumeToken: () => ({ proceed: true, valid: true }), episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: r.canary, sessions: () => [{ topicKey: '141133', claudeSessionId: SID, transcriptPath: r.transcript, engine: 'claude-code' }], switchOn: () => recoveryOn },
      heal, press,
    });
  };

  const missedRecovery = (r: ReturnType<typeof rig>) => {
    const at = Date.now() - 15 * MIN;
    fs.appendFileSync(r.transcript, JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-X', timestamp: new Date(at).toISOString(), compactMetadata: { trigger: 'auto' }, version: '2.1.321' }) + '\n');
    recordPostCompact(r.stateDir, { topicKey: '141133', instarSessionId: 'inst-topic', claudeSessionId: SID, trigger: 'auto', summary: 's', receivedAt: at + 500 });
  };

  it('a compaction whose recovery block never arrived is healed through the idle-gated injector, the marker written, the route showing it', async () => {
    const r = rig({ recoveryOn: true });
    const sentinel = await build(r, true);
    missedRecovery(r);
    await sentinel.tick();
    expect(r.typed).toHaveLength(1);
    expect(r.typed[0].name).toBe('echo-141133');
    expect(r.typed[0].text).toMatch(/^\[telegram:141133\] Your context was compacted/);
    expect(r.typed[0].text).not.toMatch(/FIRST sentence/);
    expect(readSeedMarkerFile(r.stateDir, SID)).toMatchObject({ epoch: 'boundary-X', source: 'heal' });
    const res = await request(appFor(r.stateDir, sentinel)).get('/context-budget/sentinel');
    expect(res.status).toBe(200);
    expect(res.body.heal.recent.find((x: { epoch: string }) => x.epoch === 'boundary-X')).toMatchObject({ cause: 'no-recovery-block', action: 're-stage-and-reinject-seed', terminal: true });
    // The verification epoch restarted: the historical divergence no longer holds the canary diverged.
    expect(res.body.canary.groups[0].state).not.toBe('diverged');
    // The press then earns the positive control on the throwaway, never on the topic session.
    expect(r.pressed).toEqual(['echo-cb-press-canary:/compact']);
    expect(res.body.press.last.outcome).toBe('pressed');
    compactionStop(r);
  });

  it('a busy pane holds the re-inject (never typed mid-turn)', async () => {
    const r = rig({ recoveryOn: true, paneReady: false });
    const sentinel = await build(r, true);
    missedRecovery(r);
    await sentinel.tick();
    expect(r.typed).toEqual([]);
    compactionStop(r);
  });

  it('compaction recovery off ⇒ the heal and the press do nothing', async () => {
    const r = rig({ recoveryOn: false });
    const sentinel = await build(r, false);
    missedRecovery(r);
    await sentinel.tick();
    expect(r.typed).toEqual([]);
    expect(r.pressed).toEqual([]);
    const res = await request(appFor(r.stateDir, sentinel)).get('/context-budget/sentinel');
    expect(res.body.heal.recent).toEqual([]);
    expect(res.body.press.last).toBeNull();
    compactionStop(r);
  });

  it('the PostCompact route files a throwaway press target under its press key; a topic session keeps its topic', async () => {
    const r = rig({ recoveryOn: true });
    const app = appFor(r.stateDir, null, { ...r.sessionManager, listRunningSessions: () => [] });
    const p = await request(app).post('/hooks/post-compact').set('X-Instar-Session-Id', 'inst-press')
      .send({ hook_event_name: 'PostCompact', session_id: 'press-sid', trigger: 'manual', compact_summary: 'summary' });
    expect(p.body.recorded).toBe(true);
    expect(listPostCompactRecords(r.stateDir, 'press-inst-press')).toHaveLength(1);
    compactionStop(r);
  });
});

function compactionStop(r: { compaction: CompactionSentinel }): void { r.compaction.stop(); }
