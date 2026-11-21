// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * gemini-payg §11 Integration "The composite plan" + "caps/lower refuses an increase".
 *
 * Two machines in one process (the harness boots each the way AgentServer does): the
 * Studio (the proposed spender) and the Mama PC. The mesh is an in-memory stand-in that
 * delivers a command to the other machine's runtime with the AUTHENTICATED sender id;
 * `peerNames` lets a test make the Mama PC answer `secret-names` as a machine holding the
 * key would, or be offline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { bootMachine, seedManifest, startFakeGoogle, writeHandoffArtifacts, PIN, KEY, type Machine } from './geminiPaygGoLiveHarness.js';

const STUDIO = 'm_studio';
const MAMA = 'm_mamapc';
let google: Awaited<ReturnType<typeof startFakeGoogle>>;
let dirs: string[] = [];
let projectDir: string;
let studioState: string;
let mamaState: string;
let machines: Record<string, Machine>;
let mamaMode: 'normal' | 'holds-key' | 'offline';

beforeAll(async () => { google = await startFakeGoogle(); });
afterAll(async () => { await google.close(); });
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-plan-proj-'));
  studioState = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-plan-studio-'));
  mamaState = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-plan-mama-'));
  dirs = [projectDir, studioState, mamaState];
  seedManifest(projectDir, true);
  machines = {};
  mamaMode = 'normal';
});
afterEach(() => {
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/gemini-payg-go-live-plan.test.ts' });
});

function mesh(from: string) {
  return async (to: string, cmd: Record<string, unknown>) => {
    if (to === MAMA && mamaMode === 'offline') throw new Error('machine unreachable');
    if (to === MAMA && cmd.type === 'secret-names' && mamaMode === 'holds-key') return { names: ['authToken', 'gemini_api_key_payg'] };
    const target = machines[to];
    if (!target) throw new Error('machine unreachable');
    return target.lane.runtime.handleMesh(cmd, from);
  };
}

function boot(which: 'studio' | 'mama'): Machine {
  const m = which === 'studio'
    ? bootMachine({ self: STUDIO, name: 'Studio', stateDir: studioState, projectDir, origin: google.origin, vault: { gemini_api_key_payg: KEY }, peers: () => [MAMA] }, mesh(STUDIO))
    : bootMachine({ self: MAMA, name: 'Mama PC', stateDir: mamaState, projectDir, origin: google.origin, vault: {}, peers: () => [STUDIO] }, mesh(MAMA));
  machines[m.self] = m;
  return m;
}

/** The account lane's handoff and the agent's proposal, on the Studio. */
async function handoffAndPropose(studio: Machine, overrides: Record<string, unknown> = {}): Promise<string> {
  expect((await request(studio.app).post('/routing-spend/key-handoff/mint-start').send({})).status).toBe(200);
  await new Promise((r) => setTimeout(r, 5));
  const h = writeHandoffArtifacts(path.join(studioState, 'lane'));
  expect((await request(studio.app).post('/routing-spend/key-handoff').send(h)).status).toBe(200);
  const p = await request(studio.app).post('/routing-spend/gemini-payg/proposal').send(overrides);
  expect(p.status).toBe(200);
  return p.body.proposalHash as string;
}

