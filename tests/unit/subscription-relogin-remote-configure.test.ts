import { describe, expect, it } from 'vitest';
import { describeSubscriptionReloginConfig } from '../../src/core/SubscriptionReloginOperatorConfig.js';
import { evaluateConfigureRequest } from '../../src/core/SubscriptionReloginRemoteConfigure.js';

// spec one-tap-unattended-repair §3 — both sides of every boundary.
const block = (mode: 'approval' | 'unattended' | 'off' | 'observe', ids: string[], extra: Record<string, unknown> = {}) => ({
  enabled: mode !== 'off', mode: mode === 'observe' || mode === 'off' ? 'unattended' as const : mode,
  dryRun: mode === 'observe', unattendedPolicy: { identities: ids, minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0, ...extra }, generation: 3,
});
const cfg = (mode: 'approval' | 'unattended', ids: string[], mins = [0, 0]) => ({
  enabled: true, mode, dryRun: false,
  unattendedPolicy: { identities: ids, minimumSuccessfulRepairs: mins[0], minimumEvidenceDays: mins[1] },
});
const pool = ['a@x.io', 'b@x.io', 'c@x.io'];

function run(current: ReturnType<typeof block>, raw: unknown, opts: { remote: boolean; rev?: string; poolEmails?: string[] | null }) {
  const view = describeSubscriptionReloginConfig(current as never);
  return evaluateConfigureRequest({ current: view, rawConfig: raw, expectedRevision: opts.rev ?? view.revision, verifiedPoolEmails: opts.poolEmails === undefined ? pool : opts.poolEmails, remote: opts.remote });
}

describe('evaluateConfigureRequest', () => {
  it('remote list refresh succeeds on a machine already set to without asking', () => {
    const r = run(block('unattended', ['a@x.io']), cfg('unattended', ['a@x.io', 'b@x.io']), { remote: true });
    expect(r).toMatchObject({ ok: true, alreadyApplied: false });
  });



  it('remote "without asking" is refused where the owner chose asks-first, watch-only or off', () => {
    for (const mode of ['approval', 'observe', 'off'] as const) {
      const r = run(block(mode, ['a@x.io']), cfg('unattended', ['a@x.io']), { remote: true });
      expect(r).toMatchObject({ ok: false, error: 'owner-must-enable-here' });
    }
  });

  it('a remote tap cannot lower the waits', () => {
    const r = run(block('unattended', ['a@x.io'], { minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 }), cfg('unattended', ['a@x.io', 'b@x.io'], [0, 0]), { remote: true });
    expect(r).toMatchObject({ ok: false, error: 'invalid-config' });
  });



  it('refuses an email this machine does not hold, and an unreadable pool', () => {
    expect(run(block('unattended', ['a@x.io']), cfg('unattended', ['a@x.io', 'z@evil.io']), { remote: true }))
      .toMatchObject({ ok: false, error: 'identity-not-on-this-machine' });
    expect(run(block('unattended', ['a@x.io']), cfg('unattended', ['a@x.io', 'b@x.io']), { remote: true, poolEmails: null }))
      .toMatchObject({ ok: false, error: 'pool-unreadable' });
  });

  it('local turn-on works from off, watch-only and asks-first, and must set 0/0', () => {
    for (const mode of ['off', 'observe', 'approval'] as const) {
      expect(run(block(mode, ['a@x.io']), cfg('unattended', ['a@x.io', 'b@x.io']), { remote: false })).toMatchObject({ ok: true, alreadyApplied: false });
    }
    expect(run(block('off', []), cfg('unattended', ['a@x.io'], [10, 30]), { remote: false })).toMatchObject({ ok: false, error: 'invalid-config' });
  });

  it('this machine already without asking: a tap keeps its waits (never silently zeroed)', () => {
    const cur = block('unattended', ['a@x.io'], { minimumSuccessfulRepairs: 10, minimumEvidenceDays: 30 });
    expect(run(cur, cfg('unattended', ['a@x.io', 'b@x.io'], [10, 30]), { remote: false })).toMatchObject({ ok: true, alreadyApplied: false });
    expect(run(cur, cfg('unattended', ['a@x.io', 'b@x.io'], [0, 0]), { remote: false })).toMatchObject({ ok: false, error: 'invalid-config' });
  });

  it('switch back to asking first: only from unattended, list and waits unchanged, works after an account left the pool', () => {
    const cur = block('unattended', ['a@x.io', 'gone@x.io']);
    expect(run(cur, cfg('approval', ['a@x.io', 'gone@x.io']), { remote: true })).toMatchObject({ ok: true, alreadyApplied: false });
    expect(run(cur, cfg('approval', ['a@x.io']), { remote: true })).toMatchObject({ ok: false, error: 'invalid-config' });
    expect(run(block('approval', ['a@x.io']), cfg('approval', ['b@x.io']), { remote: true })).toMatchObject({ ok: false, error: 'not-unattended' });
  });

  it('never disables or sets watch-only', () => {
    expect(run(block('unattended', ['a@x.io']), { ...cfg('unattended', ['a@x.io']), enabled: false }, { remote: false })).toMatchObject({ ok: false, error: 'invalid-config' });
    expect(run(block('unattended', ['a@x.io']), { ...cfg('unattended', ['a@x.io']), dryRun: true }, { remote: false })).toMatchObject({ ok: false, error: 'invalid-config' });
  });

  it('compare-and-set: a stale revision is refused; an already-applied config succeeds regardless', () => {
    const cur = block('unattended', ['a@x.io']);
    expect(run(cur, cfg('unattended', ['a@x.io', 'b@x.io']), { remote: true, rev: 'sha256:old' })).toMatchObject({ ok: false, error: 'stale-config' });
    expect(run(cur, cfg('unattended', ['a@x.io']), { remote: true, rev: 'sha256:old' })).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it('A→B→A: an old revision issued against A no longer matches after the counter moved', () => {
    const a1 = block('unattended', ['a@x.io']);
    const oldRev = describeSubscriptionReloginConfig(a1 as never).revision;
    const a3 = { ...a1, generation: 5 };
    expect(run(a3, cfg('unattended', ['a@x.io', 'b@x.io']), { remote: true, rev: oldRev })).toMatchObject({ ok: false, error: 'stale-config' });
  });
});
