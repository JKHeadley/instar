import { describe, expect, it } from 'vitest';
import { validateSubscriptionReloginOperatorInput } from '../../src/core/SubscriptionReloginOperatorConfig.js';

describe('subscription re-login operator config validation', () => {
  it('normalizes and deduplicates exact identities while allowing an explicit zero-evidence rollout', () => {
    const result = validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: {
        identities: [' Echo@SageMindAI.io ', 'echo@sagemindai.io'],
        minimumSuccessfulRepairs: 0,
        minimumEvidenceDays: 0,
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        mode: 'unattended',
        dryRun: false,
        unattendedPolicy: {
          identities: ['echo@sagemindai.io'],
          minimumSuccessfulRepairs: 0,
          minimumEvidenceDays: 0,
        },
      },
    });
  });

  it('refuses live unattended authority without an exact identity', () => {
    expect(validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: { identities: [], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
    })).toEqual({ ok: false, error: 'live unattended mode requires at least one exact identity' });
    expect(validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: { identities: ['not-an-email'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
    })).toEqual({ ok: false, error: 'every unattended identity must be an exact email address' });
  });
});

describe('one-tap-unattended-repair: closed view, revision, digest, apply', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = () => import('../../src/core/SubscriptionReloginOperatorConfig.js');

  function home(block?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-cfg-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4040, ...extra, subscriptionPool: block ? { assistedRelogin: block } : {} }));
    return dir;
  }
  const live = (mode: 'approval' | 'unattended', identities: string[]) => ({
    enabled: true, mode, dryRun: false,
    unattendedPolicy: { identities, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
  });

  it('reads mode exactly as the runtime does (missing dryRun is watch-only, missing mode is approval)', async () => {
    const { describeSubscriptionReloginConfig } = await mod();
    expect(describeSubscriptionReloginConfig(undefined).mode).toBe('off');
    expect(describeSubscriptionReloginConfig({ enabled: false, mode: 'unattended', dryRun: false }).mode).toBe('off');
    expect(describeSubscriptionReloginConfig({ enabled: true, mode: 'unattended' }).mode).toBe('observe');
    expect(describeSubscriptionReloginConfig({ enabled: true, dryRun: false }).mode).toBe('approval');
    expect(describeSubscriptionReloginConfig({ enabled: true, mode: 'unattended', dryRun: false }).mode).toBe('unattended');
  });

  it('reports effective minimums (policy defaults 10/30 when missing)', async () => {
    const { describeSubscriptionReloginConfig } = await mod();
    const v = describeSubscriptionReloginConfig({ enabled: true, dryRun: false, mode: 'unattended', unattendedPolicy: { identities: ['a@x.io'] } });
    expect(v.minimumSuccessfulRepairs).toBe(10);
    expect(v.minimumEvidenceDays).toBe(30);
  });

  it('revision ignores identity order but changes with generation (A→B→A gets a new revision)', async () => {
    const { describeSubscriptionReloginConfig } = await mod();
    const a1 = describeSubscriptionReloginConfig({ ...live('approval', ['b@x.io', 'a@x.io']), generation: 1 });
    const a1r = describeSubscriptionReloginConfig({ ...live('approval', ['a@x.io', 'b@x.io']), generation: 1 });
    const a3 = describeSubscriptionReloginConfig({ ...live('approval', ['a@x.io', 'b@x.io']), generation: 3 });
    expect(a1.revision).toBe(a1r.revision);
    expect(a3.revision).not.toBe(a1.revision);
    expect(a1.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('digest binds both the exact config and the expected revision', async () => {
    const { subscriptionReloginConfigureDigest, validateSubscriptionReloginOperatorInput } = await mod();
    const c = validateSubscriptionReloginOperatorInput(live('unattended', ['B@x.io', 'a@x.io']));
    const c2 = validateSubscriptionReloginOperatorInput(live('unattended', ['a@x.io', 'b@x.io']));
    if (!c.ok || !c2.ok) throw new Error('invalid');
    expect(c.value.unattendedPolicy.identities).toEqual(['a@x.io', 'b@x.io']);
    expect(subscriptionReloginConfigureDigest(c.value, 'sha256:r1')).toBe(subscriptionReloginConfigureDigest(c2.value, 'sha256:r1'));
    expect(subscriptionReloginConfigureDigest(c.value, 'sha256:r1')).not.toBe(subscriptionReloginConfigureDigest(c.value, 'sha256:r2'));
  });

  it('apply increments generation, records provenance, preserves other fields, and writes an UNVERSIONED restart', async () => {
    const { applySubscriptionReloginOperatorConfig, validateSubscriptionReloginOperatorInput } = await mod();
    const dir = home({ ...live('approval', ['a@x.io']), tickMs: 30000, generation: 4 }, { dashboardPin: 'x' });
    fs.writeFileSync(path.join(dir, 'state', 'restart-version-count.json'), JSON.stringify({ count: 2 }));
    const req = validateSubscriptionReloginOperatorInput(live('unattended', ['a@x.io']));
    if (!req.ok) throw new Error('invalid');
    const r = applySubscriptionReloginOperatorConfig({ stateDir: dir, runtimeConfig: { version: '1.3.0' } as never, requested: req.value,
      provenance: { via: 'mandate', mandateId: 'm1', deliveredBy: 'peer-fp' }, now: new Date('2026-11-08T00:00:00Z'), pid: 1 });
    expect(r).toMatchObject({ changed: true, restartRequested: true, generation: 5 });
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(cfg.dashboardPin).toBe('x');
    expect(cfg.subscriptionPool.assistedRelogin).toMatchObject({ mode: 'unattended', tickMs: 30000, generation: 5 });
    const flag = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'restart-requested.json'), 'utf8'));
    expect(flag.targetVersion).toBeUndefined();
    expect(flag.plannedRestart).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'restart-version-count.json'))).toBe(false);
    const audit = fs.readFileSync(path.join(dir, 'logs', 'subscription-relogin-config.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ via: 'mandate', mandateId: 'm1', deliveredBy: 'peer-fp', generation: 5, mode: 'unattended' });
  });

  it('never overwrites a pending UPDATE restart request', async () => {
    const { writeSubscriptionReloginRestartRequest } = await mod();
    const dir = home(undefined);
    const now = new Date('2026-11-08T00:00:00Z');
    const pending = { targetVersion: '1.3.2000', expiresAt: new Date(now.getTime() + 600_000).toISOString() };
    fs.writeFileSync(path.join(dir, 'state', 'restart-requested.json'), JSON.stringify(pending));
    expect(writeSubscriptionReloginRestartRequest(dir, now, 1)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'restart-requested.json'), 'utf8'))).toEqual(pending);
  });

  it('an unchanged write requests no restart unless activation is pending', async () => {
    const { applySubscriptionReloginOperatorConfig, validateSubscriptionReloginOperatorInput, describeSubscriptionReloginConfig } = await mod();
    const block = { ...live('unattended', ['a@x.io']), generation: 2 };
    const dir = home(block);
    const req = validateSubscriptionReloginOperatorInput(live('unattended', ['a@x.io']));
    if (!req.ok) throw new Error('invalid');
    const bootRevision = describeSubscriptionReloginConfig(block as never).revision;
    const quiet = applySubscriptionReloginOperatorConfig({ stateDir: dir, runtimeConfig: {} as never, requested: req.value, bootRevision });
    expect(quiet).toMatchObject({ changed: false, restartRequested: false, generation: 2 });
    expect(fs.existsSync(path.join(dir, 'state', 'restart-requested.json'))).toBe(false);
    const pending = applySubscriptionReloginOperatorConfig({ stateDir: dir, runtimeConfig: {} as never, requested: req.value, bootRevision: 'sha256:older' });
    expect(pending).toMatchObject({ changed: false, restartRequested: true });
  });
});
