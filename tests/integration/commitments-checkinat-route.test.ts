/**
 * POST /commitments accepts a dated promise — the writer the four readers needed.
 *
 * The full HTTP pipeline. Before this, `checkInAt` was silently discarded: the
 * request succeeded, the field was absent from the stored record, and
 * `GET /commitments/check-in-reminder` reported `datedCount: 0` forever because no
 * commitment could carry a date. These tests pin acceptance, the bare-date refusal,
 * and the deliberate decision that a date alone does NOT satisfy the
 * follow-through requirement while the reconciler that acts on it ships dry-run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-checkinat-auth';
const INSTANT = '2026-10-24T17:00:00.000Z';

describe('POST /commitments — checkInAt (integration)', () => {
  let project: TempProject;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);
  const body = (extra: Record<string, unknown>) => ({
    type: 'one-time-action',
    userRequest: 'tell me when the release is out',
    agentResponse: 'I will report once it publishes',
    ...extra,
  });

  beforeAll(() => {
    project = createTempProject();
    const liveConfig = new LiveConfig(project.stateDir);
    tracker = new CommitmentTracker({ stateDir: project.stateDir, liveConfig });
    const config: InstarConfig = {
      projectName: 'test-checkinat', projectDir: project.dir, stateDir: project.stateDir,
      port: 0, authToken: AUTH, sessions: { maxSessions: 3 }, scheduler: { enabled: false },
      users: [], messaging: [],
    } as unknown as InstarConfig;
    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config, sessionManager: mockSM.manager, state: mockSM.state, commitmentTracker: tracker,
    });
    app = server.getApp();
  });

  afterAll(() => { tracker.stop(); project.cleanup(); });

  it('stores a valid instant on the created commitment', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      checkInAt: INSTANT,
      followThroughOptOutReason: 'the dated check-in is the follow-through here',
    })));
    expect(res.status).toBe(201);
    const created = res.body.commitment ?? res.body;
    expect(created.checkInAt).toBe(INSTANT);
    // And it is really in the store, which is the half that was broken.
    expect(tracker.getAll().find((c) => c.id === created.id)?.checkInAt).toBe(INSTANT);
  });

  it('rejects a prose verification method instead of creating a promise that fails every sweep', async () => {
    const before = tracker.getAll().length;
    const res = await auth(request(app).post('/commitments').send(body({
      verificationMethod: 'Review the research evidence',
      followThroughOptOutReason: 'Research still in progress.',
    })));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('verificationMethod');
    expect(tracker.getAll()).toHaveLength(before);
  });

  it('rejects a config check without a concrete setting and expected value', async () => {
    const before = tracker.getAll().length;
    const res = await auth(request(app).post('/commitments').send({
      type: 'config-change', userRequest: 'Remove the daily delay', agentResponse: 'I will remove it',
      followThroughOptOutReason: 'legacy test record without a deadline',
    }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('configPath');
    expect(tracker.getAll()).toHaveLength(before);
  });

  it('REFUSES a bare date, naming why rather than resolving it to an hour nobody chose', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      checkInAt: '2026-10-24',
      followThroughOptOutReason: 'x',
    })));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('bare date');
  });

  it('refuses a non-timestamp outright', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      checkInAt: 'Friday', followThroughOptOutReason: 'x',
    })));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('ISO 8601');
  });

  it('a date ALONE does not satisfy the follow-through requirement (the reconciler is dry-run)', async () => {
    const res = await auth(request(app).post('/commitments').send(body({ checkInAt: INSTANT })));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('exactly one follow-through choice');
  });

  it('rides alongside beacon enrollment, which remains the live follow-through path', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      topicId: 61449, beaconEnabled: true,
      nextUpdateDueAt: '2099-01-01T00:00:00.000Z',
      checkInAt: INSTANT,
    })));
    expect(res.status).toBe(201);
    const created = res.body.commitment ?? res.body;
    expect(created.checkInAt).toBe(INSTANT);
    expect(created.nextUpdateDueAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('omits the field when no date is sent — no default date is invented', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      followThroughOptOutReason: 'nothing to follow up',
    })));
    expect(res.status).toBe(201);
    const created = res.body.commitment ?? res.body;
    expect(created.checkInAt).toBeUndefined();
  });

  it('a stored date is not a delivery — checkInReminderSentAt stays unset', async () => {
    const res = await auth(request(app).post('/commitments').send(body({
      checkInAt: INSTANT, followThroughOptOutReason: 'x',
    })));
    const created = res.body.commitment ?? res.body;
    expect(created.checkInReminderSentAt).toBeUndefined();
  });

  it('the dated set the reminder route reports on is no longer necessarily empty', async () => {
    await auth(request(app).post('/commitments').send(body({
      checkInAt: INSTANT, followThroughOptOutReason: 'x',
    })));
    // Asserted against the SAME predicate `GET /commitments/check-in-reminder`
    // applies (`all.filter(c => !!c.checkInAt)`), rather than against the route
    // itself: the route 503s here because `CheckInReminderReconciler` is not
    // constructed in this harness (it ships dark). Asserting the 503 would be
    // asserting the harness, not this change — what this change makes true is
    // that the filter can now match something, which it never could before.
    expect(tracker.getAll().filter((c) => !!c.checkInAt).length).toBeGreaterThan(0);
  });
});
