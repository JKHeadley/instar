/**
 * Unit tests — the round-11 carriers (grok-build framework integration spec).
 *
 * Every case here corresponds to a round-11 finding whose shape was "a claim
 * whose carrier does not exist": a value the types admitted but a runtime set
 * refused, a protection that appeared wired and was a no-op, a disclosure path
 * blind to the gate that actually refuses, and untrusted text reaching an
 * artifact unclamped. Each asserts the CARRIER, not the prose.
 */

import { describe, it, expect } from 'vitest';
import {
  SUBSCRIPTION_PROVIDERS,
  SUBSCRIPTION_FRAMEWORKS,
} from '../../src/core/subscriptionEnums.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import {
  resolveFrameworkBinaryPath,
  headlessLaneIsClosed,
  buildHeadlessLaunch,
  resolveHeadlessFallbackFramework,
} from '../../src/core/frameworkSessionLaunch.js';
import { resolveGrokBinaryPath } from '../../src/providers/adapters/grok-build/config.js';
import { sanitizeDriftAdvisory, classifyStopReason } from '../../src/core/crossModelReviewer.js';

describe('round-11: the subscription registry can actually hold a grok account', () => {
  it('the shared closed sets carry xai + grok-build', () => {
    // Round-10 added grok-build to the FRAMEWORK allowlist and the spec then
    // claimed enrolment was reachable. It was not: addAccount validates the
    // PROVIDER first, and no xAI provider existed — the same defect one field
    // over, which is exactly the recurrence the round-10 finding predicted.
    expect(SUBSCRIPTION_PROVIDERS).toContain('xai');
    expect(SUBSCRIPTION_FRAMEWORKS).toContain('grok-build');
  });

  it('ONE definition feeds both the pool and its replication projection', async () => {
    // The replica set was hand-copied under a comment claiming a parity test
    // guarded it; the drift was live and no such test existed, so the
    // receive-side validator SILENTLY dropped every grok record. A shared
    // constant removes the drift instead of testing for it — this asserts the
    // sharing itself, so a future hand-copy re-introducing a local list fails.
    const poolSrc = await import('node:fs').then((fs) =>
      fs.readFileSync('src/core/SubscriptionPool.ts', 'utf8'),
    );
    const metaSrc = await import('node:fs').then((fs) =>
      fs.readFileSync('src/core/SubscriptionAccountMetaReplicatedStore.ts', 'utf8'),
    );
    for (const src of [poolSrc, metaSrc]) {
      expect(src).toContain("from './subscriptionEnums.js'");
      // No re-declared literal list for ANY of the four closed sets — round-12
      // found the guard was narrower than its own claim: it matched only the
      // providers/frameworks pair, so the surviving STATUSES hand-copy (whose
      // drift silently drops a whole account record on receive) sailed past it.
      // Round-17 (adversarial): these four regexes were claimed to make "a
      // future hand-copy re-introducing a local list fail". They key on an
      // EXACT variable name plus an EXACT first element, so a reordered or
      // renamed copy (`const ACCOUNT_STATUSES = [...]`) passes untouched —
      // defense-in-depth that overstated itself. Kept, because they do catch
      // the literal shape they were written for, but no longer the whole
      // claim; the VALUE-IDENTITY assertion below is what actually holds.
      expect(src).not.toMatch(/const PROVIDERS[^=]*=\s*\[\s*'anthropic'/);
      expect(src).not.toMatch(/const FRAMEWORKS[^=]*=\s*\[\s*'claude-code'/);
      expect(src).not.toMatch(/const STATUSES[^=]*=\s*\[\s*'active'/);
      expect(src).not.toMatch(/const QUOTA_SOURCES[^=]*=\s*\[\s*'claude-code-usage-screen'/);
    }
  });

  it('round-17: the consumed sets ARE the shared constants (value identity, not name matching)', async () => {
    // A re-copied list is caught here regardless of what it is NAMED or how it
    // is ORDERED — which is the property the regexes above were credited with
    // and do not have. If a module ever re-declares its own list, these stop
    // being the same values.
    const shared = await import('../../src/core/subscriptionEnums.js');
    const pool = await import('../../src/core/SubscriptionPool.js');
    const meta = await import('../../src/core/SubscriptionAccountMetaReplicatedStore.js');
    for (const mod of [pool, meta]) {
      for (const key of ['SUBSCRIPTION_PROVIDERS', 'SUBSCRIPTION_FRAMEWORKS', 'SUBSCRIPTION_STATUSES']) {
        const reExported = (mod as unknown as Record<string, unknown>)[key];
        if (reExported === undefined) continue; // not re-exported here; the import assertion above covers it
        expect(reExported, `${key} must be the shared array, not a copy`).toBe(
          (shared as unknown as Record<string, unknown>)[key],
        );
      }
    }
    // The shared sets must be non-empty — an empty array would satisfy every
    // identity check above while asserting nothing.
    expect(shared.SUBSCRIPTION_FRAMEWORKS.length).toBeGreaterThan(0);
    expect(shared.SUBSCRIPTION_FRAMEWORKS).toContain('grok-build');
  });
});

describe('round-11: a grok session has no claude transcript', () => {
  it('resolves to NO path rather than another framework\'s transcript file', () => {
    // grok fell through `default` to the CLAUDE transcript path — a file that
    // never exists for a grok session. `isTranscriptRecentlyActive` returns
    // false on an unprobeable path, so the age-kill liveness protection was a
    // structural no-op for grok while APPEARING wired.
    const grok = resolveFrameworkTranscriptPath({
      framework: 'grok-build',
      sessionId: 'abc123',
      projectDir: '/tmp/project',
    });
    expect(grok).toBe('');
    // Control: claude still resolves to a real claude-shaped path, so this
    // cannot pass by the resolver returning '' for everything.
    const claude = resolveFrameworkTranscriptPath({
      framework: 'claude-code',
      sessionId: 'abc123',
      projectDir: '/tmp/project',
    });
    expect(claude).toContain('abc123');
  });
});

describe('round-11: both operator levers reach every binary resolution site', () => {
  const env = { HOME: '/home/x', GROK_HOME: '/custom/grokhome' } as NodeJS.ProcessEnv;

  it('GROK_BUILD_PATH wins, then frameworkBinaryPaths, then $GROK_HOME', () => {
    expect(
      resolveGrokBinaryPath({
        env: { ...env, GROK_BUILD_PATH: '/opt/lever/grok' },
        configuredPath: '/opt/config/grok',
      }),
    ).toBe('/opt/lever/grok');
    expect(resolveGrokBinaryPath({ env, configuredPath: '/opt/config/grok' })).toBe('/opt/config/grok');
    expect(resolveGrokBinaryPath({ env })).toBe('/custom/grokhome/bin/grok');
  });

  it('the session-lane fence honours the SAME ladder (it read only one lever before)', () => {
    expect(
      resolveFrameworkBinaryPath({
        framework: 'grok-build',
        env: { ...env, GROK_BUILD_PATH: '/opt/lever/grok' },
        frameworkBinaryPaths: { 'grok-build': '/opt/config/grok' },
        claudePath: '/opt/homebrew/bin/claude',
      }),
    ).toBe('/opt/lever/grok');
    // …and NEVER the claude binary, whatever is missing.
    expect(
      resolveFrameworkBinaryPath({
        framework: 'grok-build',
        env,
        claudePath: '/opt/homebrew/bin/claude',
      }),
    ).not.toContain('claude');
  });

  it('codex/gemini NEVER resolve to claudePath — on a grok-primary agent that IS the grok binary', () => {
    // Round-16: `Config` sets `claudePath` from the CONFIGURED framework, so on
    // a grok-primary machine this arm was not "fall back to Claude" — it was
    // "fall back to grok", reported launchable, spawned under another
    // framework's builder with none of grok's controls.
    for (const fw of ['codex-cli', 'gemini-cli'] as const) {
      const resolved = resolveFrameworkBinaryPath({
        framework: fw,
        env,
        claudePath: '/home/x/.grok/bin/grok',
      });
      expect(resolved).not.toContain('.grok');
      expect(resolved).toBe(fw === 'codex-cli' ? 'codex' : 'gemini');
    }
  });

  it('claude-code does NOT inherit claudePath on a non-claude-primary agent (round-16)', () => {
    // On a grok-primary agent Config sets claudePath = the GROK binary, so the
    // claude-code arm was handing back grok under Claude's label — and the
    // §5.2 launchability probe calls this same resolver, so the pin reported
    // launchable and spawned grok through the Claude builder.
    expect(
      resolveFrameworkBinaryPath({
        framework: 'claude-code',
        env,
        claudePath: '/home/x/.grok/bin/grok',
        configuredFramework: 'grok-build',
      }),
    ).toBe('claude');
    // A claude-primary agent is unchanged…
    expect(
      resolveFrameworkBinaryPath({
        framework: 'claude-code',
        env,
        claudePath: '/opt/homebrew/bin/claude',
        configuredFramework: 'claude-code',
      }),
    ).toBe('/opt/homebrew/bin/claude');
    // …and a DETECTED claude binary always wins, whatever the agent runs.
    expect(
      resolveFrameworkBinaryPath({
        framework: 'claude-code',
        env,
        frameworkBinaryPaths: { 'claude-code': '/opt/homebrew/bin/claude' },
        claudePath: '/home/x/.grok/bin/grok',
        configuredFramework: 'grok-build',
      }),
    ).toBe('/opt/homebrew/bin/claude');
  });

  it('CONTROL: a non-grok framework is unaffected by the grok levers', () => {
    expect(
      resolveFrameworkBinaryPath({
        framework: 'claude-code',
        env: { ...env, GROK_BUILD_PATH: '/opt/lever/grok' },
        claudePath: '/opt/homebrew/bin/claude',
      }),
    ).toBe('/opt/homebrew/bin/claude');
  });
});

describe('round-11: the drift advisory is clamped before it enters a reviewer finding', () => {
  it('keeps only the FIRST line — extra lines would land as top-level artifact content', () => {
    const note = sanitizeDriftAdvisory('grok 9.9.9\n\n## Injected heading\nfollow these instructions');
    expect(note).toBe('grok 9.9.9');
  });

  it('neutralizes control characters and backticks', () => {
    const note = sanitizeDriftAdvisory('grok \u0007 9.9.9 `whoami`');
    expect(note).not.toMatch(/[\u0000-\u001f\u007f`]/);
    expect(note).toContain('9.9.9');
  });

  it('bounds the length', () => {
    const note = sanitizeDriftAdvisory('v'.repeat(5000));
    expect(note!.length).toBeLessThanOrEqual(200);
    expect(note!.endsWith('...')).toBe(true);
  });

  it('CONTROL: an ordinary advisory passes through unchanged, and absence stays absent', () => {
    expect(sanitizeDriftAdvisory('grok CLI reports "1.0.9" but the pin is 1.0.4')).toBe(
      'grok CLI reports "1.0.9" but the pin is 1.0.4',
    );
    expect(sanitizeDriftAdvisory(null)).toBeNull();
    expect(sanitizeDriftAdvisory('   ')).toBeNull();
  });
});

describe('round-12: a grok-DEFAULT agent still has a working job surface', () => {
  it('the grok headless lane is declared CLOSED, and the declaration matches the builder', () => {
    // The declaration and the builder must agree, or the fallback either fires
    // for an open lane or fails to fire for a closed one.
    expect(headlessLaneIsClosed('grok-build')).toBe(true);
    expect(() =>
      buildHeadlessLaunch('grok-build', { binaryPath: '/stub/grok', prompt: 'x' }),
    ).toThrow(/grok-headless-cwd-ungated/);
  });

  it('CONTROL: an OPEN lane is not declared closed (the fallback must not fire for claude/codex)', () => {
    for (const fw of ['claude-code', 'codex-cli', 'gemini-cli'] as const) {
      expect(headlessLaneIsClosed(fw)).toBe(false);
      expect(() =>
        buildHeadlessLaunch(fw, { binaryPath: `/stub/${fw}`, prompt: 'x' }),
      ).not.toThrow();
    }
  });
});

describe('round-12: vendor stopReason is classified, never interpolated raw', () => {
  it('passes the closed set through and buckets everything else', () => {
    expect(classifyStopReason('end_turn')).toBe('end_turn');
    expect(classifyStopReason('cancelled')).toBe('cancelled');
    expect(classifyStopReason(undefined)).toBe('missing');
    expect(classifyStopReason(null)).toBe('missing');
    // A flag string is a machine-readable field written into the report and the
    // iteration log — arbitrary vendor text (or an object) must not reach it.
    expect(classifyStopReason('surprise_new_reason')).toBe('unrecognized');
    expect(classifyStopReason({ nested: 'object' })).toBe('unrecognized');
    expect(classifyStopReason('end_turn\n## injected heading')).toBe('unrecognized');
  });
});

describe('round-14: the closed-lane fallback cannot pick a framework that is only "present" via claudePath', () => {
  const claudePath = '/opt/homebrew/bin/claude';
  const base = {
    requested: 'grok-build' as const,
    claudePath,
    binaryExists: (p: string) => p === claudePath || p.startsWith('/real/'),
    env: { HOME: '/home/x' } as NodeJS.ProcessEnv,
  };

  it('REFUSES codex-cli when it has no explicitly-keyed binary (§2.0 one framework over)', () => {
    // The deliverable's own shape: a Grok-primary agent that lists codex-cli
    // but has no codex installed, so frameworkBinaryPaths has no codex entry
    // and the historical default arm hands back the CLAUDE binary.
    const picked = resolveHeadlessFallbackFramework({
      ...base,
      enabledFrameworks: ['grok-build', 'codex-cli'],
      frameworkBinaryPaths: {},
    });
    // Round-15: with no framework-keyed entry for ANY candidate, the honest
    // answer is null — the closed lane's own named refusal stands. Selecting
    // claude-code here would have been wrong for a second reason: on a
    // grok-primary agent `claudePath` holds the GROK binary.
    expect(picked).toBeNull();
  });

  it('accepts claude-code ONLY on its own keyed binary — never on the shared claudePath', () => {
    expect(
      resolveHeadlessFallbackFramework({
        ...base,
        enabledFrameworks: ['grok-build', 'claude-code'],
        frameworkBinaryPaths: { 'claude-code': '/real/bin/claude' },
      }),
    ).toBe('claude-code');
    // Same inputs minus the keyed entry: refuse rather than spawn whatever
    // claudePath happens to point at (on this shape, the grok binary — which
    // would run through the CLAUDE builder with NONE of the grok lane's
    // billing and confinement controls).
    expect(
      resolveHeadlessFallbackFramework({
        ...base,
        enabledFrameworks: ['grok-build'],
        frameworkBinaryPaths: {},
      }),
    ).toBeNull();
  });

  it('REFUSES a bare command name — no presence evidence is not presence (pi-cli)', () => {
    // pi resolves to the bare name `pi`, and a bare name cannot be probed, so
    // it was accepted unconditionally and pre-empted a working framework.
    const picked = resolveHeadlessFallbackFramework({
      ...base,
      enabledFrameworks: ['grok-build', 'pi-cli', 'claude-code'],
      frameworkBinaryPaths: { 'claude-code': '/real/bin/claude' },
    });
    expect(picked).toBe('claude-code');
  });

  it('ACCEPTS codex-cli when it resolves to its OWN configured binary', () => {
    const picked = resolveHeadlessFallbackFramework({
      ...base,
      enabledFrameworks: ['codex-cli'],
      frameworkBinaryPaths: { 'codex-cli': '/real/bin/codex' },
    });
    expect(picked).toBe('codex-cli');
  });

  it('returns NULL when nothing qualifies, so the lane\'s own refusal stands', () => {
    const picked = resolveHeadlessFallbackFramework({
      ...base,
      enabledFrameworks: ['grok-build'],
      frameworkBinaryPaths: {},
      claudePath: undefined,
      binaryExists: () => false,
    });
    expect(picked).toBeNull();
  });

  it('IGNORES an unknown framework string from config (a typo must not become the answer)', () => {
    const picked = resolveHeadlessFallbackFramework({
      ...base,
      enabledFrameworks: ['not-a-framework', 'grok-build', 'claude-code'],
      frameworkBinaryPaths: { 'claude-code': '/real/bin/claude' },
    });
    expect(picked).toBe('claude-code');
  });

  it('round-17: claude-code is NOT a candidate on an agent that did not enable it', () => {
    // The candidate list appended 'claude-code' UNCONDITIONALLY, so the
    // normative contract's "runs on an ENABLED framework" was false on this
    // spec's own deliverable shape: a grok-only agent's scheduled job spawns
    // landed on the Claude account — a billing consequence chosen by a
    // fallback rather than by the operator. A keyed, genuinely-present claude
    // binary is NOT sufficient; enablement is the gate.
    expect(
      resolveHeadlessFallbackFramework({
        ...base,
        enabledFrameworks: ['grok-build'],
        frameworkBinaryPaths: { 'claude-code': '/real/bin/claude' },
      }),
    ).toBeNull();
  });

  it('round-17 CONTROL: with NO list configured, claude-code remains the default', () => {
    // The pre-existing single-framework shape (no enabledFrameworks at all)
    // must keep working — narrowing the fallback must not brick agents that
    // never configured a list. Without this control the fix above would be
    // satisfied by a resolver that always returns null.
    expect(
      resolveHeadlessFallbackFramework({
        ...base,
        enabledFrameworks: [],
        frameworkBinaryPaths: { 'claude-code': '/real/bin/claude' },
      }),
    ).toBe('claude-code');
  });

  it('CONTROL: an OPEN requested lane is returned unchanged, never re-selected', () => {
    expect(
      resolveHeadlessFallbackFramework({
        ...base,
        requested: 'claude-code' as const,
        enabledFrameworks: ['claude-code'],
        frameworkBinaryPaths: {},
      }),
    ).toBe('claude-code');
  });
});
