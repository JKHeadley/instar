// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * gemini-payg §4 + §8 + §11 Unit — the go-live: the setup struct and its plan text
 * (a property test over the struct), proposal binding, the key-handoff contract, the
 * render-time preconditions (key confinement, the boot check), the pending-intent apply,
 * the `gemini-payg-setup` pre-gate action, and the mint-marker import ban.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GEMINI_PAYG_FIRST_SCREEN_LINE,
  GEMINI_PAYG_RESTART_DISCLOSURE,
  GeminiPaygGoLiveFiles,
  applyPendingGeminiPaygIntent,
  buildGeminiPaygProposal,
  evaluateGeminiPaygRenderPreconditions,
  geminiPaygSetupHash,
  renderGeminiPaygPlanLines,
  renderGeminiPaygPlanText,
  validateGeminiPaygSetup,
  validateKeyHandoffBody,
  type GeminiPaygKeyHandoff,
  type GeminiPaygSetup,
  type RenderPreconditionDeps,
} from '../../src/core/geminiPaygGoLive.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { MoneyLayerEnableStore } from '../../src/core/MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog } from '../../src/core/MoneyLayerAuditLog.js';
import { MoneyLayerEnableSurface, MoneyLayerRefusal, type GeminiPaygSetupPort } from '../../src/core/MoneyLayerEnableSurface.js';
import { MONEY_LAYER_PREGATE_ACTIONS } from '../../src/core/moneyLayerEnable.js';
import { callerAdmissionRefusal } from '../../src/core/MeteredSpendGate.js';
import { WORST_CASE_FENCE_MS } from '../../src/core/meteredLaneMesh.js';

const FP = 'a'.repeat(64);
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-golive-unit-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/gemini-payg-go-live.test.ts' }); });

function handoff(over: Partial<GeminiPaygKeyHandoff> = {}): GeminiPaygKeyHandoff {
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, 'img');
  const sha = crypto.createHash('sha256').update('img').digest('hex');
  const t = path.join(dir, 'transcript.jsonl');
  if (!fs.existsSync(t)) fs.writeFileSync(t, 'nothing secret here');
  const readAt = new Date(Date.now() + 60_000).toISOString();
  return {
    noEchoTransfer: { attestedBy: 'account-lane', at: readAt, method: 'no-echo pipe', sourceMessageRef: 'msg-1' },
    oneKeyArtifact: { providerKeyId: 'keys/k1', keyFingerprint: FP, readAt, screenshotPath: shot, screenshotSha256: sha, keyCount: 1 },
    googleSpendLimit: { kind: 'hard-cap', amountUsd: 50, readAt, screenshotPath: shot, screenshotSha256: sha },
    boundTo: { designationEpoch: 1 },
    transcripts: { paths: [t], complete: true },
    ...over,
  };
}

function setup(over: Partial<GeminiPaygSetup> = {}): GeminiPaygSetup {
  return { ...buildGeminiPaygProposal({ designatedMachineId: 'm_studio', designatedMachineName: 'Studio', currentDesignationEpoch: 0, handoff: handoff(), models: ['gemini-4-neon', 'gemini-4-hydrogen'] }), ...over };
}

