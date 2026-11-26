/**
 * Relay unknown-sender trust — integration tier (docs/specs/a2a-relay-unknown-sender-trust.md).
 *
 * The HTTP surface: a real AgentServer's /health carries the live mode and the
 * process-wide verdict counters on the AUTHED branch only, the mode is read
 * live (a config flip shows without a restart), and the counters move when the
 * real handler judges messages against a real AgentTrustManager.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import {
  handleRelayUnknownSender,
  newFingerprintProfileLevel,
  relayUnknownSenderTrustCounters,
  resetRelayUnknownSenderTrustCounters,
  resolveRelayUnknownSenderTrustMode,
} from '../../../src/threadline/relayUnknownSenderTrust.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const AUTH = 'rust-int-auth';
const FP = 'e'.repeat(64);

describe('Relay unknown-sender trust — /health surface', () => {
  let project: TempProject;
  let server: AgentServer;
  let config: InstarConfig;
  let tm: AgentTrustManager;

  beforeAll(async () => {
    project = createTempProject();
    config = {
      projectName: 'rust-int', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: project.state } as never);
    await server.start();
    tm = new AgentTrustManager({
      stateDir: project.stateDir,
      newFingerprintProfileLevel: () => newFingerprintProfileLevel(mode()),
      onFingerprintProfileCreated: (l) => { if (l === 'untrusted') relayUnknownSenderTrustCounters.profilesCreatedUntrusted++; },
    });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
    project?.cleanup();
    resetRelayUnknownSenderTrustCounters();
  });
  beforeEach(() => resetRelayUnknownSenderTrustCounters());

  const mode = () => resolveRelayUnknownSenderTrustMode({}, config as never);
  const health = async () => {
    const r = await request(server.getApp()).get('/health').set('Authorization', `Bearer ${AUTH}`);
    expect(r.status).toBe(200);
    return r.body.threadline?.relayUnknownSenderTrust as Record<string, number | boolean>;
  };
  const deliver = (type = 'chat') => handleRelayUnknownSender(
    { trustManager: tm, mode, counters: relayUnknownSenderTrustCounters, emit: () => {}, log: () => {} },
    { from: FP, fromName: 'eeee', threadId: 't', messageId: 'm', content: { content: 'hi', type }, timestamp: '', envelope: {} as never },
    type,
  );

  it('authed /health: on (dev gate), dry-run, all counters zero', async () => {
    expect(await health()).toEqual({
      enabled: true, dryRun: true,
      evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0, firstContactProfiles: 0, lookupErrors: 0, profilesCreatedUntrusted: 0,
      // No trust manager wired into this server: the evidence count is null, not 0.
      unmarkedSetupDefaultProfiles: null,
    });
  });

  it('unauthenticated /health does not carry the block', async () => {
    const r = await request(server.getApp()).get('/health');
    expect(r.body.threadline?.relayUnknownSenderTrust).toBeUndefined();
  });

  it('dry-run verdicts show on /health', async () => {
    expect(deliver()).toBe('would-refuse-delivered');
    expect(await health()).toMatchObject({ evaluated: 1, wouldRefuse: 1, firstContactProfiles: 1 });
  });

  it('a config flip is read live: enforcing shows and refuses; off shows disabled', async () => {
    (config.threadline as Record<string, unknown>).relayUnknownSenderTrust = { dryRun: false };
    try {
      expect(await health()).toMatchObject({ enabled: true, dryRun: false });
      // The dry-run first contact above wrote a marked profile: not a grant.
      expect(deliver('chat')).toBe('refused');
      tm.setTrustLevelByFingerprint(FP, 'verified', 'user-granted', 'grant', 'eeee');
      expect(deliver('chat')).toBe('passed');
      expect(deliver('task-request')).toBe('refused');
      expect(await health()).toMatchObject({ refused: 2, allowed: 1 });
      (config.threadline as Record<string, unknown>).relayUnknownSenderTrust = { enabled: false };
      expect(await health()).toMatchObject({ enabled: false });
    } finally {
      delete (config.threadline as Record<string, unknown>).relayUnknownSenderTrust;
    }
  });
});
