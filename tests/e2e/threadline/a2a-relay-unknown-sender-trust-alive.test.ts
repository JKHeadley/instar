/**
 * Relay unknown-sender trust — E2E "feature is alive" tier
 * (docs/specs/a2a-relay-unknown-sender-trust.md).
 *
 * Production initialization path, mirroring server.ts: two REAL
 * `bootstrapThreadline` instances connected to a REAL in-repo RelayServer. The
 * receiver gets the live mode reader exactly as server.ts supplies it
 * (`resolveRelayUnknownSenderTrustMode` over the config, developmentAgent on,
 * enabled omitted). The sender writes a real plaintext relay message; the
 * receiver does not hold its keys, so the relay client raises `unknown-sender`.
 *
 *  - alive: the receiver's AgentServer authed /health reports the check on,
 *    in dry-run;
 *  - dry-run: the stranger is passed on as today (verified) and counted;
 *  - enforcing (read live): a NEW stranger's message never reaches
 *    `gate-passed`, no profile is written; after an operator grant it passes
 *    at the held level.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { createUnifiedTrustSystem, type UnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import {
  resetRelayUnknownSenderTrustCounters,
  resolveRelayUnknownSenderTrustMode,
} from '../../../src/threadline/relayUnknownSenderTrust.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const AUTH = 'rust-e2e-auth';

describe('Relay unknown-sender trust — production path is alive', () => {
  let relay: RelayServer;
  let relayUrl: string;
  const projects: TempProject[] = [];
  const boots: Array<Awaited<ReturnType<typeof bootstrapThreadline>>> = [];
  let recvBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let recvConfig: InstarConfig;
  let recvServer: AgentServer;
  let recvTrust: UnifiedTrustSystem;
  let recvFp: string;
  let firstStrangerFp = '';
  const passed: Array<{ reason?: string; trustLevel?: string; fingerprint?: string }> = [];

  const newSender = async (name: string) => {
    const p = createTempProject();
    projects.push(p);
    const b = await bootstrapThreadline({ agentName: name, stateDir: p.stateDir, projectDir: p.dir, port: 4041, relayEnabled: true, relayUrl });
    boots.push(b);
    expect(b.relayClient?.connectionState).toBe('connected');
    return b;
  };

  beforeAll(async () => {
    resetRelayUnknownSenderTrustCounters();
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    const recvProject = createTempProject();
    projects.push(recvProject);
    recvConfig = {
      projectName: `rust-e2e-recv-${process.pid}`, projectDir: recvProject.dir, stateDir: recvProject.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: true },
    } as InstarConfig;
    recvBoot = await bootstrapThreadline({
      agentName: recvConfig.projectName, stateDir: recvProject.stateDir, projectDir: recvProject.dir, port: 4040, relayEnabled: true, relayUrl,
      // As server.ts supplies it (the live config file is absent here, so the
      // config object decides).
      getRelayUnknownSenderTrustMode: () => resolveRelayUnknownSenderTrustMode({}, recvConfig as never),
    });
    boots.push(recvBoot);
    expect(recvBoot.relayClient?.connectionState).toBe('connected');
    // Wiring integrity: relay enabled ⇒ a real trust manager.
    expect(recvBoot.trustManager).toBeDefined();
    recvFp = recvBoot.relayClient!.fingerprint!;
    recvBoot.relayClient!.on('gate-passed', (d: { reason?: string; trustLevel?: string; fingerprint?: string }) => {
      passed.push({ reason: d.reason, trustLevel: d.trustLevel, fingerprint: d.fingerprint });
    });
    recvTrust = createUnifiedTrustSystem(recvBoot.trustManager!, { stateDir: recvProject.stateDir });
    recvServer = new AgentServer({ config: recvConfig, sessionManager: createMockSessionManager() as never, state: recvProject.state, threadlineRelayClient: recvBoot.relayClient!, unifiedTrust: recvTrust } as never);
    await recvServer.start();
  }, 60_000);

  afterAll(async () => {
    await recvServer?.stop();
    recvTrust?.shutdown();
    for (const b of boots) await b.shutdown();
    await relay?.stop();
    for (const p of projects) p.cleanup();
    resetRelayUnknownSenderTrustCounters();
  });

  const counters = async () => {
    const r = await request(recvServer.getApp()).get('/health').set('Authorization', `Bearer ${AUTH}`);
    expect(r.status).toBe(200);
    return r.body.threadline.relayUnknownSenderTrust as Record<string, number | boolean>;
  };

  it('is alive: the authed /health reports the check on, in dry-run', async () => {
    expect(await counters()).toMatchObject({ enabled: true, dryRun: true, evaluated: 0, wouldRefuse: 0, refused: 0 });
    // A pre-change style profile (setup-default, unmarked) is counted for the operator.
    recvBoot.trustManager!.getOrCreateProfileByFingerprint('f'.repeat(32), 'legacy-peer');
    expect((await counters()).unmarkedSetupDefaultProfiles).toBe(1);
  });

  it('dry-run: a stranger is passed on as today (verified) and counted as would-refuse', async () => {
    const sender = await newSender(`rust-e2e-a-${process.pid}`);
    const fp = sender.relayClient!.fingerprint!;
    const before = passed.length;
    sender.relayClient!.sendPlaintext(recvFp, 'hello from a stranger');
    await vi.waitFor(() => expect(passed.length).toBe(before + 1), { timeout: 10_000 });
    expect(passed.at(-1)).toMatchObject({ reason: 'relay-authenticated', trustLevel: 'verified', fingerprint: fp });
    expect(await counters()).toMatchObject({ evaluated: 1, wouldRefuse: 1, firstContactProfiles: 1 });
    // Today's legacy profile is still written in dry-run.
    expect(recvBoot.trustManager!.getTrustLevelByFingerprint(fp)).toBe('verified');
    // …marked durably as a first contact, so enforcement will not count it as a grant.
    expect(recvBoot.trustManager!.getProfileByFingerprint(fp)?.relayFirstContact).toBe(true);
    firstStrangerFp = fp;
  });

  it('enforcing (read live): a new stranger never reaches gate-passed and writes no profile; a grant lets it through at the held level', async () => {
    (recvConfig.threadline as Record<string, unknown>).relayUnknownSenderTrust = { dryRun: false };
    try {
      const sender = await newSender(`rust-e2e-b-${process.pid}`);
      const fp = sender.relayClient!.fingerprint!;
      const before = passed.length;
      sender.relayClient!.sendPlaintext(recvFp, 'hello while enforcing');
      await vi.waitFor(async () => expect((await counters()).refused).toBe(1), { timeout: 10_000 });
      expect(passed.length).toBe(before);
      expect(recvBoot.trustManager!.getProfileByFingerprint(fp)).toBeNull();
      // The dry-run stranger's first-contact profile grants nothing now, on the gate's reads too.
      expect(recvBoot.trustManager!.getTrustLevelByFingerprint(firstStrangerFp)).toBe('untrusted');

      recvBoot.trustManager!.setTrustLevelByFingerprint(fp, 'trusted', 'user-granted', 'e2e grant', 'b');
      sender.relayClient!.sendPlaintext(recvFp, 'hello after the grant');
      await vi.waitFor(() => expect(passed.length).toBe(before + 1), { timeout: 10_000 });
      expect(passed.at(-1)).toMatchObject({ reason: 'relay-authenticated', trustLevel: 'trusted', fingerprint: fp });
      expect(await counters()).toMatchObject({ dryRun: false, refused: 1, allowed: 1 });
    } finally {
      delete (recvConfig.threadline as Record<string, unknown>).relayUnknownSenderTrust;
    }
  });
});