describe('plan text — generated from the struct, one line per field', () => {
  it('first line is the first-screen line verbatim; Justin\'s $50 is quoted with its source; proposed values are marked', () => {
    const lines = renderGeminiPaygPlanLines(setup(), { modelVerified: () => false });
    expect(lines[0]).toBe(GEMINI_PAYG_FIRST_SCREEN_LINE);
    const text = lines.join('\n');
    expect(text).toContain('Justin, 2026-11-20, topic 145625: "let\'s set a $50 cap for now" and "Yes, please create a separate $50 budget" (15:12 PST)');
    expect(text).toContain('a separate $50 for this lane in its own Google project');
    for (const v of ['$10.00 per day', '$2.50 per call', '$10.00 limit on uncertain charges']) {
      const line = lines.find((l) => l.includes(v));
      expect(line, v).toBeDefined();
      expect(line).toMatch(/^Proposed by the agent, changeable before you approve/);
    }
    expect(text).toMatch(/\$20\.00\) and \$4\.00 a day \(proposed: change it before approving if you want\)/);
    expect(text).toContain(GEMINI_PAYG_RESTART_DISCLOSURE);
    expect(text).toContain("prices unverified until checked on Google's page");
    expect(text).toContain("Justin's personal Google account is not used.");
    expect(text).toContain('cannot raise any limit or add a caller without you');
  });

  it('the Google-side limit line follows its kind (hard cap vs budget alert only)', () => {
    expect(renderGeminiPaygPlanLines(setup({ googleSpendLimitKind: 'hard-cap' }), { modelVerified: () => true }).join('\n')).toContain('a hard cap of $50.00 (Google stops there)');
    const alert = renderGeminiPaygPlanLines(setup({ googleSpendLimitKind: 'budget-alert-only' }), { modelVerified: () => true }).join('\n');
    expect(alert).toContain('Google will warn but not stop at $50.00; Instar\'s own cap is what stops spending.');
  });

  it('PROPERTY: every committed field of a random struct appears in the text', () => {
    const rnd = (lo: number, hi: number) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
    for (let i = 0; i < 200; i++) {
      const monthly = rnd(20, 200);
      const s = setup({
        designatedMachineId: `m_${crypto.randomBytes(4).toString('hex')}`,
        designatedMachineName: Math.random() < 0.5 ? null : `Box ${i}`,
        designationEpoch: 1 + Math.floor(Math.random() * 50),
        monthlyCapUsd: monthly,
        dailyCapUsd: rnd(1, monthly),
        perCallCeilingUsd: rnd(0.1, 9),
        provisionalCeilingUsd: rnd(1, 30),
        e2MonthSharePct: Math.floor(rnd(0, 100)),
        e2DayCapUsd: rnd(0.5, 20),
        e1PassesPerRound: Math.floor(rnd(0, 4)),
        keyGeneration: crypto.randomBytes(32).toString('hex'),
        providerKeyId: `keys/${crypto.randomBytes(3).toString('hex')}`,
        googleSpendLimitKind: Math.random() < 0.5 ? 'hard-cap' : 'budget-alert-only',
        googleSpendLimitUsd: rnd(1, 50),
        reconcileJobEnabled: Math.random() < 0.5,
      });
      expect(validateGeminiPaygSetup(s)).toBeNull();
      const text = renderGeminiPaygPlanText(s, { modelVerified: () => Math.random() < 0.5 }, geminiPaygSetupHash(s));
      for (const [k, v] of Object.entries(s)) {
        if (v === null) continue;
        if (typeof v === 'string') expect(text, k).toContain(v);
        else if (typeof v === 'number') expect(text, k).toContain(/Usd$/.test(k) ? `$${v.toFixed(2)}` : String(v));
        else if (Array.isArray(v)) {
          if (v.length === 0) expect(text, k).toContain('none');
          for (const x of v) expect(text, k).toContain(String(x));
        }
      }
      expect(text).toContain(s.reconcileJobEnabled ? 'turned on for this agent' : 'left off');
      expect(text).toContain('model-checking tool: off');
      expect(text).toContain('not a lane transfer');
    }
  });
});

describe('setup struct + hash', () => {
  it('the hash is canonical (key order does not matter) and changes with any field', () => {
    const s = setup();
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as unknown as GeminiPaygSetup;
    expect(geminiPaygSetupHash(reordered)).toBe(geminiPaygSetupHash(s));
    expect(geminiPaygSetupHash({ ...s, dailyCapUsd: 9 })).not.toBe(geminiPaygSetupHash(s));
  });
  it('v1 scope is enforced: no E3 components, E4 off, callers E1+E2 only, no transfer', () => {
    expect(validateGeminiPaygSetup({ ...setup(), e3Components: ['x'] })).toMatch(/E3/);
    expect(validateGeminiPaygSetup({ ...setup(), doorwayLivenessOn: true as unknown as false })).toMatch(/E4/);
    expect(validateGeminiPaygSetup({ ...setup(), callers: ['nature-routing'] as never })).toMatch(/callers/);
    expect(validateGeminiPaygSetup({ ...setup(), dailyCapUsd: 60 })).toMatch(/daily guard/);
  });
});

describe('the key handoff contract (§4)', () => {
  it('a well-formed handoff validates; each malformed part is a 400 with its reason', () => {
    expect(validateKeyHandoffBody(handoff())).toBeNull();
    expect(validateKeyHandoffBody({})).toMatch(/noEchoTransfer/);
    expect(validateKeyHandoffBody({ ...handoff(), oneKeyArtifact: { ...handoff().oneKeyArtifact, keyFingerprint: 'nope' } })).toMatch(/oneKeyArtifact/);
    expect(validateKeyHandoffBody({ ...handoff(), oneKeyArtifact: { ...handoff().oneKeyArtifact, screenshotPath: 'relative.png' } })).toMatch(/absolute/);
    expect(validateKeyHandoffBody({ ...handoff(), googleSpendLimit: { ...handoff().googleSpendLimit, kind: 'soft' as never } })).toMatch(/googleSpendLimit/);
    expect(validateKeyHandoffBody({ ...handoff(), boundTo: { designationEpoch: 0 } })).toMatch(/designationEpoch/);
    expect(validateKeyHandoffBody({ ...handoff(), transcripts: { paths: [], complete: true } })).toMatch(/transcripts/);
  });
});

