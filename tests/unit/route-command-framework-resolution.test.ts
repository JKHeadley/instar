/**
 * Unit — `instar route` must not pair one framework's LABEL with another
 * framework's BINARY (grok-build spec §2.0, invariant 4).
 *
 * ROUND-22, the sixth site of the impersonation class rounds 15-17 closed at five
 * spawn paths. Two facts combine into the defect:
 *
 *   1. `Config.loadConfig` sets `sessions.claudePath` from the CONFIGURED
 *      framework's binary, as a documented back-compat carry — so on a
 *      grok-primary agent that field holds the GROK binary, not Claude's.
 *   2. `route.ts` resolved its framework as flag → env → hardcoded `'claude-code'`,
 *      never consulting the agent's own configured framework, and then passed
 *      `sessions.claudePath` as the binary whenever the label was `claude-code`.
 *
 * On a grok-primary agent, a bare `instar route "..."` therefore built a CLAUDE
 * provider around GROK's binary: Claude's argv against grok's CLI, with none of the
 * grok lane's controls (no forced GROK_DISABLE_API_KEY_AUTH, no metered-key scrub,
 * no auth preflight, no tool deny-list, no scratch cwd, no budget record).
 *
 * WHY THIS IS A SOURCE-LEVEL TEST, said plainly rather than hidden: `route()`
 * builds a provider and then drives a real LLM call, so executing it end-to-end
 * spends tokens against a pool whose billing sink this spec records as UNKNOWN.
 * These assertions pin the two source properties that jointly caused the defect.
 * A source assertion is weaker than an execution — it can only catch the shape it
 * names — so each one is written against the exact text the pre-fix file had, and
 * both were confirmed to fail against that text before the fix landed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import { resolveFrameworkAlias } from '../../src/core/frameworkFacts.js';

const rawSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/commands/route.ts'),
  'utf-8',
);

/**
 * Source with comments stripped.
 *
 * Written after this test failed on its first run — and it failed for a reason
 * worth keeping. The negative assertions below search for the PRE-FIX code, and
 * the fix's own comment QUOTES that code verbatim to explain what was wrong. So
 * the test matched the documentation of the defect and reported the defect as
 * present, on a file where it had been removed.
 *
 * That is a false POSITIVE, which is the survivable direction — but the same
 * confound runs the other way: any source-text check can be satisfied or defeated
 * by prose, so a check that reads a file must read the part of it that executes.
 * Deleting the explanation to make the regex pass would have been the wrong fix;
 * the comment is the most useful thing in that file.
 */
const routeSource = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('instar route — framework resolution never impersonates', () => {
  it('CONTROL: the comment-stripper leaves executable code and removes prose', () => {
    // Without this, a stripper bug that emptied the source would make every
    // negative assertion below pass vacuously — the exact "narrower than what it
    // certifies" shape this branch keeps finding. Both directions, cheaply.
    expect(routeSource).toContain('export async function route');
    expect(routeSource.length).toBeGreaterThan(500);
    expect(routeSource).not.toContain('SECOND DEFECT IN THE SAME FUNCTION');
  });

  it('does NOT pass sessions.claudePath as the binary for a claude-code label', () => {
    // The pre-fix line, verbatim. Its whole risk is the word `claudePath`, whose
    // meaning depends on which framework the agent runs.
    expect(routeSource).not.toMatch(
      /binaryPath:\s*framework === 'claude-code' \? config\.sessions\.claudePath/,
    );
    // And the positive: the binary comes from the canonical per-framework map,
    // which is keyed by framework and so cannot mismatch the label.
    expect(routeSource).toMatch(/binaryPath:\s*config\.sessions\.frameworkBinaryPaths\?\.\[framework\]/);
  });

  it('falls back to the AGENT\'s configured framework before the historical default', () => {
    // Pre-fix: `resolveFrameworkAlias(opt) ?? frameworkFromEnv() ?? 'claude-code'`
    // — the agent's own framework appears nowhere, so a grok-primary agent
    // resolved to claude-code.
    expect(routeSource).toMatch(/resolveFrameworkAlias\(opt\)\s*\?\?\s*configuredFramework\s*\?\?\s*'claude-code'/);
    expect(routeSource).toMatch(/resolveFramework\(options\.framework,\s*config\.sessions\.framework\)/);
  });

  it('reads the env var through the config resolver only — not a second time here', () => {
    // Two independent readers of INSTAR_FRAMEWORK is how round 21's disagreement
    // happened. `config.sessions.framework` is already the resolver's output.
    expect(routeSource).not.toMatch(/frameworkFromEnv\(\)/);
  });
});

describe('the alias table the route command resolves through', () => {
  it('accepts both spellings of every canonical framework', () => {
    // The behavioural half: whatever the source says, every framework the agent
    // can run must be nameable on the flag. Derived from the canonical list so a
    // sixth framework is covered without editing this test.
    for (const framework of SUPPORTED_FRAMEWORKS) {
      expect(resolveFrameworkAlias(framework), `full id '${framework}'`).toBe(framework);
      const shortForm = framework.split('-')[0];
      expect(resolveFrameworkAlias(shortForm), `short alias '${shortForm}'`).toBe(framework);
    }
  });

  it('CONTROL: an unrecognised flag value yields null, so the caller can fall back deliberately', () => {
    // Not 'claude-code'. A resolver that defaults internally would reintroduce the
    // silent substitution one layer down.
    expect(resolveFrameworkAlias('not-a-framework')).toBeNull();
    expect(resolveFrameworkAlias(undefined)).toBeNull();
  });
});
