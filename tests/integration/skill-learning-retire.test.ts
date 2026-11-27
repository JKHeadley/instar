// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Skill Learning Sentinel — Tier 2, slice 3B (docs/specs/skill-learning-sentinel.md §3.8 retire/restore/lock,
 * §3.10 routes): the REAL CommitProtocol + VersionStore + LearnedSkillReconciler + Retirer over a temp agent home
 * (granting fence), the REAL SkillLearningSentinel with stub model families (no network), and the REAL routes
 * module behind the production-shaped bearer gate:
 *
 *  - `POST /skills/learned/:name/{lock,unlock,retire,restore}` and `POST /skills/learned/retire-all`: no PIN 403,
 *    wrong PIN 403, good PIN 200 (and the disk effect: locked → archived rendering; unlocked → rendered again;
 *    retired → canonical under `retired/`, renderings archived; restored → `pending`, listed with the harm reason);
 *    a bad slug is 400 before anything; feature off → 503;
 *  - a non-holder forwards the tap, body (PIN included) unchanged, to the holder (`handledBy: holder-proxy`, the
 *    holder's log row carries `forwardedFromMachine`); a dead holder is 503 `lease-holder-unreachable`;
 *  - retire-all writes the audit row with the re-arm date and the status shows it; GET fills `retired[]`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { CommitProtocol } from '../../src/monitoring/skillLearning/CommitProtocol.js';
import { VersionStore } from '../../src/monitoring/skillLearning/VersionStore.js';
import { Retirer } from '../../src/monitoring/skillLearning/Retirer.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import { createSkillLearningRoutes, SKILL_LEARNING_DISABLED, LEASE_HOLDER_UNREACHABLE, SKILL_LEARNING_LIFECYCLE_PIN_MESSAGE, FORWARDED_FROM_HEADER } from '../../src/server/skillLearningRoutes.js';
import type { FenceResult } from '../../src/monitoring/skillLearning/WriterFence.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { SkillLearningConfig, SkillLearningSentinelLike } from '../../src/monitoring/skillLearning/types.js';
import { FakeLedger, NOW, DAY } from '../helpers/skillLearningLiveFixtures.js';

const TOKEN = 'tok';
const PIN = '246810';
const NAME = 'ci-health-report';
const TMP = process.env.TMPDIR ?? os.tmpdir();

const homes: string[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/skill-learning-retire.test.ts' });
});

