/**
 * /skills/learned over the full HTTP pipeline (docs/specs/skill-learning-sentinel.md §3.10, slice 1):
 * 503 `skill-learning-disabled` while the flag is off or no sentinel is bound; 200 with the status shape
 * (plus `machine`) when on; the slug grammar at the edge (400); the operator-PIN gate on both taps
 * (401 without bearer, 403 without a PIN, 403 with the wrong one, 429 after the limit); `disagree`
 * refused without a reason (400); a non-holder forwards the tap to the lease holder (which re-runs the
 * PIN check) and never to itself; an unreachable holder is a visible 503 `lease-holder-unreachable`.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createSkillLearningRoutes, SKILL_LEARNING_DISABLED, LEASE_HOLDER_UNREACHABLE, SKILL_LEARNING_PIN_MESSAGE, FORWARDED_HEADER } from '../../src/server/skillLearningRoutes.js';
import type { SkillLearningSentinelLike, SkillLearningStatus, ProposalSummary, LearnedSkillSummary } from '../../src/monitoring/skillLearning/types.js';

const TOKEN = 'tok';
const PIN = '246810';
const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

const proposal: ProposalSummary = {
  name: 'weekly-ci-health', key: 'k1', arbiterOnly: false, createdAt: '2026-11-06T10:00:00Z',
  paraphrases: ['how is CI this week?', 'weekly CI health please'], description: 'Report the week’s CI health with the failing jobs named.',
};
const skill: LearnedSkillSummary = {
  name: 'release-notes', state: 'learned', score: 0.8, uses: 5, accepted: 3, acceptedInferred: 1, corrected: 1, unknown: 0, weakPositive: 0,
  measurableRate: 0.8, misfires: 0, version: 1, locked: false,
};
function status(): SkillLearningStatus {
  return {
    machine: 'sentinel-said', enabled: true, mode: 'shadow',
    counts: { requests: 12, verified: 11, keys: 3, proposals: 1, skills: 1 },
    channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' },
    pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0,
    filtered: { 'not-user': 2, forwarded: 0, 'not-operator': 1, 'confirmation-reply': 3, 'slack-asserted': 0 },
    skills: [skill], proposals: [proposal], pending: [], retired: [], lastTickAt: '2026-11-06T11:00:00Z', llmSpendCentsToday: 4,
  };
}

/** In-memory sentinel: records every verdict so the test can see what the route handed it. */
function fakeSentinel() {
  const verdicts: Array<{ name: string; verdict: string; reason?: string }> = [];
  const sentinel: SkillLearningSentinelLike = {
    status,
    skill: (name) => (name === proposal.name ? proposal : name === skill.name ? skill : null),
    recordOperatorVerdict: (name, verdict, reason) => {
      if (name !== proposal.name) return { ok: false, error: 'not-found' };
      verdicts.push({ name, verdict, reason });
      return { ok: true };
    },
  };
  return { sentinel, verdicts };
}

/** The production pipeline in miniature: JSON body, bearer gate (as middleware.ts answers), then the module. */
function app(opts: { enabled?: boolean; sentinel?: SkillLearningSentinelLike | null; holderUrl?: string | null; dashboardPin?: string | null; port?: number; stateDir?: string } = {}) {
  const ctx = {
    config: { authToken: TOKEN, dashboardPin: opts.dashboardPin === undefined ? PIN : opts.dashboardPin ?? undefined, port: opts.port ?? 4042, stateDir: opts.stateDir, monitoring: { skillLearning: { enabled: opts.enabled ?? true } } },
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Studio' : 'Laptop' }) },
    resolveRouterUrl: () => opts.holderUrl ?? null,
    pinAttemptStore: null,
    skillLearningSentinel: () => (opts.sentinel === undefined ? null : opts.sentinel),
  } as never;
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'Missing or invalid Authorization header' }); return; }
    next();
  });
  a.use(createSkillLearningRoutes(ctx, { forwardTimeoutMs: 2_000 }));
  return a;
}
const auth = { Authorization: `Bearer ${TOKEN}` };

describe('forwarding error machine identity', () => {
  it.each(['proposals/weekly-ci-health/agree', 'pending/weekly-ci-health/confirm'])('%s qualifies local storage failures and preserves peer responses', async (route) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-storage-http-'));
    fs.mkdirSync(path.join(stateDir, 'machine'));
    fs.mkdirSync(path.join(stateDir, 'machines'));
    fs.writeFileSync(path.join(stateDir, 'machine/identity.json'), JSON.stringify({ machineId: 'm_self' }));
    fs.writeFileSync(path.join(stateDir, 'machines/registry.json'), JSON.stringify({ version: 1, machines: { m_self: { nickname: 'Studio' } } }));
    const a = app({ stateDir, holderUrl: 'http://holder.invalid', sentinel: fakeSentinel().sentinel });
    const transport = vi.spyOn(globalThis, 'fetch');
    const tap = () => request(a).post(`/skills/learned/${route}`).set(auth).send({ pin: PIN });
    try {
      transport.mockRejectedValueOnce(Object.assign(new Error('ENOSPC: write failed'), { code: 'ENOSPC' }));
      const local = await tap();
      expect(local.status).toBe(503);
      expect(local.body).toMatchObject({ error: LEASE_HOLDER_UNREACHABLE, detail: 'Studio: ENOSPC: write failed' });

      transport.mockRejectedValueOnce(new Error('fetch failed'));
      expect((await tap()).body.detail).toBe('fetch failed');

      transport.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'storage-full', detail: 'Laptop: disk full' }), { status: 507 }));
      const peer = await tap();
      expect(peer.status).toBe(507);
      expect(peer.body).toEqual({ error: 'storage-full', detail: 'Laptop: disk full', handledBy: 'holder-proxy' });
    } finally {
      transport.mockRestore();
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/skill-learning-routes.test.ts:storage-cleanup' });
    }
  });
});

