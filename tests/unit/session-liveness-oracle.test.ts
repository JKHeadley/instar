/**
 * SessionLivenessOracle — the structural fix for the 2026-05-27 mass false-purge.
 * THE hard requirement under test: a slow / busy / unreachable tmux probe is
 * `indeterminate`, NEVER `dead`. `dead` is returned only on an authoritative
 * "server reachable + exact id absent". Plus: exact-id matching (no prefix),
 * caching, retry-then-succeed, boot-cap, concurrent coalescing, config floors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SessionLivenessOracle,
  validateLivenessConfig,
  type SessionLivenessOracleDeps,
} from '../../src/core/SessionLivenessOracle.js';

/** Build an oracle with a scripted exec. Each call shifts the next behavior. */
function makeOracle(
  behaviors: Array<() => Promise<{ stdout: string; stderr: string }>>,
  cfg?: Parameters<typeof makeOracleRaw>[1],
) {
  return makeOracleRaw(behaviors, cfg);
}

function makeOracleRaw(
  behaviors: Array<() => Promise<{ stdout: string; stderr: string }>>,
  cfg?: Partial<ConstructorParameters<typeof SessionLivenessOracle>[1]>,
) {
  const exec = vi.fn(async () => {
    const next = behaviors.shift();
    if (!next) throw new Error('exec called more times than scripted');
    return next();
  });
  const deps: SessionLivenessOracleDeps = {
    tmuxPath: '/usr/bin/tmux',
    exec: exec as unknown as SessionLivenessOracleDeps['exec'],
    now: () => Date.now(),
  };
  const oracle = new SessionLivenessOracle(deps, { probeBackoffMs: 0, ...(cfg ?? {}) });
  return { oracle, exec };
}

const ok = (names: string[]) => async () => ({ stdout: names.join('\n') + '\n', stderr: '' });
const timeoutErr = () => async () => {
  const e = new Error('Command failed: timed out') as Error & { killed: boolean; signal: string };
  e.killed = true;
  e.signal = 'SIGTERM';
  throw e;
};
const noServerErr = () => async () => {
  const e = new Error('no server running on /tmp/tmux-501/default') as Error & { stderr: string };
  e.stderr = 'no server running on /tmp/tmux-501/default';
  throw e;
};
const unknownErr = () => async () => {
  throw new Error('EPIPE: broken pipe');
};

describe('SessionLivenessOracle — the incident fix (slow ≠ dead)', () => {
  it('returns INDETERMINATE (not dead) when the probe times out', async () => {
    // The 2026-05-27 bug: a 1s timeout was treated as "dead". Here even after the
    // single retry the probe keeps timing out → must be indeterminate, never dead.
    const { oracle } = makeOracle([timeoutErr(), timeoutErr()]);
    const r = await oracle.probe('echo-session-robustness');
    expect(r.liveness).toBe('indeterminate');
    expect(r.liveness).not.toBe('dead');
  });

  it('returns INDETERMINATE on an unknown/transient error', async () => {
    const { oracle } = makeOracle([unknownErr(), unknownErr()]);
    const r = await oracle.probe('foo');
    expect(r.liveness).toBe('indeterminate');
  });

  it('does NOT cache a non-authoritative (transient) result', async () => {
    // A bad tick must not freeze liveness for the whole TTL.
    const { oracle, exec } = makeOracle([timeoutErr(), timeoutErr(), ok(['foo'])]);
    expect((await oracle.probe('foo')).liveness).toBe('indeterminate'); // 2 calls (retry)
    const r2 = await oracle.probe('foo'); // must re-probe, not serve stale transient
    expect(r2.liveness).toBe('alive');
    expect(exec).toHaveBeenCalledTimes(3);
  });
});

describe('SessionLivenessOracle — authoritative classification', () => {
  it('ALIVE when the exact session name is present', async () => {
    const { oracle } = makeOracle([ok(['a', 'echo-session-robustness', 'b'])]);
    expect((await oracle.probe('echo-session-robustness')).liveness).toBe('alive');
  });

  it('DEAD when the server is reachable and the exact id is absent', async () => {
    const { oracle } = makeOracle([ok(['a', 'b'])]);
    const r = await oracle.probe('echo-session-robustness');
    expect(r.liveness).toBe('dead');
  });

  it('DEAD via authoritative "no server running" (no sessions exist)', async () => {
    const { oracle } = makeOracle([noServerErr()]);
    expect((await oracle.probe('anything')).liveness).toBe('dead');
  });

  it('exact-id match only — a prefix sibling does NOT count as alive', async () => {
    // Closes the orphan-reaper prefix-match false-positive: "foo" must be dead
    // even though "foo-bar" is live.
    const { oracle } = makeOracle([ok(['foo-bar', 'foobar', 'xfoo'])]);
    expect((await oracle.probe('foo')).liveness).toBe('dead');
  });
});

describe('SessionLivenessOracle — retry, cache, batch, coalescing', () => {
  it('retries a transient timeout then succeeds → ALIVE (never dead)', async () => {
    const { oracle, exec } = makeOracle([timeoutErr(), ok(['foo'])], { probeRetries: 1 });
    expect((await oracle.probe('foo')).liveness).toBe('alive');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('serves a fresh cached snapshot without re-probing within the TTL', async () => {
    const { oracle, exec } = makeOracle([ok(['a', 'b'])], { cacheTtlMs: 10_000 });
    await oracle.probe('a');
    await oracle.probe('b');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('probeAll resolves the whole set from ONE list-sessions call', async () => {
    const { oracle, exec } = makeOracle([ok(['a', 'c'])]);
    const m = await oracle.probeAll(['a', 'b', 'c']);
    expect(m.get('a')!.liveness).toBe('alive');
    expect(m.get('b')!.liveness).toBe('dead');
    expect(m.get('c')!.liveness).toBe('alive');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent probes into a single tmux call', async () => {
    const { oracle, exec } = makeOracle([ok(['a', 'b'])]);
    const [ra, rb] = await Promise.all([oracle.probe('a'), oracle.probe('b')]);
    expect(ra.liveness).toBe('alive');
    expect(rb.liveness).toBe('alive');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('honors the boot cap: gives up to INDETERMINATE rather than blocking', async () => {
    // Two timeouts with retries=5, but a tiny boot cap → returns indeterminate
    // after the cap without exhausting all retries.
    const { oracle } = makeOracle([timeoutErr(), timeoutErr(), timeoutErr()], {
      probeRetries: 5,
      bootCapMs: 2000,
      probeTimeoutMs: 1000,
      probeBackoffMs: 0,
    });
    const r = await oracle.probe('foo');
    expect(r.liveness).toBe('indeterminate');
  });
});

describe('validateLivenessConfig — startup floors (a 0ms timeout must be rejected)', () => {
  it('rejects a sub-floor probe timeout (the death-spiral re-creator)', () => {
    expect(validateLivenessConfig({ probeTimeoutMs: 0 }).length).toBeGreaterThan(0);
    expect(validateLivenessConfig({ probeTimeoutMs: 100 }).length).toBeGreaterThan(0);
  });
  it('rejects negative retries and sub-floor boot cap', () => {
    expect(validateLivenessConfig({ probeRetries: -1 }).length).toBeGreaterThan(0);
    expect(validateLivenessConfig({ bootCapMs: 10 }).length).toBeGreaterThan(0);
  });
  it('accepts a sane config', () => {
    expect(validateLivenessConfig({ probeTimeoutMs: 5000, probeRetries: 1, bootCapMs: 8000 })).toEqual([]);
  });
});