function canonicalDoc(state: 'active' | 'pending', name = NAME): string {
  return [
    '---', `name: ${name}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', '  instar-learned-key: "ci-health"',
    '  instar-learned-version: "1"', '  instar-learned-created: "2026-10-01T11:00:00Z"', '  instar-learned-locked: "false"', `  instar-learned-state: "${state}"`,
    '---', '# CI health report', '', '1. Read the CI health route at /ci/health.', '2. Summarise failing jobs in plain language.', '',
  ].join('\n');
}

function grantingFence() {
  return { acquireFence: (): FenceResult => ({ ok: true, epoch: 0, fence: 'local' }), peekEpoch: () => 0, medium: () => 'local' as const };
}

interface Home { root: string; stateDir: string; machineId: string; reconciler: LearnedSkillReconciler; protocol: CommitProtocol; retirer: Retirer; sentinel: SkillLearningSentinel; clock: { now: number } }

function home(machineId = 'm1'): Home {
  const root = fs.mkdtempSync(path.join(TMP, 'sl-retire-int-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const clock = { now: NOW };
  const now = () => clock.now;
  const reconciler = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], now });
  const versions = new VersionStore({ stateDir, machineId, now });
  const protocol = new CommitProtocol({ projectDir: root, stateDir, machineId, fence: grantingFence(), versions, reconciler, now });
  const config = { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, mode: 'live' as const };
  const retirer = new Retirer({ projectDir: root, stateDir, machineId, config, commitProtocol: protocol, versions, forgetRenderings: (rels) => reconciler.forgetRenderings(rels), now });
  reconciler.setRetirer(retirer);
  const providers: FamilyProvider[] = [{ family: 'anthropic', framework: 'claude-code' }, { family: 'openai', framework: 'codex-cli' }].map((f) => ({
    family: f.family, framework: f.framework,
    evaluate: async (prompt) => {
      if (prompt.startsWith('You are the independent reviewer')) return '{"follows":true,"lines":{},"cost":"accept","reason":"grounded"}';
      if (prompt.startsWith('You are the skill-learning reviewer judging')) return '{"verdict":"keep","harm":false,"reason":"fixture"}';
      throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
    },
  }));
  const sentinel = new SkillLearningSentinel({
    config, stateDir, projectDir: root, machineId, ledger: new FakeLedger(), families: () => providers, transcriptPath: () => null, operatorMessage: () => null,
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true }, commitProtocol: protocol, versionStore: versions, retirer, reviewer: null, reverter: null, mode: () => 'live', rungTwoProven: () => false, now,
  });
  return { root, stateDir, machineId, reconciler, protocol, retirer, sentinel, clock };
}

const rendering = (h: Home, layout: '.claude' | '.agents', name = NAME) => path.join(h.root, layout, 'skills', name, 'SKILL.md');
const canonical = (h: Home, name = NAME) => path.join(h.root, '.instar', 'skills', name, 'SKILL.md');
const retiredCanonical = (h: Home, name = NAME) => path.join(h.stateDir, 'skill-learning', 'retired', name, 'SKILL.md');
const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
const logRows = (h: Home) => { const p = path.join(h.stateDir, 'logs', 'skill-learning.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []; };

async function liveSkill(h: Home, name = NAME): Promise<void> {
  const res = await h.protocol.write('create', name, canonicalDoc('active', name), { expectedPrevHash: null, authorFamily: 'anthropic' });
  expect(res.ok).toBe(true);
  expect(readIf(rendering(h, '.claude', name))).not.toBeNull();
}

/** The production pipeline in miniature: JSON body, bearer gate, then the module. */
function app(opts: { sentinel: SkillLearningSentinelLike | null; enabled?: boolean; holderUrl?: string | null; meshSelfId?: string; port?: number; coordinator?: { holdsLease(): boolean } | null }) {
  const ctx = {
    config: { authToken: TOKEN, dashboardPin: PIN, port: opts.port ?? 4042, monitoring: { skillLearning: { enabled: opts.enabled ?? true } } },
    meshSelfId: opts.meshSelfId ?? 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Studio' : id === 'm_standby' ? 'Laptop' : 'Holder' }) },
    resolveRouterUrl: () => opts.holderUrl ?? null,
    pinAttemptStore: null,
    coordinator: opts.coordinator ?? undefined,
    skillLearningSentinel: () => opts.sentinel,
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

async function serve(a: express.Express): Promise<{ url: string; calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> }> {
  const calls: Array<{ path: string; body: unknown; headers: http.IncomingHttpHeaders }> = [];
  const wrapper = express();
  wrapper.use(express.json());
  wrapper.use((req, _res, next) => { calls.push({ path: req.path, body: req.body, headers: req.headers }); next(); });
  wrapper.use(a);
  const s = http.createServer(wrapper);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls };
}

describe('the lifecycle taps over the real routes, PIN gate and disk', () => {
  it('lock: no PIN 403, wrong PIN 403, good PIN 200 → canonical operator-owned and the rendering archived; unlock renders it again', async () => {
    const h = home();
    await liveSkill(h);
    const a = app({ sentinel: h.sentinel });
    const noPin = await request(a).post(`/skills/learned/${NAME}/lock`).set(auth).send({});
    expect(noPin.status).toBe(403);
    expect(noPin.body.error).toBe(SKILL_LEARNING_LIFECYCLE_PIN_MESSAGE);
    expect((await request(a).post(`/skills/learned/${NAME}/lock`).set(auth).send({ pin: '000000' })).status).toBe(403);
    expect(readIf(canonical(h))).toMatch(/instar-learned-state: "?active"?/);
    const ok = await request(a).post(`/skills/learned/${NAME}/lock`).set(auth).send({ pin: PIN, reason: 'I edit this one myself' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, name: NAME, action: 'lock', machine: 'Studio' });
    expect(readIf(canonical(h))).toMatch(/instar-learned-state: "?operator-owned"?/);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(fs.existsSync(path.join(h.stateDir, 'skill-learning', 'retired', NAME, 'renderings', 'm1', 'claude', 'SKILL.md'))).toBe(true);
    expect(logRows(h).find((r) => r.kind === 'lock')).toMatchObject({ by: 'operator', detail: 'I edit this one myself', lockLeftRendering: [] });
    const status = await request(a).get('/skills/learned').set(auth);
    expect(status.body.skills).toMatchObject([{ name: NAME, state: 'locked', locked: true }]);
    expect(status.body.lockLeftRendering).toEqual([]);
    expect(status.body.retired).toEqual([]);
    // Unlock: back to active, rendered fresh.
    expect((await request(a).post(`/skills/learned/${NAME}/unlock`).set(auth).send({})).status).toBe(403);
    const un = await request(a).post(`/skills/learned/${NAME}/unlock`).set(auth).send({ pin: PIN });
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({ ok: true, action: 'unlock' });
    expect(readIf(canonical(h))).toMatch(/instar-learned-state: "?active"?/);
    expect(readIf(rendering(h, '.claude'))).toMatch(/^x-instar-stamp:/m);
  });

  it('retire: no/wrong/good PIN; good → canonical under retired/, both renderings archived, GET lists it in retired[] with the reason; a second tap is idempotent', async () => {
    const h = home();
    await liveSkill(h);
    const a = app({ sentinel: h.sentinel });
    expect((await request(a).post(`/skills/learned/${NAME}/retire`).set(auth).send({})).status).toBe(403);
    expect((await request(a).post(`/skills/learned/${NAME}/retire`).set(auth).send({ pin: '1' })).status).toBe(403);
    const ok = await request(a).post(`/skills/learned/${NAME}/retire`).set(auth).send({ pin: PIN, reason: 'not useful any more' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'retire' });
    expect(readIf(canonical(h))).toBeNull();
    expect(readIf(retiredCanonical(h))).toMatch(/instar-learned-state: "?retired"?/);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(readIf(rendering(h, '.agents'))).toBeNull();
    const status = await request(a).get('/skills/learned').set(auth);
    expect(status.body.retired).toMatchObject([{ name: NAME, reason: 'not useful any more', kind: 'operator', by: 'operator', renderingsArchived: { m1: ['agents', 'claude'] }, archiveDir: `skill-learning/retired/${NAME}` }]);
    expect(status.body.skills).toEqual([]);
    expect(status.body.retireBlocked).toEqual([]);
    const again = await request(a).post(`/skills/learned/${NAME}/retire`).set(auth).send({ pin: PIN });
    expect(again.status).toBe(200);
    expect(again.body.detail).toBe('already retired');
    expect((await request(a).post('/skills/learned/nothing-here/retire').set(auth).send({ pin: PIN })).status).toBe(404);
  });

  it('restore: no/wrong/good PIN; good → the skill is back as pending (re-linted, re-reviewed by the other family), listed in pending[] with the harm reason', async () => {
    const h = home();
    await liveSkill(h);
    const r = await h.retirer.retire(NAME, { kind: 'score', reason: 'its runs kept getting corrected', harm: true, by: 'reviewer', reviewerFamily: 'openai' });
    expect(r.ok).toBe(true);
    const a = app({ sentinel: h.sentinel });
    expect((await request(a).post(`/skills/learned/${NAME}/restore`).set(auth).send({})).status).toBe(403);
    expect((await request(a).post(`/skills/learned/${NAME}/restore`).set(auth).send({ pin: 'nope' })).status).toBe(403);
    expect(readIf(retiredCanonical(h))).not.toBeNull();
    const ok = await request(a).post(`/skills/learned/${NAME}/restore`).set(auth).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'restore' });
    expect(ok.body.detail).toContain('retired for harm');
    expect(readIf(canonical(h))).toMatch(/instar-learned-state: "?pending"?/);
    expect(readIf(retiredCanonical(h))).toBeNull();
    expect(readIf(rendering(h, '.claude'))).toBeNull(); // pending: unrendered until the confirm tap
    const status = await request(a).get('/skills/learned').set(auth);
    expect(status.body.pending).toMatchObject([{ name: NAME, pendingReason: 'restored', reviewerFamily: 'openai', harmReason: 'its runs kept getting corrected' }]);
    expect(status.body.retired).toEqual([]);
    expect(logRows(h).find((x) => x.kind === 'restore')).toMatchObject({ name: NAME, reviewerFamily: 'openai', authorFamily: 'anthropic', harm: true });
    // The confirm tap (slice 2) then renders it.
    const confirm = await request(a).post(`/skills/learned/pending/${NAME}/confirm`).set(auth).send({ pin: PIN });
    expect(confirm.status).toBe(200);
    expect(readIf(rendering(h, '.claude'))).toMatch(/^x-instar-stamp:/m);
    expect((await request(a).post('/skills/learned/never-retired/restore').set(auth).send({ pin: PIN })).status).toBe(404);
  });

  it('retire-all: no/wrong/good PIN; good → every live skill retired, the audit row carries { actor, reArmReviewAt }, GET shows the hold; pending skills are left alone', async () => {
    const h = home();
    await liveSkill(h);
    await liveSkill(h, 'release-notes');
    await h.protocol.write('create', 'still-pending', canonicalDoc('pending', 'still-pending'), { expectedPrevHash: null });
    const a = app({ sentinel: h.sentinel });
    expect((await request(a).post('/skills/learned/retire-all').set(auth).send({})).status).toBe(403);
    expect((await request(a).post('/skills/learned/retire-all').set(auth).send({ pin: '9' })).status).toBe(403);
    const ok = await request(a).post('/skills/learned/retire-all').set(auth).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'retire-all', retired: [NAME, 'release-notes'], refused: [] });
    expect(readIf(canonical(h, 'still-pending'))).not.toBeNull();
    const row = logRows(h).find((x) => x.kind === 'retire-all');
    expect(row).toMatchObject({ actor: 'operator', reArmReviewAt: new Date(NOW + 14 * DAY).toISOString(), retired: [NAME, 'release-notes'] });
    expect(fs.existsSync(path.join(h.stateDir, 'skill-learning', 'retire-all.m1.json'))).toBe(true);
    const status = await request(a).get('/skills/learned').set(auth);
    expect(status.body.retireAll).toMatchObject({ actor: 'operator', retired: 2, reArmReviewAt: new Date(NOW + 14 * DAY).toISOString() });
    expect(status.body.retired.map((r: { name: string }) => r.name).sort()).toEqual([NAME, 'release-notes']);
  });

  it('a bad slug is 400 before the PIN or the sentinel; feature off is 503 on every tap', async () => {
    const h = home();
    const a = app({ sentinel: h.sentinel });
    for (const tap of ['lock', 'unlock', 'retire', 'restore']) {
      const r = await request(a).post(`/skills/learned/Bad_Name/${tap}`).set(auth).send({ pin: PIN });
      expect(r.status, tap).toBe(400);
      expect(r.body.error).toBe('invalid-skill-name');
    }
    const dark = app({ sentinel: h.sentinel, enabled: false });
    for (const p of [`/skills/learned/${NAME}/lock`, `/skills/learned/${NAME}/unlock`, `/skills/learned/${NAME}/retire`, `/skills/learned/${NAME}/restore`, '/skills/learned/retire-all']) {
      const r = await request(dark).post(p).set(auth).send({ pin: PIN });
      expect(r.status, p).toBe(503);
      expect(r.body.error).toBe(SKILL_LEARNING_DISABLED);
    }
    expect(logRows(h)).toEqual([]);
  });
});

describe('forwarding to the lease holder', () => {
  it('a non-holder forwards the tap, body (PIN included) unchanged, with X-Instar-Forwarded-From; the holder’s log row names the forwarding machine; the standby never pre-validated the PIN', async () => {
    const holder = home('m_holder');
    await liveSkill(holder);
    const served = await serve(app({ sentinel: holder.sentinel, meshSelfId: 'm_holder' }));
    const standby = app({ sentinel: null, meshSelfId: 'm_standby', holderUrl: served.url });
    const r = await request(standby).post(`/skills/learned/${NAME}/retire`).set(auth).send({ pin: PIN, reason: 'from the laptop' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: 'retire', handledBy: 'holder-proxy', forwardedFromMachine: 'm_standby' });
    expect(served.calls).toHaveLength(1);
    expect(served.calls[0].body).toEqual({ pin: PIN, reason: 'from the laptop' });
    expect(served.calls[0].headers[FORWARDED_FROM_HEADER]).toBe('m_standby');
    expect(readIf(retiredCanonical(holder))).not.toBeNull();
    expect(logRows(holder).find((x) => x.kind === 'retire')).toMatchObject({ actor: 'operator via m_standby' });
    // A wrong PIN is judged by the HOLDER (403 passed through), never by the standby.
    const bad = await request(standby).post(`/skills/learned/${NAME}/restore`).set(auth).send({ pin: '000000' });
    expect(bad.status).toBe(403);
    expect(bad.body.handledBy).toBe('holder-proxy');
    expect(served.calls).toHaveLength(2);
    // retire-all forwards too.
    const all = await request(standby).post('/skills/learned/retire-all').set(auth).send({ pin: PIN });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ action: 'retire-all', handledBy: 'holder-proxy' });
  });

  it('a dead holder is 503 lease-holder-unreachable (nothing written locally); a coordinator that names no holder while this machine does not hold the lease is 503 too', async () => {
    const h = home();
    await liveSkill(h);
    const dead = app({ sentinel: h.sentinel, holderUrl: 'http://127.0.0.1:9' });
    const r = await request(dead).post(`/skills/learned/${NAME}/retire`).set(auth).send({ pin: PIN });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(LEASE_HOLDER_UNREACHABLE);
    expect(readIf(canonical(h))).not.toBeNull();
    const noHolder = app({ sentinel: h.sentinel, holderUrl: null, coordinator: { holdsLease: () => false } });
    const r2 = await request(noHolder).post('/skills/learned/retire-all').set(auth).send({ pin: PIN });
    expect(r2.status).toBe(503);
    expect(r2.body.error).toBe(LEASE_HOLDER_UNREACHABLE);
    expect(readIf(canonical(h))).not.toBeNull();
    expect(logRows(h)).toEqual([]);
  });
});
