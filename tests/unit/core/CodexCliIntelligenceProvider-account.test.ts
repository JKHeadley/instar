/**
 * Internal Codex calls can choose WHICH account they run on.
 *
 * They never could. The child inherited the ambient `CODEX_HOME`, so every
 * internal call landed on the default login — which is why "swap a degrading
 * Codex session onto the other Codex account" had no mechanism behind it for
 * internal calls: there was only ever one account in play, and nothing recorded
 * which. The pool could hold two Codex accounts and this path would still use
 * exactly one of them.
 *
 * The load-bearing property here is NOT that selection works. It is that adding
 * the capability changes NOTHING until someone deliberately uses it: absent or
 * null resolver ⇒ ambient, byte-identical to before. That is what makes this
 * safe to land ahead of the trigger that will eventually drive it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execFileSpy = vi.fn();
const spawnSpy = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileSpy(...args),
  spawn: (...args: unknown[]) => spawnSpy(...args),
}));

import { CodexCliIntelligenceProvider } from '../../../src/core/CodexCliIntelligenceProvider.js';

/** The env handed to the child on the most recent call. */
function lastChildEnv(): Record<string, string | undefined> {
  const call = execFileSpy.mock.calls.at(-1);
  return ((call?.[2] as { env?: Record<string, string | undefined> })?.env) ?? {};
}

describe('CodexCliIntelligenceProvider — per-call account selection', () => {
  const savedExecJson = process.env.INSTAR_CODEX_EXEC_JSON;
  const savedHome = process.env.CODEX_HOME;

  beforeEach(() => {
    execFileSpy.mockReset();
    spawnSpy.mockReset();
    // Pin the plain (execFile) path so the child env is directly inspectable.
    process.env.INSTAR_CODEX_EXEC_JSON = '0';
    delete process.env.CODEX_HOME;
    execFileSpy.mockImplementation((_path, _args, _opts, cb) => {
      setImmediate(() => cb(null, 'mocked-judgment-output', ''));
      return { stdin: { end: () => {} } };
    });
  });

  afterEach(() => {
    if (savedExecJson === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
    else process.env.INSTAR_CODEX_EXEC_JSON = savedExecJson;
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  });

  it('THE SAFETY PROPERTY: no resolver ⇒ no CODEX_HOME override (ambient, unchanged)', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: '/usr/local/bin/codex' });
    await provider.evaluate('test prompt');
    expect(lastChildEnv().CODEX_HOME).toBeUndefined();
  });

  it('a resolved account becomes the child CODEX_HOME', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: 'codex-b', configHome: '/slots/codex-b' }),
    });
    await provider.evaluate('test prompt');
    expect(lastChildEnv().CODEX_HOME).toBe('/slots/codex-b');
  });

  it('TWO accounts are genuinely distinguishable — the point of the change', async () => {
    // Without this, "swap to the other codex account" has no mechanism: both
    // calls would land on the same login regardless of what was requested.
    let which = 'a';
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: `codex-${which}`, configHome: `/slots/codex-${which}` }),
    });

    await provider.evaluate('first');
    const first = lastChildEnv().CODEX_HOME;
    which = 'b';
    await provider.evaluate('second');
    const second = lastChildEnv().CODEX_HOME;

    expect(first).toBe('/slots/codex-a');
    expect(second).toBe('/slots/codex-b');
    expect(first).not.toBe(second);
  });

  it('resolved per CALL, not captured at construction — the router caches providers', async () => {
    // Same reason resolveExecJson is a closure: a value read once at construction
    // would freeze the first answer for the lifetime of a cached provider.
    let calls = 0;
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => {
        calls += 1;
        return { accountId: 'x', configHome: `/slots/call-${calls}` };
      },
    });
    await provider.evaluate('one');
    await provider.evaluate('two');
    expect(lastChildEnv().CODEX_HOME).toBe('/slots/call-2');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('a null resolution falls back to ambient', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => null,
    });
    await provider.evaluate('test prompt');
    expect(lastChildEnv().CODEX_HOME).toBeUndefined();
  });

  it('a THROWING resolver degrades to ambient and the call still succeeds', async () => {
    // Losing account selection is a small loss. Losing every internal Codex call
    // is not — so a broken resolver must never fail the call.
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => {
        throw new Error('resolver exploded');
      },
    });
    const out = await provider.evaluate('test prompt');
    expect(out).toContain('mocked-judgment-output');
    expect(lastChildEnv().CODEX_HOME).toBeUndefined();
  });

  it('a malformed resolution (empty home) falls back to ambient', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: 'x', configHome: '' }),
    });
    await provider.evaluate('test prompt');
    expect(lastChildEnv().CODEX_HOME).toBeUndefined();
  });

  it('CONTROL: env scrubbing still holds when an account IS selected', async () => {
    // Selecting an account must not become a way to smuggle the parent env in.
    process.env.OPENAI_API_KEY = 'sk-PARENT-LEAK-SENTINEL';
    try {
      const provider = new CodexCliIntelligenceProvider({
        codexPath: '/usr/local/bin/codex',
        resolveAccount: () => ({ accountId: 'codex-b', configHome: '/slots/codex-b' }),
      });
      await provider.evaluate('test prompt');
      const env = lastChildEnv();
      expect(env.CODEX_HOME).toBe('/slots/codex-b');
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
  it('OBSERVATION: a successful call is reported against the account that ran it', async () => {
    const seen: Array<{ accountId: string; latencyMs: number; ok: boolean }> = [];
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: 'codex-b', configHome: '/slots/codex-b' }),
      onCallObserved: (s) => seen.push(s),
    });
    await provider.evaluate('test prompt');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.accountId).toBe('codex-b');
    expect(seen[0]!.ok).toBe(true);
    expect(seen[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('OBSERVATION: a FAILED call is reported too — a gauge that only sees successes is useless', async () => {
    // The whole purpose is spotting a degrading account. If failures went
    // unrecorded, the error rate would read 0 no matter how bad things got.
    execFileSpy.mockImplementation((_p, _a, _o, cb) => {
      setImmediate(() => cb(new Error('codex exec failed'), '', 'boom'));
      return { stdin: { end: () => {} } };
    });
    const seen: Array<{ accountId: string; ok: boolean }> = [];
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: 'codex-b', configHome: '/slots/codex-b' }),
      onCallObserved: (s) => seen.push(s),
    });

    await expect(provider.evaluate('test prompt')).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(false);
  });

  it('OBSERVATION: nothing is reported when no account was named', async () => {
    // With no account there is nothing to attribute a sample to. Attributing it
    // to "the default" would invent a measurement the trigger would then trust.
    const seen: unknown[] = [];
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      onCallObserved: (s) => seen.push(s),
    });
    await provider.evaluate('test prompt');
    expect(seen).toHaveLength(0);
  });

  it('a THROWING observer never breaks the call it measures', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
      resolveAccount: () => ({ accountId: 'codex-b', configHome: '/slots/codex-b' }),
      onCallObserved: () => {
        throw new Error('observer exploded');
      },
    });
    await expect(provider.evaluate('test prompt')).resolves.toContain('mocked-judgment-output');
  });
});