async function holder(handler: express.RequestHandler): Promise<{ url: string; calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> }> {
  const calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  const a = express();
  a.use(express.json());
  a.post('/skills/learned/proposals/:name/:verdict', (req, res, next) => { calls.push({ path: req.path, body: req.body, headers: req.headers }); next(); }, handler);
  const s = http.createServer(a);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls };
}

describe('GET /skills/learned', () => {
  it('503 skill-learning-disabled while the flag is off, even with a sentinel bound', async () => {
    const res = await request(app({ enabled: false, sentinel: fakeSentinel().sentinel })).get('/skills/learned').set(auth);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: SKILL_LEARNING_DISABLED, machine: 'Studio' });
  });

  it('503 skill-learning-disabled while the flag is on but no sentinel is bound', async () => {
    const res = await request(app({ enabled: true, sentinel: null })).get('/skills/learned').set(auth);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(SKILL_LEARNING_DISABLED);
  });

  it('200 with the full status shape, naming THIS machine', async () => {
    const res = await request(app({ sentinel: fakeSentinel().sentinel })).get('/skills/learned').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ machine: 'Studio', enabled: true, mode: 'shadow', pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0, llmSpendCentsToday: 4 });
    expect(res.body.counts).toEqual({ requests: 12, verified: 11, keys: 3, proposals: 1, skills: 1 });
    expect(res.body.channels).toEqual({ telegram: 'measured', slack: 'support-only', app: 'unmeasurable' });
    expect(res.body.filtered).toEqual({ 'not-user': 2, forwarded: 0, 'not-operator': 1, 'confirmation-reply': 3, 'slack-asserted': 0 });
    expect(res.body.proposals).toEqual([proposal]);
    expect(res.body.skills).toEqual([skill]);
    expect(res.body.pending).toEqual([]);
    expect(res.body.retired).toEqual([]);
  });

  it('401 without the bearer', async () => {
    const res = await request(app({ sentinel: fakeSentinel().sentinel })).get('/skills/learned');
    expect(res.status).toBe(401);
  });
});

describe('GET /skills/learned/:name', () => {
  it('a proposal, a learned skill, 404 for an unknown one, 400 for a bad slug', async () => {
    const a = app({ sentinel: fakeSentinel().sentinel });
    expect((await request(a).get('/skills/learned/weekly-ci-health').set(auth)).body).toMatchObject({ ...proposal, machine: 'Studio' });
    expect((await request(a).get('/skills/learned/release-notes').set(auth)).body).toMatchObject({ ...skill, machine: 'Studio' });
    expect((await request(a).get('/skills/learned/nothing-here').set(auth)).status).toBe(404);
    for (const bad of ['Weekly', '-lead', 'trail-', 'a..b', 'x'.repeat(65), 'a%20b']) {
      const res = await request(a).get(`/skills/learned/${bad}`).set(auth);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe('invalid-skill-name');
    }
  });

  it('503 when dark (the slug check still runs first)', async () => {
    const a = app({ enabled: false });
    expect((await request(a).get('/skills/learned/weekly-ci-health').set(auth)).status).toBe(503);
    expect((await request(a).get('/skills/learned/BAD').set(auth)).status).toBe(400);
  });
});

