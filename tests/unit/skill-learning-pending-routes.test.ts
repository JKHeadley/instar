/**
 * Pending confirm/reject routes — Tier 1 (Testing Integrity Standard).
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.10; integration map deviations (w)/(x)/(y).
 * The PIN-lockout bucket must never be attacker-chosen: a bearer holder inventing a fresh
 * `X-Instar-Forwarded-From` per request gets the IP bucket, not a fresh 5-attempt bucket each time.
 * Only a header naming a MESH-ROSTER machine, on a request that did not arrive over loopback, earns
 * an additional bucket — and both buckets are checked and charged. Also: an unknown pending name is
 * 404 (`pending-not-found`), a real conflict stays 409.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSkillLearningRoutes, FORWARDED_FROM_HEADER } from '../../src/server/skillLearningRoutes.js';
import type { SkillLearningSentinelLike } from '../../src/monitoring/skillLearning/types.js';

const PIN = '246810';

function stubSentinel(over: Partial<SkillLearningSentinelLike> = {}): SkillLearningSentinelLike {
  return {
    status: () => ({ machine: 'm_alpha', enabled: true, mode: 'live', counts: { requests: 0, verified: 0, keys: 0, proposals: 0, skills: 0 }, channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0, filtered: { 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0, 'slack-asserted': 0 }, skills: [], proposals: [], pending: [], retired: [] }),
    skill: () => null,
    recordOperatorVerdict: () => ({ ok: true }),
    confirmPending: async (name) => (name === 'known-skill' ? { ok: true } : name === 'conflicted' ? { ok: false, error: 'commit:user-edit-conflict' } : { ok: false, error: 'pending-not-found' }),
    rejectPending: async (name) => (name === 'known-skill' ? { ok: true } : { ok: false, error: 'pending-not-found' }),
    ...over,
  };
}

function app(opts: { roster?: string[]; trustProxy?: boolean } = {}) {
  const a = express();
  if (opts.trustProxy !== false) a.set('trust proxy', true); // so X-Forwarded-For sets req.ip (a non-loopback forwarder)
  a.use(express.json());
  const sentinel = stubSentinel();
  a.use(createSkillLearningRoutes({
    config: { dashboardPin: PIN, authToken: 'tok', port: 4042, monitoring: { skillLearning: { enabled: true } } } as never,
    meshSelfId: 'm_alpha',
    machinePoolRegistry: null,
    resolveRouterUrl: () => null,
    pinAttemptStore: null,
    listPoolMachines: () => (opts.roster ?? ['m_beta']).map((machineId) => ({ machineId })),
    skillLearningSentinel: () => sentinel,
  }));
  return a;
}

const tap = (a: express.Express, name: string, pin: string, headers: Record<string, string> = {}) =>
  request(a).post(`/skills/learned/pending/${name}/confirm`).set(headers).send({ pin });

describe('pending taps — PIN lockout buckets are never attacker-chosen', () => {
  it('20 wrong PINs across 20 invented forwarded-from headers share the IP bucket: 429 by the sixth', async () => {
    const a = app();
    for (let i = 1; i <= 20; i++) {
      const res = await tap(a, 'known-skill', 'wrong', { 'X-Forwarded-For': '10.0.0.9', [FORWARDED_FROM_HEADER]: `m_fake_${i}` });
      if (i <= 5) expect(res.status, `attempt ${i}`).toBe(403);
      else expect(res.status, `attempt ${i}`).toBe(429);
    }
    // Even the right PIN from that address is locked out now.
    expect((await tap(a, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.9', [FORWARDED_FROM_HEADER]: 'm_fake_99' })).status).toBe(429);
    // Another address is untouched.
    expect((await tap(a, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.10' })).status).toBe(200);
  });

  it('a roster machine\'s forwarded bucket is its own AND shared across the addresses it forwards from; a lockout on either bucket refuses', async () => {
    const a = app({ roster: ['m_beta'] });
    // Three wrong from each of two addresses, both naming the roster machine: the forwarded bucket
    // reaches 5 while each IP bucket holds only 3 — the sixth is refused by the forwarded bucket.
    for (let i = 0; i < 3; i++) expect((await tap(a, 'known-skill', 'wrong', { 'X-Forwarded-For': '10.0.0.5', [FORWARDED_FROM_HEADER]: 'm_beta' })).status).toBe(403);
    for (let i = 0; i < 2; i++) expect((await tap(a, 'known-skill', 'wrong', { 'X-Forwarded-For': '10.0.0.6', [FORWARDED_FROM_HEADER]: 'm_beta' })).status).toBe(403);
    expect((await tap(a, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.6', [FORWARDED_FROM_HEADER]: 'm_beta' })).status).toBe(429);
    // The second address, WITHOUT the forwarded header, still has its own IP budget (2 used of 5).
    expect((await tap(a, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.6' })).status).toBe(200);
    // And the IP bucket is charged too: the first address has 3 used; two more wrong direct taps lock it.
    for (let i = 0; i < 2; i++) expect((await tap(a, 'known-skill', 'wrong', { 'X-Forwarded-For': '10.0.0.5' })).status).toBe(403);
    expect((await tap(a, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.5' })).status).toBe(429);
  });

  it('a roster header over LOOPBACK earns no extra bucket (self cannot forward to self); a correct forwarded tap records forwardedFromMachine', async () => {
    const a = app({ roster: ['m_beta'] });
    for (let i = 0; i < 5; i++) expect((await tap(a, 'known-skill', 'wrong', { [FORWARDED_FROM_HEADER]: 'm_beta' })).status).toBe(403);
    expect((await tap(a, 'known-skill', PIN, { [FORWARDED_FROM_HEADER]: 'm_beta' })).status).toBe(429); // loopback IP bucket locked
    const b = app({ roster: ['m_beta'] });
    const ok = await tap(b, 'known-skill', PIN, { 'X-Forwarded-For': '10.0.0.5', [FORWARDED_FROM_HEADER]: 'm_beta' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, name: 'known-skill', action: 'confirm', forwardedFromMachine: 'm_beta' });
  });

  it('an unknown pending name is 404; a real conflict is 409; a bad slug is 400 before the PIN', async () => {
    const a = app();
    expect((await tap(a, 'nobody-home', PIN)).status).toBe(404);
    expect((await tap(a, 'nobody-home', PIN)).body).toMatchObject({ error: 'pending-not-found' });
    expect((await request(a).post('/skills/learned/pending/nobody-home/reject').send({ pin: PIN })).status).toBe(404);
    expect((await tap(a, 'conflicted', PIN)).status).toBe(409);
    expect((await tap(a, 'Bad Name', PIN)).status).toBe(400);
    expect((await tap(a, 'known-skill', '')).status).toBe(403);
  });
});
