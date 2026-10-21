/**
 * Switching pairing on with NO restart performed by the person — production path
 * (upgrades/side-effects/threadline-enable-without-restart.md).
 *
 * A brand-new agent has its relay and pairing off. Its person asks it to connect with another
 * agent. The agent calls POST /threadline/pairing/enable on its own server. The server writes
 * the two config keys and requests its existing supervised restart (state/restart-requested.json).
 * The real ForegroundRestartWatcher (the production consumer in foreground mode; the lifeline
 * supervisor reads the same flag) picks the request up, and the "restart" boots a fresh server
 * from the config on disk exactly as boot does: the real bootstrapThreadline against a real
 * in-process relay, the real AgentServer and routes. Nobody but the agent and its server acts.
 * The agent then makes an invite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { ForegroundRestartWatcher } from '../../../src/core/ForegroundRestartWatcher.js';
import { resolveDevAgentGate } from '../../../src/core/devAgentGate.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { CONNECT_ENABLE_REQUESTED_BY } from '../../../src/threadline/connectEnable.js';
import { startFakeLifeline, type FakeLifeline } from '../../helpers/fakeLifeline.js';

const AUTH = 'pp-auth';

describe('pairing switched on without a person-performed restart (production path)', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  let project: TempProject;
  let running: { server: AgentServer; shutdown: () => Promise<void>; url: string } | null = null;
  let watcher: ForegroundRestartWatcher | null = null;
  let lifeline: FakeLifeline | null = null;

  // What boot does with the config on disk (server.ts): the relay follows threadline.relayEnabled,
  // and verifiedPairing.enabled rides the developmentAgent gate when omitted.
  async function bootFromDisk(): Promise<{ server: AgentServer; shutdown: () => Promise<void>; url: string }> {
    const disk = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'config.json'), 'utf-8')) as InstarConfig;
    const config = { ...disk, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH } as InstarConfig;
    const boot = await bootstrapThreadline({
      agentName: config.projectName, ownerName: 'pp-owner', stateDir: project.stateDir, projectDir: project.dir, port: 4091,
      relayEnabled: config.threadline?.relayEnabled, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: resolveDevAgentGate(config.threadline?.verifiedPairing?.enabled, config), dryRun: true, credentialShareEnforced: false }),
    });
    const trust = boot.trustManager ? createUnifiedTrustSystem(boot.trustManager, { stateDir: project.stateDir }) : undefined;
    const server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, config.projectName),
      ...(boot.relayClient ? { threadlineRelayClient: boot.relayClient } : {}),
      ...(trust ? { unifiedTrust: trust } : {}),
      ...(boot.pairingInvites ? { pairingInvites: boot.pairingInvites } : {}),
    } as never);
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    return {
      server, url: `http://127.0.0.1:${port}`,
      shutdown: async () => { await server.stop(); trust?.shutdown(); await boot.shutdown(); },
    };
  }

  // A reused keep-alive socket the server has just closed answers ECONNRESET under host load
  // (macOS loopback pressure, see vitest.e2e.config.ts). Every call here is idempotent, so a
  // reset is retried ONCE on a fresh connection, and logged so a real crash cannot hide.
  const call = async (method: string, p: string, body?: unknown, bearer = true) => {
    const once = async () => {
      const r = await fetch(`${running!.url}${p}`, {
        method, headers: { 'Content-Type': 'application/json', Connection: 'close', ...(bearer ? { Authorization: `Bearer ${AUTH}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
    };
    try {
      return await once();
    } catch (err) {
      console.warn(`[e2e] ${method} ${p} failed once (${String((err as { cause?: unknown }).cause ?? err)}); retrying`);
      return once();
    }
  };

  beforeAll(async () => {
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    project = createTempProject();
    // A brand-new fleet agent: not a development agent, relay off, pairing not set.
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify({
      projectName: 'pp', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: false,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false, visibility: 'unlisted' },
    }, null, 2));
    // This agent is supervised: a real process whose command line is an Instar lifeline holds the
    // lock (the route refuses to restart a server nothing would bring back). The test plays the
    // lifeline's restart part below.
    lifeline = await startFakeLifeline(project.stateDir);
    running = await bootFromDisk();
  }, 60_000);

  afterAll(async () => {
    watcher?.stop();
    lifeline?.stop();
    await running?.shutdown();
    project?.cleanup();
    await relay?.stop();
    relayData?.cleanup();
  });

  it('the agent switches pairing on itself; the server restarts itself; the agent makes an invite', async () => {
    // Before: pairing is off, so the invite route refuses.
    expect((await call('GET', '/threadline/pairing')).status).toBe(503);
    expect((await call('POST', '/threadline/pairing/invites', {})).status).toBe(503);

    // The route is the agent's own (Bearer) — nothing else can call it.
    expect((await call('POST', '/threadline/pairing/enable', {}, false)).status).toBe(401);

    // The agent's one call, at its person's request.
    const firstPid = process.pid;
    const en = await call('POST', '/threadline/pairing/enable', { sessionId: 'pp-topic-session' });
    expect(en.status).toBe(202);
    expect(en.body).toMatchObject({ state: 'restarting', backInSeconds: 60 });
    expect(String(en.body.sayToPerson)).not.toMatch(/restart|lifeline|setting/i);

    // Config on disk now opts this agent in, other keys untouched.
    const disk = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'config.json'), 'utf-8'));
    expect(disk.threadline).toEqual({ relayEnabled: true, visibility: 'unlisted', verifiedPairing: { enabled: true } });
    // The existing supervised-restart flag, as a planned restart, not an update.
    const flag = JSON.parse(fs.readFileSync(path.join(project.stateDir, 'state', 'restart-requested.json'), 'utf-8'));
    expect(flag).toMatchObject({ requestedBy: CONNECT_ENABLE_REQUESTED_BY, plannedRestart: true, pid: firstPid });
    expect(flag.targetVersion).toBeUndefined();

    // Asking again while the restart is on its way writes nothing new.
    const again = await call('POST', '/threadline/pairing/enable', { sessionId: 'pp-topic-session' });
    expect(again.body).toMatchObject({ state: 'restarting', requestRestart: false });

    // The production consumer of the flag picks it up; "restart" = boot again from disk.
    let restarted = false;
    watcher = new ForegroundRestartWatcher({
      stateDir: project.stateDir, pollIntervalMs: 50, exitOnRestart: false,
      onRestartDetected: async () => {
        await running!.shutdown();
        running = await bootFromDisk();
        restarted = true;
      },
    });
    watcher.start();
    await vi.waitFor(() => expect(restarted).toBe(true), { timeout: 30_000, interval: 100 });
    expect(fs.existsSync(path.join(project.stateDir, 'state', 'restart-requested.json'))).toBe(false);

    // After: pairing answers, and the agent makes an invite. No person did anything.
    expect((await call('GET', '/threadline/pairing')).status).toBe(200);
    const inv = await call('POST', '/threadline/pairing/invites', { ttlMinutes: 30 });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(String(inv.body.message)).toContain('tlinv1:');

    // And the route now just says ready (no further restart).
    const ready = await call('POST', '/threadline/pairing/enable', { sessionId: 'pp-topic-session' });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ state: 'ready', requestRestart: false });
  }, 90_000);
});
