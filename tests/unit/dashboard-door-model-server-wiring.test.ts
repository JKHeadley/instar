/**
 * Wiring integrity — dashboard door + model controls in the server.ts
 * composition root (docs/specs/dashboard-door-model-controls.md §3.3).
 *
 * The unit/integration/e2e tiers prove the core functions; this pins that
 * server.ts actually seats them on the SAME `_topicProfileCtx` object the routes
 * read, with real dependencies (not no-ops), and that the pool seam never uses
 * the fail-open lease fallback. Source-parse is the established convention for
 * composition-root wiring (see topic-profile-server-wiring.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
const ctxBlock = src.slice(src.indexOf('const _topicProfileCtx: {'), src.indexOf('// ── StrandedTopicSentinel'));

describe('dashboard door + model — server.ts wiring', () => {
  it('seats the new-topic default store, audit sink and seed disclosure on the routes ctx', () => {
    expect(ctxBlock).toContain('newTopicDefault: new NewTopicDefaultStore(config.stateDir)');
    expect(ctxBlock).toContain('audit: (event) => { appendTopicProfileAudit(config.stateDir, event); }');
    expect(ctxBlock).toContain("sendDeterministicTelegramNotice(telegram, 'topic-profile-creation-seed', Number(topicKey), text)");
  });

  it('spawnForTopic goes through the ONE chokepoint with silentStart, guarded by the late-bound spawningTopics ref', () => {
    expect(ctxBlock).toContain('spawnForTopic: createSpawnForTopic({');
    expect(ctxBlock).toContain('guard: () => _spawningTopicsRegistryRef');
    expect(ctxBlock).toMatch(/spawn: \(topicId, name\) => spawnSessionForTopic\([\s\S]*?\{ silentStart: true \}/);
  });

  it('the pool seam reads the NULLABLE lease accessor (never the `: true` fallback) and the hoisted replication flag', () => {
    expect(ctxBlock).toContain('holdsLease: _holdsLeaseForSpawn,');
    expect(ctxBlock).toContain('replicationOn: _placementReplicationOn');
    expect(ctxBlock).toContain("routerLive = (): boolean => !!_sessionRouter && _sessionPoolStage() !== 'dark'");
    expect(ctxBlock).not.toMatch(/_holdsLeaseForSpawn \? _holdsLeaseForSpawn\(\) : true/);
    expect(src).toContain('_placementReplicationOn = _replicationOn;');
  });

  it('the ready ops are built next to the router over the authoritative registry, emit and nonce stream', () => {
    const at = src.indexOf('_dashboardPoolClaimOps = createDashboardPoolClaimOps({');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 500);
    expect(block).toContain('ownershipRegistry: ownReg');
    expect(block).toContain('emitPlacement,');
    expect(block).toContain('++routerNonce');
    expect(block).toContain('_confirmLocalSessionPoolClaim?.(sk)');
    // Built BEFORE the router it sits beside.
    expect(at).toBeLessThan(src.indexOf('_sessionRouter = new routerMod.SessionRouter({'));
  });

  it('the ctx object handed to AgentServer is the same one carrying the thunks', () => {
    expect(src).toContain('topicProfile: _topicProfileCtx ?? undefined');
  });

  it('the raw topic-session-registry writeFileSync is gone from /sessions/create', () => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');
    const handler = routes.slice(routes.indexOf("router.post('/sessions/create'"), routes.indexOf('// ── Token Ledger'));
    expect(handler).not.toContain('topic-session-registry.json');
    expect(handler).not.toContain('writeFileSync');
    expect(handler).toContain('tp.spawnForTopic(topicId, topicName)');
  });

  it('new routes are registered before /topic-profile/:topicId', () => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');
    const param = routes.indexOf("router.get('/topic-profile/:topicId'");
    expect(routes.indexOf("router.get('/topic-profile/options'")).toBeLessThan(param);
    expect(routes.indexOf("router.post('/topic-profile/new-topic-default'")).toBeLessThan(routes.indexOf("router.post('/topic-profile/:topicId'"));
  });
});