describe('render preconditions — each a named blocker, never a pass by absence', () => {
  function deps(files: GeminiPaygGoLiveFiles, over: Partial<RenderPreconditionDeps> = {}): RenderPreconditionDeps {
    return {
      files,
      selfMachineId: 'm_studio',
      storedFingerprint: async () => FP,
      peerSecretNames: async () => [{ machineId: 'm_mama', outcome: 'names', names: ['authToken'] }],
      conflictingDesignation: () => null,
      scanTranscripts: async () => ({ hit: false, unreadable: [] }),
      failoverThresholdMs: () => 15 * 60_000,
      ...over,
    };
  }
  async function ready(over: Partial<RenderPreconditionDeps> = {}, h: GeminiPaygKeyHandoff = handoff()) {
    const files = new GeminiPaygGoLiveFiles(dir);
    files.recordMintStart();
    files.writeHandoff(h);
    const p = files.writeProposal(setup());
    return evaluateGeminiPaygRenderPreconditions(deps(files, over), p);
  }

  it('all met ⇒ ok', async () => {
    expect(await ready()).toEqual({ ok: true, blockers: [], awaitingKey: false });
  });
  it('no handoff ⇒ awaiting-key', async () => {
    const files = new GeminiPaygGoLiveFiles(dir);
    const r = await evaluateGeminiPaygRenderPreconditions(deps(files), files.writeProposal(setup()));
    expect(r.awaitingKey).toBe(true);
    expect(r.blockers.join()).toMatch(/no key handoff/);
  });
  it('a read that predates the SERVER-recorded mint start refuses (never the file\'s own clock)', async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const h = handoff();
    const r = await ready({}, { ...h, oneKeyArtifact: { ...h.oneKeyArtifact, readAt: old } });
    expect(r.blockers.join()).toMatch(/predates the mint start/);
  });
  it('a screenshot whose hash does not match refuses', async () => {
    const h = handoff();
    const r = await ready({}, { ...h, oneKeyArtifact: { ...h.oneKeyArtifact, screenshotSha256: 'b'.repeat(64) } });
    expect(r.blockers.join()).toMatch(/one-key screenshot/);
  });
  it('key confinement: a second key in the project refuses; no one-key artifact refuses', async () => {
    const h = handoff();
    expect((await ready({}, { ...h, oneKeyArtifact: { ...h.oneKeyArtifact, keyCount: 2 } })).blockers.join()).toMatch(/second-key-in-project/);
  });
  it('the handoff must be bound to the proposal\'s designation epoch', async () => {
    expect((await ready({}, handoff({ boundTo: { designationEpoch: 7 } }))).blockers.join()).toMatch(/bound to designation 7/);
  });
  it('the stored key must be the attested key (fingerprint computed inside the reader)', async () => {
    expect((await ready({ storedFingerprint: async () => 'c'.repeat(64) })).blockers.join()).toMatch(/fingerprint mismatch/);
    expect((await ready({ storedFingerprint: async () => null })).blockers.join()).toMatch(/no key in this machine/);
  });
  it('transcripts: missing, partial, unreachable and a hit each refuse', async () => {
    const h = handoff();
    expect((await ready({}, { ...h, transcripts: undefined })).blockers.join()).toMatch(/transcript-set-missing/);
    expect((await ready({}, { ...h, transcripts: { paths: h.transcripts!.paths, complete: false } })).blockers.join()).toMatch(/transcript-set-partial/);
    expect((await ready({ scanTranscripts: async () => ({ hit: false, unreadable: ['/x'] }) })).blockers.join()).toMatch(/transcript-unreachable/);
    expect((await ready({ scanTranscripts: async () => ({ hit: true, unreadable: [] }) })).blockers.join()).toMatch(/key-in-transcript/);
  });
  it('secret-names: a peer holding the key refuses; an offline peer is cleared; an unreadable answer refuses; an unreadable registry refuses', async () => {
    expect((await ready({ peerSecretNames: async () => [{ machineId: 'm_mama', outcome: 'names', names: ['gemini_api_key_payg'] }] })).blockers.join()).toMatch(/key-on-peer: m_mama/);
    expect((await ready({ peerSecretNames: async () => [{ machineId: 'm_mama', outcome: 'unreachable' }] })).ok).toBe(true);
    expect((await ready({ peerSecretNames: async () => [{ machineId: 'm_mama', outcome: 'error', detail: 'peer-version' }] })).blockers.join()).toMatch(/secret-names-unreadable/);
    expect((await ready({ peerSecretNames: async () => null })).blockers.join()).toMatch(/peer-registry-unreadable/);
  });
  it('a conflicting designation refuses', async () => {
    expect((await ready({ conflictingDesignation: () => 'machine m_x announces itself' })).blockers.join()).toMatch(/conflicting-designation/);
  });
  it('BOOT CHECK: a failover threshold under 176s refuses to arm, and is re-read on every render (config change)', async () => {
    expect(2 * WORST_CASE_FENCE_MS).toBe(176_000);
    let ms = 175_000;
    const files = new GeminiPaygGoLiveFiles(dir);
    files.recordMintStart();
    files.writeHandoff(handoff());
    const p = files.writeProposal(setup());
    const d = deps(files, { failoverThresholdMs: () => ms });
    expect((await evaluateGeminiPaygRenderPreconditions(d, p)).blockers.join()).toMatch(/failover-threshold-too-short/);
    ms = 176_000;
    expect((await evaluateGeminiPaygRenderPreconditions(d, p)).ok).toBe(true);
  });
});

