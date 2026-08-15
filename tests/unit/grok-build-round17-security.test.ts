/**
 * Unit tests — round-17 security + safety fixes on the grok-build branch.
 *
 * Every one of these pins a defect that was CONFIRMED by executing the real
 * code path, not by reading it. Each has a control asserting the neighbouring
 * case still behaves, because a deny list that denies everything is as broken
 * as one that denies nothing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isNeverServed, isNeverEditable } from '../../src/server/fileRoutes.js';
import {
  frameworkBinaryExists,
  resolveFrameworkBinaryPath,
} from '../../src/core/frameworkSessionLaunch.js';

describe('round-17: .instar/config.json is never SERVED, not merely never edited', () => {
  it('denies read/download/link for the agent config in any case', () => {
    // The write fence landed in round-13; the read half stayed open, so the
    // same Bearer token that could not write this file could GET it and read
    // `dashboardPin` and `authToken` verbatim — which reopens every PIN-gated
    // lever the fence was protecting.
    for (const p of ['.instar/config.json', '.instar/Config.json', '.INSTAR/CONFIG.JSON']) {
      expect(isNeverServed(p), `expected ${p} to be refused for READ`).toBe(true);
    }
  });

  it('serve-deny implies edit-deny (the one entry closes both halves)', () => {
    expect(isNeverEditable('.instar/config.json')).toBe(true);
  });

  it('CONTROL: neighbouring .instar paths are still served', () => {
    // If this went true the fix would be a prefix that swallowed the directory.
    expect(isNeverServed('.instar/config-notes.md')).toBe(false);
    expect(isNeverServed('.instar/jobs/schedule/x.json')).toBe(false);
  });
});

describe('round-17: frameworkBinaryExists is TRI-state, so a broken prober cannot refuse', () => {
  it('reports genuine absence as false — the only value a gate may act on', () => {
    expect(frameworkBinaryExists('/nonexistent/definitely/not/here/grok')).toBe(false);
    expect(frameworkBinaryExists(undefined)).toBe(false);
  });

  it('reports a real on-disk path as true (CONTROL for the above)', () => {
    // Without this control, a helper that returned false unconditionally would
    // satisfy the absence assertion and every gate would refuse forever.
    expect(frameworkBinaryExists(process.execPath)).toBe(true);
  });

  it("answers 'unknown' — never false — when the probe itself cannot answer", () => {
    // A bare name with no PATH to search is not evidence of absence. Refusing
    // on this would turn a diagnostic into an outage.
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      expect(frameworkBinaryExists('grok')).toBe('unknown');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('round-17: the impersonation fence covers the claude-labelled fallback', () => {
  it('a grok-primary agent never yields the grok binary for a claude-code build', () => {
    // This is the shape that would have spawned grok with `-p <prompt>` —
    // the full prompt in argv, outside every grok control.
    const resolved = resolveFrameworkBinaryPath({
      framework: 'claude-code',
      claudePath: '/Users/x/.grok/bin/grok',
      configuredFramework: 'grok-build',
    });
    expect(resolved).not.toContain('grok');
    expect(resolved).toBe('claude');
  });

  it('CONTROL: a claude-primary agent still gets its configured claude path', () => {
    expect(
      resolveFrameworkBinaryPath({
        framework: 'claude-code',
        claudePath: '/usr/local/bin/claude',
        configuredFramework: 'claude-code',
      }),
    ).toBe('/usr/local/bin/claude');
  });
});

describe('round-17: framework sets are DERIVED, not hand-maintained', () => {
  it('stopGateBreakerKey gives grok-build its own route identity', async () => {
    const { stopGateBreakerKey } = await import('../../src/core/StopGateBreakerState.js');
    const grok = stopGateBreakerKey({ defaultFramework: 'grok-build' });
    const none = stopGateBreakerKey({});
    const gemini = stopGateBreakerKey({ defaultFramework: 'gemini-cli' });
    // The set omitted grok-build, so it fell to null and collapsed onto the
    // unconfigured route's key — an agent switching its default to grok-build
    // inherited the prior route's durable breaker state.
    expect(grok).not.toBe(none);
    // CONTROL: a framework that was always in the set still differs from both,
    // so the assertion above is measuring identity, not a constant.
    expect(gemini).not.toBe(none);
    expect(gemini).not.toBe(grok);
  });

  it('CONTROL: an unknown framework string still collapses to the null identity', () => {
    // The set must still REJECT garbage — deriving it from the canonical list
    // must not turn it into an accept-anything passthrough.
    return import('../../src/core/StopGateBreakerState.js').then(({ stopGateBreakerKey }) => {
      expect(stopGateBreakerKey({ defaultFramework: 'not-a-framework' })).toBe(
        stopGateBreakerKey({}),
      );
    });
  });
});

describe('round-17: a grok-primary agent gets an instruction file', () => {
  it('grok-build and pi-cli resolve to a shadow instruction file', async () => {
    const { FRAMEWORK_SHADOW_FILES } = await import('../../src/core/IdentityRenderer.js');
    // Without an entry here a grok-primary agent installed with NO instruction
    // file at all: CLAUDE.md is gated on claude being enabled, the shadow
    // fallback had nothing to render, and the migrator early-returns when the
    // file is absent — so it could not self-heal either. The §10 awareness note
    // reached every agent EXCEPT the ones this spec exists to create.
    expect(FRAMEWORK_SHADOW_FILES['grok-build']).toBeTruthy();
    expect(FRAMEWORK_SHADOW_FILES['pi-cli']).toBeTruthy();
  });

  it('CONTROL: the pre-existing three are unchanged', () => {
    // Adding entries must not perturb the frameworks that already worked.
    return import('../../src/core/IdentityRenderer.js').then(({ FRAMEWORK_SHADOW_FILES }) => {
      expect(FRAMEWORK_SHADOW_FILES['claude-code']).toBe('CLAUDE.md');
      expect(FRAMEWORK_SHADOW_FILES['codex-cli']).toBe('AGENTS.md');
      expect(FRAMEWORK_SHADOW_FILES['gemini-cli']).toBe('GEMINI.md');
    });
  });
});

describe('round-17: the operator-only config fence covers both authority classes', () => {
  it('fences the executable-selection keys AND the interactive-session opt-in', async () => {
    const { OPERATOR_ONLY_SESSION_KEYS } = await import('../../src/server/routes.js');
    // enabledFrameworks is not API-patchable at all, so grokInteractiveSessions
    // is the ONLY gate an API caller could reach — and it sat under `sessions`,
    // which IS patchable. One Bearer PATCH durably opened tool-enabled
    // interactive grok sessions, which is the outcome the second gate exists
    // to prevent.
    expect(OPERATOR_ONLY_SESSION_KEYS).toContain('grokInteractiveSessions');
    expect(OPERATOR_ONLY_SESSION_KEYS).toContain('frameworkBinaryPaths');
    expect(OPERATOR_ONLY_SESSION_KEYS).toContain('claudePath');
  });

  it('CONTROL: the fence does not swallow ordinary session keys', () => {
    // A fence that refused every `sessions.*` key would satisfy the assertions
    // above while breaking every legitimate patch.
    return import('../../src/server/routes.js').then(({ OPERATOR_ONLY_SESSION_KEYS }) => {
      for (const ordinary of ['maxConcurrent', 'framework', 'topicFrameworks', 'defaultModel']) {
        expect(OPERATOR_ONLY_SESSION_KEYS).not.toContain(ordinary);
      }
    });
  });
});

describe('round-19: the metered-key scrub is checked by MEMBERSHIP, not by a count', () => {
  it('every tmux spawn site in src/ that scrubs any credential also scrubs the grok keys', () => {
    // ROUND-19: the round-18 version compared two GREP COUNTS in ONE FILE.
    // Two independent failures, both proven by execution:
    //   1. A total cannot answer a membership question — moving one scrub from
    //      site A to site B kept the counts at 4/4 and the test green while a
    //      Bash-capable pane inherited the metered key.
    //   2. Its denominator premise ("DATABASE_URL_PROD appears at every spawn
    //      site") was false, and it read a single hardcoded file — so a fifth
    //      site in ANOTHER file was structurally invisible to both sides.
    //
    // This walks src/ and checks each spawn argv individually. A site is only
    // in scope if it already scrubs SOMETHING, which keeps the rule to "sites
    // that have adopted the convention" rather than asserting a convention
    // nobody agreed to.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(new URL('../../src', import.meta.url).pathname);

    const offenders: string[] = [];
    let sitesChecked = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      // Each spawn site is an argv array containing 'new-session'. Slice from
      // that marker to the array's close and inspect THAT region only, so a
      // scrub in a neighbouring array cannot satisfy this one.
      // ROUND-20: match BOTH spawn syntaxes. The round-19 version keyed on the
      // single-quoted argv token only, so a site building a template string
      // (`tmux new-session …` inside a shell command) was structurally
      // invisible — and so was its `unset`-form scrub. That is the exact
      // failure class this test was written to prevent, reintroduced one
      // syntax over. Matching the bare phrase covers both forms.
      let idx = src.indexOf('new-session');
      while (idx !== -1) {
        const region = src.slice(idx, idx + 4000);
        const end = region.indexOf('];');
        const argv = end === -1 ? region : region.slice(0, end);
        if (/'-e', '[A-Z_]+='/.test(argv) || /unset [A-Z_ ]*API_KEY/.test(argv)) {
          sitesChecked++;
          if (!argv.includes("'-e', 'XAI_API_KEY='") && !/unset [A-Z_ ]*XAI_API_KEY/.test(argv)) {
            offenders.push(`${path.basename(file)} (spawn site at offset ${idx})`);
          }
        }
        idx = src.indexOf('new-session', idx + 1);
      }
    }

    // Control: a zero denominator would make the assertion below vacuous.
    expect(sitesChecked, 'no scrubbing spawn sites found — the walk is broken').toBeGreaterThan(0);
    expect(offenders, `spawn sites scrubbing credentials but NOT the grok key: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('round-20: a spawner that COMPUTES env overrides must APPLY them', () => {
  it('PipeSessionSpawner consumes launchSpec.envOverrides, not just argv', () => {
    // ROUND-20: this file called buildHeadlessLaunch and used only `.argv`.
    // The builder returns `envOverrides` carrying the composed billing
    // invariant — for grok, the metered-key blanks plus the no-API-key-auth
    // flag, whose source comment says it "must hold on every lane that can
    // spawn a grok process". `envOverrides` appeared ZERO times in the file,
    // so on this lane it held nowhere.
    //
    // Asserting the CONSUMPTION rather than the effect is deliberate and its
    // limitation is stated: this pins that the value is read, not that the
    // resulting shell is correct. A spawner that computes a safety value and
    // discards it is the specific defect; a static check can see that much.
    const src = fs.readFileSync(
      new URL('../../src/threadline/PipeSessionSpawner.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('buildHeadlessLaunch');
    const uses = (src.match(/envOverrides/g) ?? []).length;
    expect(uses, 'launchSpec.envOverrides is computed but never read').toBeGreaterThan(0);
  });

  it('CONTROL: the assertion is about THIS file, not any file mentioning the word', () => {
    // Without this, the check above would pass against a file that merely has
    // the string somewhere unrelated — and would keep passing if the spawner
    // were replaced wholesale.
    const src = fs.readFileSync(
      new URL('../../src/threadline/PipeSessionSpawner.ts', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('new-session');
    expect(src).toMatch(/unset[^\n]*XAI_API_KEY/);
  });
});