describe('the composite go-live plan, two machines', () => {
  it('renders on the designated machine — including a render requested from the other server', async () => {
    const studio = boot('studio');
    const mama = boot('mama');
    const hash = await handoffAndPropose(studio);
    const local = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(local.status).toBe(200);
    expect(local.body.proposalHash).toBe(hash);
    expect(local.body.machineId).toBe(STUDIO);
    // The Mama PC has no proposal of its own: its render request is forwarded to the Studio.
    const fwd = await request(mama.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup', designatedMachineId: STUDIO });
    expect(fwd.status).toBe(200);
    expect(fwd.body.forwarded).toBe(true);
    expect(fwd.body.renderedOn).toBe(STUDIO);
    expect(fwd.body.machineId).toBe(STUDIO);
    expect(String(fwd.body.renderedText)).toContain(STUDIO);
    // …and without naming the machine it says there is no proposal here, never rendering one.
    const none = await request(mama.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('no-proposal');
  });

  it('a machine whose proposal names another machine never renders it locally: it forwards there, or refuses naming it', async () => {
    const studio = boot('studio');
    boot('mama');
    await handoffAndPropose(studio);
    // Copy the Studio's proposal onto the Mama PC's disk: it names the Studio.
    fs.mkdirSync(path.join(mamaState, 'state'), { recursive: true });
    fs.copyFileSync(path.join(studioState, 'state', 'money-proposed-setup.json'), path.join(mamaState, 'state', 'money-proposed-setup.json'));
    const r = await request(machines[MAMA].app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(r.status).toBe(200);
    expect(r.body.forwarded).toBe(true);
    expect(r.body.machineId).toBe(STUDIO);
    // The surface itself refuses, naming the machine (what the route forwards on).
    await expect(machines[MAMA].surface.renderPlanAsync('gemini-payg-setup')).rejects.toThrow(STUDIO);
  });

  it('a peer whose vault exists but cannot be read answers an error, which blocks render (never a pass by absence)', async () => {
    const studio = boot('studio');
    boot('mama');
    await handoffAndPropose(studio);
    fs.mkdirSync(path.join(mamaState, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(mamaState, 'secrets', 'config.secrets.enc'), 'not-a-vault');
    const r = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(r.status).toBe(409);
    expect((r.body.blockers as string[]).some((b) => b.startsWith('secret-names-unreadable: m_mamapc'))).toBe(true);
  });

  it('the secret-names precondition: a peer holding the key refuses render; an offline peer is cleared', async () => {
    const studio = boot('studio');
    boot('mama');
    await handoffAndPropose(studio);
    mamaMode = 'holds-key';
    const held = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(held.status).toBe(409);
    expect((held.body.blockers as string[]).some((b) => b.startsWith('key-on-peer: m_mamapc'))).toBe(true);
    mamaMode = 'offline';
    const offline = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(offline.status).toBe(200);
  });

  it('one PIN commit, then an automatic restart; the intent applies at boot → armed-pending-proof', async () => {
    let studio = boot('studio');
    boot('mama');
    const hash = await handoffAndPropose(studio);
    const plan = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    const commit = await request(studio.app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, proposalHash: hash });
    expect(commit.status).toBe(200);
    expect(commit.body.intentHash).toBe(hash);
    expect(commit.body.restart).toMatchObject({ scheduled: true });
    expect(studio.restarts).toEqual(['gemini-payg go-live — operator PIN commit']);
    expect(studio.audit.readAll().some((r) => r.type === 'restart-requested')).toBe(true);
    // The handoff is archived on commit success.
    expect(fs.existsSync(path.join(studioState, 'state', 'gemini-payg-key-handoff.json'))).toBe(false);

    studio = boot('studio'); // the restart
    await studio.surface.onBoot();
    const f = studio.capsStore!.read();
    expect(f.doorPolicy?.['gemini-api']?.releaseState).toBe('armed-pending-proof');
    expect(f.goLive['gemini-api']?.designatedMachineId).toBe(STUDIO);
    expect(f.caps.gemini_api_key_payg).toMatchObject({ monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'America/Los_Angeles' });
    expect(f.appliedIntents?.['gemini-api']?.intentHash).toBe(hash);
  });

  it('store-version drift refuses the commit; a changed proposal refuses with the new-card message', async () => {
    const studio = boot('studio');
    boot('mama');
    const hash = await handoffAndPropose(studio);
    const plan = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    new RoutingSpendCapsStore({ stateDir: studioState }).freeze('test', 'gemini_api_key_payg'); // the caps store moved
    const drift = await request(studio.app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, proposalHash: hash });
    expect(drift.status).toBe(409);
    expect(drift.body.error).toBe('version-drift');

    const plan2 = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    expect(plan2.status).toBe(200);
    await request(studio.app).post('/routing-spend/gemini-payg/proposal').send({ dailyCapUsd: 8 }); // the proposal changed
    const changed = await request(studio.app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan2.body.planId, nonce: plan2.body.nonce, proposalHash: hash });
    expect(changed.status).toBe(409);
    expect(changed.body.message).toBe('the proposal changed; a new card is needed');
    const rerender = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup', expectedProposalHash: hash });
    expect(rerender.status).toBe(409);
    expect(rerender.body.error).toBe('proposal-changed');
  });
});

describe('after go-live: reduce-only routes and the forwarded release proof', () => {
  async function liveStudio(): Promise<{ studio: Machine; mama: Machine }> {
    let studio = boot('studio');
    boot('mama');
    const hash = await handoffAndPropose(studio);
    const plan = await request(studio.app).post('/routing-spend/plan-money-layer').send({ action: 'gemini-payg-setup' });
    await request(studio.app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, proposalHash: hash });
    studio = boot('studio');
    await studio.surface.onBoot();
    const mama = machines[MAMA];
    // The Mama PC hears the holder's designation in its echo (§6).
    await mama.lane.runtime.handleMesh({ type: 'designation-echo', keyRef: 'gemini_api_key_payg', designationEpoch: 1, nonce: 'n1' }, STUDIO);
    return { studio, mama };
  }

  it('caps/lower refuses an increase and accepts a decrease (also when issued on the Mama PC)', async () => {
    const { studio, mama } = await liveStudio();
    const up = await request(studio.app).post('/routing-spend/caps/lower').send({ monthlyCapUsd: 80 });
    expect(up.status).toBe(409);
    expect(up.body.reason).toBe('raise-needs-pin');
    expect(studio.capsStore!.read().caps.gemini_api_key_payg.monthlyCapUsd).toBe(50);
    const epochBefore = studio.capsStore!.read().leaseEpoch;
    const down = await request(mama.app).post('/routing-spend/caps/lower').send({ dailyCapUsd: 5 });
    expect(down.status).toBe(200);
    expect(down.body.confirmed).toBe(true);
    const after = studio.capsStore!.read();
    expect(after.caps.gemini_api_key_payg.dailyCapUsd).toBe(5);
    expect(after.leaseEpoch).toBe(epochBefore + 1);
    // A raise forwarded from the Mama PC is refused by the holder's reduce-only mutator.
    const upRemote = await request(mama.app).post('/routing-spend/caps/lower').send({ dailyCapUsd: 9 });
    expect(upRemote.status).toBe(409);
    expect(String(upRemote.body.reason)).toMatch(/above the current/);
    const off = await request(mama.app).post('/routing-spend/callers/disable').send({ caller: 'second-opinion' });
    expect(off.status).toBe(200);
    expect(studio.capsStore!.read().doorPolicy?.['gemini-api']?.meteredCallers.callers).toEqual(['spec-review']);
  });

  it('multi-machine: a local proof is refused before spending; the forwarded proof satisfies (a)+(e) and (b) stays named', async () => {
    const { studio, mama } = await liveStudio();
    expect((await request(studio.app).post('/routing-spend/reconciliation').send({ month: '2026-11', figureUsd: 0.5 })).status).toBe(200);
    const before = google.generateCalls();
    const local = await request(studio.app).post('/routing-spend/release-proof').send({});
    expect(local.body.evaluation.blocker).toMatch(/^proof-must-be-forwarded/);
    expect(google.generateCalls()).toBe(before);
    const fwd = await request(mama.app).post('/routing-spend/release-proof').send({});
    expect(fwd.status).toBe(200);
    const checks = fwd.body.evaluation.checks as Array<{ id: string; ok: boolean }>;
    expect(checks.map((c) => c.id)).toEqual(['d-prices-verified', 'ae-proof-row', 'c-reconciliation', 'b-live-test']);
    expect(checks.find((c) => c.id === 'ae-proof-row')?.ok).toBe(true);
    expect(fwd.body.evaluation.releaseState).toBe('armed-pending-proof');
    expect(fwd.body.evaluation.blocker).toMatch(/^b-live-test/);
    expect(google.generateCalls()).toBe(before + 1);
    // A repeat returns the recorded outcome — never a second paid call.
    const again = await request(mama.app).post('/routing-spend/release-proof').send({});
    expect(again.status).toBe(200);
    expect(google.generateCalls()).toBe(before + 1);
  });
});