describe('proposal binding (§8)', () => {
  it('a proposal file whose stored hash does not match its struct is not a proposal', () => {
    const files = new GeminiPaygGoLiveFiles(dir);
    const rec = files.writeProposal(setup());
    expect(files.readProposal()?.hash).toBe(rec.hash);
    const raw = JSON.parse(fs.readFileSync(files.proposalPath, 'utf-8'));
    raw.setup.dailyCapUsd = 9;
    fs.writeFileSync(files.proposalPath, JSON.stringify(raw));
    expect(files.readProposal()).toBeNull();
  });
});

describe('pending-intent apply (§8 "Apply")', () => {
  function caps() {
    return new RoutingSpendCapsStore({ stateDir: dir });
  }
  function committedIntent(s: GeminiPaygSetup = setup()) {
    const files = new GeminiPaygGoLiveFiles(dir);
    const hash = geminiPaygSetupHash(s);
    files.writeIntent(s, hash);
    return { files, hash };
  }

  it('applies caps + GoLiveRecord + door policy (armed-pending-proof) + zone in one write, then deletes the intent', () => {
    const { files, hash } = committedIntent();
    const store = caps();
    const out = applyPendingGeminiPaygIntent({ files, capsStore: store, selfMachineId: 'm_studio', commitAuditHas: (h) => h === hash });
    expect(out).toEqual({ kind: 'applied', intentHash: hash });
    const f = store.read();
    expect(f.caps.gemini_api_key_payg).toMatchObject({ monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'America/Los_Angeles', frozen: false });
    expect(f.caps.gemini_api_key_payg.lifetimeCapUsd).toBeUndefined();
    expect(f.goLive['gemini-api']).toMatchObject({ enabled: true, keyRef: 'gemini_api_key_payg', designatedMachineId: 'm_studio' });
    expect(f.doorPolicy?.['gemini-api']).toMatchObject({ releaseState: 'armed-pending-proof', keyGeneration: FP, perCallCeilingUsd: 2.5, provisionalCeilingUsd: 10, e2MonthSharePct: 40, e2DayCapUsd: 4, designationEpoch: 1, meteredCallers: { callers: ['spec-review', 'second-opinion'], e3Components: [] } });
    expect(f.appliedIntents?.['gemini-api']?.intentHash).toBe(hash);
    expect(files.intentPresent()).toBe(false);
    expect(store.auditLog().filter((r) => r.action === 'go-live-setup-apply')).toHaveLength(1);
  });

  it('idempotent, and survives a crash between the write and the delete (hash-bound)', () => {
    const s = setup();
    const { files, hash } = committedIntent(s);
    const store = caps();
    applyPendingGeminiPaygIntent({ files, capsStore: store, selfMachineId: 'm_studio', commitAuditHas: () => true });
    // The crash: the intent is back on disk although the write landed.
    files.writeIntent(s, hash);
    const v = store.read().version;
    const again = applyPendingGeminiPaygIntent({ files, capsStore: store, selfMachineId: 'm_studio', commitAuditHas: () => true });
    expect(again).toEqual({ kind: 'already-applied', intentHash: hash });
    expect(store.read().version).toBe(v);
    expect(files.intentPresent()).toBe(false);
  });

  it('no commit row in the audit log ⇒ failed: the door is FROZEN, one notice, no throw, no crash loop', () => {
    const { files } = committedIntent();
    const store = caps();
    const notices: string[] = [];
    const out = applyPendingGeminiPaygIntent({ files, capsStore: store, selfMachineId: 'm_studio', commitAuditHas: () => false, notify: (t) => notices.push(t) });
    expect(out.kind).toBe('failed');
    expect(store.read().caps.gemini_api_key_payg.frozen).toBe(true);
    expect(store.read().doorPolicy).toBeUndefined();
    // The failed intent is archived: the next boot neither re-applies nor re-freezes it
    // (so an operator's PIN unfreeze holds), and nothing is noticed again.
    expect(files.intentPresent()).toBe(false);
    expect(fs.readdirSync(files.archiveDir).some((f) => f.includes('apply-failed'))).toBe(true);
    expect(applyPendingGeminiPaygIntent({ files, capsStore: store, selfMachineId: 'm_studio', commitAuditHas: () => false, notify: (t) => notices.push(t) })).toEqual({ kind: 'none' });
    expect(notices).toHaveLength(1);
  });

  it('a tampered intent (hash ≠ contents), a wrong machine, or a throwing store all fail closed without throwing', () => {
    const { files } = committedIntent();
    const raw = JSON.parse(fs.readFileSync(files.intentPath, 'utf-8'));
    raw.setup.monthlyCapUsd = 500;
    fs.writeFileSync(files.intentPath, JSON.stringify(raw));
    expect(applyPendingGeminiPaygIntent({ files, capsStore: caps(), selfMachineId: 'm_studio', commitAuditHas: () => true }).kind).toBe('failed');

    const other = committedIntent();
    expect(applyPendingGeminiPaygIntent({ files: other.files, capsStore: caps(), selfMachineId: 'm_mama', commitAuditHas: () => true })).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/not this one/) });

    const third = committedIntent();
    const broken = { read: () => { throw new Error('disk gone'); }, freeze: () => { throw new Error('disk gone'); } } as unknown as RoutingSpendCapsStore;
    expect(() => applyPendingGeminiPaygIntent({ files: third.files, capsStore: broken, selfMachineId: 'm_studio', commitAuditHas: () => true })).not.toThrow();
  });

  it('nothing pending ⇒ none', () => {
    expect(applyPendingGeminiPaygIntent({ files: new GeminiPaygGoLiveFiles(dir), capsStore: caps(), selfMachineId: 'm_studio', commitAuditHas: () => true })).toEqual({ kind: 'none' });
  });
});