describe('POST /skills/learned/proposals/:name/{agree,disagree} — this machine holds the lease', () => {
  it('401 without the bearer; 403 with the bearer but no PIN (skill-specific message); nothing recorded', async () => {
    const { sentinel, verdicts } = fakeSentinel();
    const a = app({ sentinel });
    expect((await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').send({ pin: PIN })).status).toBe(401);
    const noPin = await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({});
    expect(noPin.status).toBe(403);
    expect(noPin.body.error).toBe(SKILL_LEARNING_PIN_MESSAGE);
    const wrong = await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'Incorrect PIN', attemptsRemaining: 4 });
    expect(verdicts).toEqual([]);
  });

  it('503 when no dashboardPin is configured (a PIN gate cannot be satisfied, so it refuses)', async () => {
    const res = await request(app({ sentinel: fakeSentinel().sentinel, dashboardPin: null })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(res.status).toBe(503);
  });

  it('agree with the right PIN records the verdict and names the machine', async () => {
    const { sentinel, verdicts } = fakeSentinel();
    const res = await request(app({ sentinel })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: 'weekly-ci-health', verdict: 'agree', machine: 'Studio' });
    expect(verdicts).toEqual([{ name: 'weekly-ci-health', verdict: 'agree', reason: undefined }]);
  });

  it('disagree without a reason is 400 before the PIN is even looked at; with one it records the reason', async () => {
    const { sentinel, verdicts } = fakeSentinel();
    const a = app({ sentinel });
    for (const body of [{ pin: PIN }, { pin: PIN, reason: '' }, { pin: PIN, reason: '   ' }, { pin: PIN, reason: 7 }]) {
      const res = await request(a).post('/skills/learned/proposals/weekly-ci-health/disagree').set(auth).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('reason-required');
    }
    expect(verdicts).toEqual([]);
    const res = await request(a).post('/skills/learned/proposals/weekly-ci-health/disagree').set(auth).send({ pin: PIN, reason: 'wrong steps' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, verdict: 'disagree', reason: 'wrong steps' });
    expect(verdicts).toEqual([{ name: 'weekly-ci-health', verdict: 'disagree', reason: 'wrong steps' }]);
  });

  it('a verdict the sentinel refuses is 404 (unknown proposal) — never a silent 200', async () => {
    const res = await request(app({ sentinel: fakeSentinel().sentinel })).post('/skills/learned/proposals/release-notes/agree').set(auth).send({ pin: PIN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not-found');
  });

  it('bad slug 400; dark 503; five wrong PINs lock the address out (429)', async () => {
    const { sentinel } = fakeSentinel();
    expect((await request(app({ sentinel })).post('/skills/learned/proposals/Bad_Name/agree').set(auth).send({ pin: PIN })).status).toBe(400);
    expect((await request(app({ enabled: false, sentinel })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN })).status).toBe(503);
    const a = app({ sentinel });
    for (let i = 0; i < 5; i++) expect((await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: 'nope' })).status).toBe(403);
    const locked = await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(locked.status).toBe(429);
  });
});

describe('POST taps — another machine holds the lease', () => {
  it('forwards the tap (PIN + reason + bearer + forwarded header) to the holder and relays its answer; nothing is recorded here', async () => {
    const h = await holder((req, res) => { res.json({ ok: true, name: req.params.name, verdict: req.params.verdict, machine: 'Laptop' }); });
    const { sentinel, verdicts } = fakeSentinel();
    const res = await request(app({ sentinel, holderUrl: h.url })).post('/skills/learned/proposals/weekly-ci-health/disagree').set(auth).send({ pin: PIN, reason: 'other' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, name: 'weekly-ci-health', verdict: 'disagree', machine: 'Laptop', handledBy: 'holder-proxy' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe('/skills/learned/proposals/weekly-ci-health/disagree');
    expect(h.calls[0].body).toEqual({ pin: PIN, reason: 'other' });
    expect(h.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0].headers[FORWARDED_HEADER]).toBe('Studio');
    expect(verdicts).toEqual([]);
  });

  it('the holder re-runs the PIN check: its 403 comes back as a 403, and a wrong PIN never leaves this machine', async () => {
    const h = await holder((_req, res) => { res.status(403).json({ error: 'Incorrect PIN', attemptsRemaining: 2 }); });
    const a = app({ sentinel: fakeSentinel().sentinel, holderUrl: h.url });
    const relayed = await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(relayed.status).toBe(403);
    expect(relayed.body).toEqual({ error: 'Incorrect PIN', attemptsRemaining: 2, handledBy: 'holder-proxy' });
    const local = await request(a).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: 'wrong' });
    expect(local.status).toBe(403);
    expect(h.calls).toHaveLength(1); // the wrong PIN was refused here, not forwarded
  });

  it('an unreachable holder is 503 lease-holder-unreachable; nothing is recorded locally', async () => {
    const { sentinel, verdicts } = fakeSentinel();
    const res = await request(app({ sentinel, holderUrl: 'http://127.0.0.1:1' })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(LEASE_HOLDER_UNREACHABLE);
    expect(verdicts).toEqual([]);
  });

  it('never proxies to itself: an already-forwarded request, or a resolver naming our own port, is answered here', async () => {
    const { sentinel, verdicts } = fakeSentinel();
    const h = await holder((_req, res) => { res.status(500).json({ error: 'should not be called' }); });
    const bounced = await request(app({ sentinel, holderUrl: h.url })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).set(FORWARDED_HEADER, 'Laptop').send({ pin: PIN });
    expect(bounced.status).toBe(200);
    expect(bounced.body.machine).toBe('Studio');
    const selfUrl = await request(app({ sentinel, holderUrl: 'http://localhost:4042', port: 4042 })).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth).send({ pin: PIN });
    expect(selfUrl.status).toBe(200);
    expect(h.calls).toHaveLength(0);
    expect(verdicts).toHaveLength(2);
  });

  it('reads are never forwarded: GET answers for this machine even when another holds the lease', async () => {
    const res = await request(app({ sentinel: fakeSentinel().sentinel, holderUrl: 'http://127.0.0.1:1' })).get('/skills/learned').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.machine).toBe('Studio');
  });
});
