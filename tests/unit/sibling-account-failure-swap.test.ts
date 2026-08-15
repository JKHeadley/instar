/**
 * The failure tail prefers the OTHER Codex account before changing door.
 *
 * The shipped tail's last door is `claude-code` — the main subscription. So a failing
 * Codex call ended up spending exactly the budget the Codex door exists to protect:
 * the cheaper provider degrades, and its failures land on the expensive one. Holding a
 * second Codex login makes a nearer position available — same door, other account —
 * and that is what these tests pin.
 *
 * Two properties carry the change:
 *  - the sibling is tried BEFORE any door change (otherwise it changes nothing), and
 *  - the original door tail still runs when the sibling also fails (otherwise the fix
 *    removed the safety net it was supposed to sit in front of).
 */

import { describe, it, expect, vi } from 'vitest';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const GATING: IntelligenceOptions = {
  attribution: { component: 'ExternalOperationGate', gating: true },
};

const A_HOME = '/slots/codex-a';
const B_HOME = '/slots/codex-b';

/** Records every call, and which account (if any) it was told to run on. */
interface Recorder {
  calls: Array<{ door: string; home: string | undefined }>;
}

/**
 * One provider standing in for the codex binary. It is the SAME provider for every
 * account — exactly as in production, where the account is the child's CODEX_HOME and
 * not a different binary. It fails unless handed `okHome`.
 */
function codexProvider(rec: Recorder, okHome: string | null): IntelligenceProvider {
  return {
    async evaluate(_p: string, opts?: IntelligenceOptions) {
      const home = opts?.accountOverride?.configHome;
      rec.calls.push({ door: 'codex-cli', home });
      if (okHome !== null && home === okHome) return `codex-ok:${opts?.accountOverride?.accountId}`;
      throw new Error(`codex failed (home=${home ?? 'ambient'})`);
    },
  };
}

function doorProvider(rec: Recorder, door: string, outcome: 'ok' | 'fail'): IntelligenceProvider {
  return {
    async evaluate(_p: string, opts?: IntelligenceOptions) {
      rec.calls.push({ door, home: opts?.accountOverride?.configHome });
      if (outcome === 'ok') return `${door}-ok`;
      throw new Error(`${door} failed`);
    },
  };
}

function build(opts: {
  rec: Recorder;
  codexOkHome?: string | null;
  siblings?: IntelligenceRouterOpts['resolveSiblingAccounts'];
  tail?: IntelligenceFramework[];
}) {
  const rec = opts.rec;
  const providers: Partial<Record<IntelligenceFramework, IntelligenceProvider>> = {
    'codex-cli': codexProvider(rec, opts.codexOkHome === undefined ? null : opts.codexOkHome),
    'pi-cli': doorProvider(rec, 'pi-cli', 'fail'),
    'claude-code': doorProvider(rec, 'claude-code', 'ok'),
  };
  return new IntelligenceRouter({
    defaultProvider: providers['claude-code']!,
    defaultFramework: 'claude-code',
    resolveConfig: () => ({
      default: 'codex-cli',
      failureSwap: opts.tail ?? ['pi-cli', 'claude-code'],
    }),
    buildProvider: (fw) => providers[fw] ?? null,
    ...(opts.siblings ? { resolveSiblingAccounts: opts.siblings } : {}),
  });
}

type IntelligenceRouterOpts = ConstructorParameters<typeof IntelligenceRouter>[0];

/** Did the tail reach the main subscription? That is the spend this change exists to avoid. */
const reachedClaude = (rec: Recorder) => rec.calls.some((c) => c.door === 'claude-code');

