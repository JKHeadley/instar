/**
 * Wiring integrity — the dashboard Machine choice in the server.ts composition
 * root (docs/specs/dashboard-new-session-machine-choice.md §3.4). Source-parse is
 * the established convention for composition-root wiring (see
 * dashboard-door-model-server-wiring.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('dashboard machine choice — server.ts wiring', () => {
  it('the start seam is built next to the router over the authoritative registry, journal and nonce stream, with a CHECKED deliver', () => {
    const at = src.indexOf('_dashboardStartOnMachine = (sk, target, start, pin) => dmcMod.startTopicOnMachine({');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 2200);
    expect(block).toContain('ownReg.cas(action');
    expect(block).toContain('emitPlacement(key, r');
    expect(block).toContain('++routerNonce');
    expect(block).toContain("type: 'deliverMessage'");
    expect(block).toContain('dmcMod.classifyDeliverReply(res)');
    // §3.4 step 0 — the pre-flight probes the same signed plane with the read-class command.
    const probeAt = src.indexOf('_dashboardProbeMachine = async (machineId) => {');
    expect(probeAt).toBeGreaterThan(-1);
    expect(src.slice(probeAt, probeAt + 600)).toContain("{ type: 'session-status' }");
    // Never the router's fire-and-forget spawnOnMachine or its inbound queue.
    expect(block).not.toContain('spawnOnMachine');
    expect(block).not.toContain('queueMessage');
    expect(at).toBeLessThan(src.indexOf('_sessionRouter = new routerMod.SessionRouter({'));
  });

  it('the routes ctx carries startTopicOnMachine + pinReplicationLive (not no-ops)', () => {
    const ctxBlock = src.slice(src.indexOf('const _topicProfileCtx: {'), src.indexOf('// ── StrandedTopicSentinel'));
    expect(ctxBlock).toContain('startTopicOnMachine: (topicKey, target, start, pin) => {');
    expect(ctxBlock).toContain('return fn(topicKey, target, start, pin);');
    expect(ctxBlock).toMatch(/pinReplicationLive: \(\) => resolveDevAgentGate\([\s\S]*?ws13PinReplicate/);
    expect(ctxBlock).toContain('startSeamWired: () => !!_dashboardStartOnMachine');
    expect(ctxBlock).toContain('probeMachineReachable: (machineId) => (_dashboardProbeMachine ? _dashboardProbeMachine(machineId) : Promise.resolve(false))');
  });

  it('the owner-side branch runs FIRST in onAccepted, only for a parsed object payload under a dashboard-create id', () => {
    const at = src.indexOf('onAccepted: (cmd) => {');
    const block = src.slice(at, at + 3000);
    expect(block).toContain('parseDashboardCreatePayload(cmd.payload)');
    expect(block).toContain('cmd.messageId.startsWith(`dashboard-create:${cmd.session}:`)');
    expect(block.indexOf('_runDashboardCreateStart')).toBeLessThan(block.indexOf('workingSetPullCoordinator'));
  });

  it('the owner-side runner is the shared core factory with real deps', () => {
    const at = src.indexOf('_runDashboardCreateStart = createDashboardCreateStartRunner({');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1500);
    expect(block).toContain('seed: seedTopicProfileAtCreation');
    expect(block).toContain('spawnForTopic: () => _topicProfileCtxRef?.spawnForTopic ?? null');
    expect(block).toContain("sendDeterministicTelegramNotice(telegram, 'topic-profile-creation-seed'");
  });

  it('a forwarded message during a dashboard start waits for the binding instead of spawning twice', () => {
    expect(src).toContain('if (_dashboardStartsInFlight.has(topicId) || _spawningTopicsRegistryRef?.has(topicId)) {');
    expect(src).toContain("'dashboard-create-start-did-not-bind'");
    // Bounded Blast Radius: the detached waiters are capped, and the cap is released in finally.
    expect(src).toContain('if (_dashboardStartWaiters >= DASHBOARD_START_WAITERS_MAX) {');
    expect(src).toContain("'dashboard-create-start-wait-capacity'");
    expect(src).toMatch(/\} finally \{\s*_dashboardStartWaiters--;/);
    expect(src).toMatch(/\.finally\(\(\) => \{\s*_dashboardStartsInFlight\.delete\(dcTopic\);[\s\S]*?_inboundQueue\?\.markRemoteInjected\(cmd\.session, cmd\.messageId\);/);
  });

  it('the capability flag is advertised only when the owner-side branch can run', () => {
    expect(src).toContain("dashboardCreateReceive: _sessionPoolStage() !== 'dark' && !!telegram && !!_topicProfileCtxRef?.spawnForTopic");
  });

  it('the new routes are registered before /topic-profile/:topicId', () => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');
    const paramPost = routes.indexOf("router.post('/topic-profile/:topicId'");
    const paramGet = routes.indexOf("router.get('/topic-profile/:topicId'");
    expect(routes.indexOf("router.post('/topic-profile/validate-choice'")).toBeLessThan(paramPost);
    expect(routes.indexOf("router.get('/topic-profile/options', async")).toBeLessThan(paramGet);
  });
});