describe('the gemini-payg-setup pre-gate action (enable surface)', () => {
  function surfaceWith(opts: { serving?: boolean; port?: Partial<GeminiPaygSetupPort> } = {}) {
    const store = new MoneyLayerEnableStore({ stateDir: dir });
    const audit = new MoneyLayerAuditLog({ stateDir: dir });
    const files = new GeminiPaygGoLiveFiles(dir);
    const s = setup();
    const rec = files.writeProposal(s);
    let hot = 0;
    const port: GeminiPaygSetupPort = {
      async prepareRender() { return { hash: files.readProposal()!.hash, text: renderGeminiPaygPlanText(s, { modelVerified: () => false }, rec.hash), capsVersion: 0, designatedMachineId: 'm_studio' }; },
      proposalHash: () => files.readProposal()?.hash ?? null,
      capsVersion: () => 0,
      writeIntent: (h) => files.writeIntent(files.readProposal()!.setup, h),
      async applyHot() { hot++; return { applied: true }; },
      archiveHandoff: () => {},
      ...opts.port,
    };
    const surface = new MoneyLayerEnableSurface({
      store, audit, machineId: 'm_studio', configEnabled: () => false, configSnapshotAt: () => null,
      componentsConstructed: () => opts.serving === true, gate: () => null, capsSnapshot: () => null,
      lockHeld: () => true, settlingCount: () => 0, geminiPayg: () => port,
    });
    if (opts.serving) (surface as unknown as { servingReady: () => boolean }).servingReady = () => true;
    return { surface, store, audit, files, rec, hotCount: () => hot };
  }

  it('is on the closed pre-gate list (five actions)', () => {
    expect([...MONEY_LAYER_PREGATE_ACTIONS]).toContain('gemini-payg-setup');
    expect([...MONEY_LAYER_PREGATE_ACTIONS]).toHaveLength(5);
  });

  it('renders only through the async path', () => {
    const { surface } = surfaceWith();
    expect(() => surface.renderPlan('gemini-payg-setup')).toThrow(MoneyLayerRefusal);
  });

  it('writes ONLY the flag + the intent while money is off (never the caps store) and asks for the restart', async () => {
    const { surface, store, files, audit, rec } = surfaceWith();
    const plan = await surface.renderPlanAsync('gemini-payg-setup');
    expect(plan.renderedText.split('\n')[0]).toBe(GEMINI_PAYG_FIRST_SCREEN_LINE);
    const out = await surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true, proposalHash: rec.hash });
    expect(out.restartRequired).toBe(true);
    expect(out.intentHash).toBe(rec.hash);
    expect(store.operatorEnabled()).toBe(true);
    expect(files.readIntent()?.hash).toBe(rec.hash);
    expect(fs.existsSync(path.join(dir, 'state', 'routing-spend-caps.json'))).toBe(false);
    // The authority row the apply checks is written first.
    expect(audit.readAll().some((r) => r.type === 'gemini-payg-setup-committed' && (r.detail as { intentHash?: string }).intentHash === rec.hash)).toBe(true);
    // The commit's restart goes through the restart safeguards (eligible state, cooldown).
    expect(() => surface.admitCommitRestart()).not.toThrow();
    expect(() => surface.admitCommitRestart()).toThrow(/cooldown/);
  });

  it('money already enforcing ⇒ the intent applies hot, no restart', async () => {
    const { surface, hotCount, rec } = surfaceWith({ serving: true });
    const plan = await surface.renderPlanAsync('gemini-payg-setup');
    const out = await surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true, proposalHash: rec.hash });
    expect(out.restartRequired).toBe(false);
    expect(out.appliedHot).toBe(true);
    expect(hotCount()).toBe(1);
  });

  it('a changed proposal (or a card carrying another hash) refuses with the new-card message', async () => {
    const { surface, files } = surfaceWith();
    const plan = await surface.renderPlanAsync('gemini-payg-setup');
    await expect(surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true, proposalHash: 'f'.repeat(64) })).rejects.toThrow('the proposal changed; a new card is needed');
    const plan2 = await surface.renderPlanAsync('gemini-payg-setup');
    files.writeProposal(setup({ dailyCapUsd: 7 }));
    await expect(surface.commit({ pin: 'x', planId: plan2.planId, nonce: plan2.nonce, pinValid: true })).rejects.toThrow('the proposal changed; a new card is needed');
  });

  it('a bad PIN commits nothing', async () => {
    const { surface, files } = surfaceWith();
    const plan = await surface.renderPlanAsync('gemini-payg-setup');
    await expect(surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: false })).rejects.toThrow(/PIN/);
    expect(files.intentPresent()).toBe(false);
  });
});