describe('failure tail — prefer the sibling Codex account before changing door', () => {
  it('THE POINT: a failing Codex call is served by the OTHER Codex account, and never reaches Claude', async () => {
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: () => [{ accountId: 'codex-b', configHome: B_HOME }],
    });

    await expect(router.evaluate('x', GATING)).resolves.toBe('codex-ok:codex-b');
    expect(reachedClaude(rec)).toBe(false);
  });

  it('CONTROL: with no resolver the SAME failure walks the tail to Claude', async () => {
    // Without this, the test above could be passing because Claude was never reachable
    // in the harness at all, rather than because the sibling got there first.
    const rec: Recorder = { calls: [] };
    const router = build({ rec, codexOkHome: B_HOME }); // no resolveSiblingAccounts

    await expect(router.evaluate('x', GATING)).resolves.toBe('claude-code-ok');
    expect(reachedClaude(rec)).toBe(true);
  });

  it('the sibling attempt actually RUNS on the sibling account', async () => {
    // The failure mode this rules out: the position is scheduled, the log says the call
    // moved, but the attempt inherits the ambient login — i.e. re-runs on the account
    // that just failed, while reporting a swap.
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: () => [{ accountId: 'codex-b', configHome: B_HOME }],
    });

    await router.evaluate('x', GATING);
    const codexCalls = rec.calls.filter((c) => c.door === 'codex-cli');
    expect(codexCalls[0]!.home).toBeUndefined(); // primary: ambient
    expect(codexCalls[1]!.home).toBe(B_HOME); // sibling: the other account
  });

  it('ORDER: the sibling is tried BEFORE the next door — a tail that ran second would change nothing', async () => {
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: () => [{ accountId: 'codex-b', configHome: B_HOME }],
    });

    await router.evaluate('x', GATING);
    expect(rec.calls.map((c) => c.door)).toEqual(['codex-cli', 'codex-cli']);
  });

  it('THE SAFETY NET SURVIVES: when the sibling ALSO fails, the door tail still runs', async () => {
    // The enhancement prepends a position; it must never REPLACE the fall-through. An
    // agent whose second Codex account is equally unwell must still get an answer.
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: null, // no account works
      siblings: () => [{ accountId: 'codex-b', configHome: B_HOME }],
    });

    await expect(router.evaluate('x', GATING)).resolves.toBe('claude-code-ok');
    expect(rec.calls.map((c) => c.door)).toEqual(['codex-cli', 'codex-cli', 'pi-cli', 'claude-code']);
  });

  it('a "sibling" equal to the account that just failed is NOT retried', async () => {
    // Retrying the failing login under a fresh label spends the gating deadline on an
    // attempt already known to fail.
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: null,
      siblings: () => [{ accountId: 'codex-a', configHome: A_HOME }],
    });

    await router.evaluate('x', {
      ...GATING,
      accountOverride: { accountId: 'codex-a', configHome: A_HOME },
    });

    const codexCalls = rec.calls.filter((c) => c.door === 'codex-cli');
    expect(codexCalls).toHaveLength(1); // the primary only — no self-retry
  });

  it('a THROWING resolver costs the enhancement, never the tail', async () => {
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: () => {
        throw new Error('pool exploded');
      },
    });

    await expect(router.evaluate('x', GATING)).resolves.toBe('claude-code-ok');
  });

  it('malformed entries are filtered — an empty home would silently mean "ambient"', async () => {
    // An empty configHome reaching the provider is the worst case: it looks like a
    // sibling attempt and behaves like a re-run of the failing account.
    const rec: Recorder = { calls: [] };
    const router = build({
      rec,
      codexOkHome: null,
      siblings: () =>
        [
          { accountId: 'codex-b', configHome: '' },
          { accountId: '', configHome: B_HOME },
        ] as Array<{ accountId: string; configHome: string }>,
    });

    await router.evaluate('x', GATING);
    expect(rec.calls.filter((c) => c.door === 'codex-cli')).toHaveLength(1);
  });

  it('DARK BY DEFAULT: an empty sibling list leaves the tail byte-identical', async () => {
    const rec: Recorder = { calls: [] };
    const router = build({ rec, codexOkHome: B_HOME, siblings: () => [] });

    await expect(router.evaluate('x', GATING)).resolves.toBe('claude-code-ok');
    expect(rec.calls.map((c) => c.door)).toEqual(['codex-cli', 'pi-cli', 'claude-code']);
  });

  it('no configured tail ⇒ no sibling positions — this rides the existing tail, it does not create one', async () => {
    // A call with no failure tail is not eligible for swapping at all. Prepending a
    // sibling there would invent a retry path the config never asked for.
    const rec: Recorder = { calls: [] };
    const resolver = vi.fn(() => [{ accountId: 'codex-b', configHome: B_HOME }]);
    const router = build({ rec, codexOkHome: B_HOME, siblings: resolver, tail: [] });

    await expect(router.evaluate('x', GATING)).rejects.toThrow(/codex failed/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('the resolver is told WHICH account failed, so the pool can exclude it', async () => {
    const rec: Recorder = { calls: [] };
    const seen: Array<[string, string | null]> = [];
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: (fw, failed) => {
        seen.push([fw, failed]);
        return [{ accountId: 'codex-b', configHome: B_HOME }];
      },
    });

    await router.evaluate('x', {
      ...GATING,
      accountOverride: { accountId: 'codex-a', configHome: A_HOME },
    });
    expect(seen).toEqual([['codex-cli', 'codex-a']]);
  });

  it('an AMBIENT primary reports a null failed-account — never a guessed id', async () => {
    // The router cannot see which login a child inherited. Naming one here would make
    // the pool's self-exclusion silently wrong.
    const rec: Recorder = { calls: [] };
    const seen: Array<string | null> = [];
    const router = build({
      rec,
      codexOkHome: B_HOME,
      siblings: (_fw, failed) => {
        seen.push(failed);
        return [{ accountId: 'codex-b', configHome: B_HOME }];
      },
    });

    await router.evaluate('x', GATING);
    expect(seen).toEqual([null]);
  });
});