describe('the proof marker', () => {
  it('is refused as request input: a JSON look-alike is never a registered marker', () => {
    const file = { version: 1, caps: {}, goLive: { 'gemini-api': { enabled: true, keyRef: 'gemini_api_key_payg', designatedMachineId: 'm', designatedAt: '', epoch: 1 } }, leaseEpoch: 1, doorPolicy: { 'gemini-api': { ...setup(), releaseState: 'armed-pending-proof', meteredCallers: { callers: [], e3Components: [] } } } } as never;
    const r = callerAdmissionRefusal(file, { door: 'gemini-api', caller: 'release-proof', component: 'release-proof' }, JSON.parse('{"door":"gemini-api","intentHash":"x"}'));
    expect(r?.reason).toBe('not-allowlisted');
  });

  it('IMPORT BAN: only the release-proof recorder (and its defining module) use mintReleaseProofMarker', () => {
    const root = path.join(process.cwd(), 'src');
    // A USE is an import or a call; a mention in a comment is not.
    const USE = /import[^;]*\bmintReleaseProofMarker\b|\bmintReleaseProofMarker\s*\(/;
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(e.name) && USE.test(fs.readFileSync(p, 'utf-8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual([path.join('core', 'MeteredSpendGate.ts'), path.join('core', 'geminiPaygReleaseRecorder.ts')].sort());
  });
});
