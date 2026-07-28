/**
 * Capabilities Discoverability — every route prefix must be discoverable.
 *
 * The CLAUDE.md template instructs agents: "Before EVER saying 'I don't have'
 * or 'this isn't available' — check what actually exists: curl /capabilities.
 * It is the source of truth about what you can do."
 *
 * That promise is only true if /capabilities actually enumerates every
 * primitive the server exposes. Without enforcement, primitives slip through:
 * Secret Drop shipped with full routes but was never added to the response
 * body. Agents that trusted /capabilities reached for unsafe workarounds.
 *
 * Structural fix (PR #N — follow-up #2 of two): both the /capabilities
 * response builders AND this lint's policy now read from a single source —
 * src/server/CapabilityIndex.ts. Each top-level route prefix in routes.ts
 * must either be claimed by a CAPABILITY_INDEX entry (surfaced to agents)
 * OR be in INTERNAL_PREFIXES (operator-only). Anything else fails this test.
 *
 * Adding a new prefix to routes.ts will fail this lint until the author
 * makes a deliberate classification in CapabilityIndex.ts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_INDEX,
  INTERNAL_PREFIXES,
  buildPrefixToKeyMap,
  buildInternalPrefixSet,
} from '../../src/server/CapabilityIndex.js';

// Primary route surface (routes.ts) plus mounted sub-routers whose top-level
// prefixes also need discoverability classification. topic-intent routes live
// in their own router file (topicIntentRoutes.ts), mounted by AgentServer.ts —
// without this the lint has a blind spot and an INTERNAL_PREFIXES entry for a
// sub-router prefix looks like a "dead allowlist entry" even though the route
// genuinely exists.
const ROUTE_SOURCE_FILES = [
  'src/server/routes.ts',
  'src/server/topicIntentRoutes.ts',
  'src/server/specReviewRoutes.ts',
  'src/server/usherRoutes.ts',
];
const routesSource = ROUTE_SOURCE_FILES
  .map((rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8'))
  .join('\n');

/**
 * INTERNAL_ALLOWLIST lives in src/server/CapabilityIndex.ts now (exported as
 * INTERNAL_PREFIXES). This reference exists for documentation only — the
 * tests below read directly from the source-of-truth helpers.
 */

/**
 * Extract all top-level path prefixes registered on `router.*('/<prefix>...')`.
 * Top-level = the first path segment after the leading slash.
 */
function extractTopLevelPrefixes(source: string): Set<string> {
  const prefixes = new Set<string>();
  const pattern = /router\.(get|post|put|delete|patch)\s*\(\s*['"]\/([a-z][a-z0-9-]*)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    prefixes.add(match[2]);
  }
  return prefixes;
}

describe('Capabilities Discoverability', () => {
  const routePrefixes = extractTopLevelPrefixes(routesSource);
  const capabilityPrefixToKey = buildPrefixToKeyMap();
  const internalPrefixes = buildInternalPrefixSet();
  const capabilityKeys = new Set(CAPABILITY_INDEX.map((e) => e.key));

  it('extracts a non-trivial set of route prefixes (sanity)', () => {
    expect(routePrefixes.size).toBeGreaterThan(30);
  });

  it('CAPABILITY_INDEX has the expected secrets entry (regression guard)', () => {
    // This is the regression that prompted the lint. Secret Drop MUST be
    // claimed by a CAPABILITY_INDEX entry, not allowlisted.
    expect(capabilityKeys).toContain('secrets');
    expect(capabilityPrefixToKey.get('secrets')).toBe('secrets');
    expect(internalPrefixes).not.toContain('secrets');
  });

  it('reports Codex continuation enablement from the same live-config source as the routes', () => {
    const entry = CAPABILITY_INDEX.find((candidate) => candidate.key === 'codexTaskContinuation');
    expect(entry).toBeDefined();
    const result = entry!.build({
      ctx: {
        config: { autonomousSessions: { codexTaskContinuation: { enabled: false } } },
        liveConfig: { get: () => ({ enabled: true }) },
      },
      scripts: [],
      secretDrop: {},
    } as never) as { enabled: boolean };
    expect(result.enabled).toBe(true);
  });

  it('no prefix is both claimed by CAPABILITY_INDEX and listed in INTERNAL_PREFIXES', () => {
    const collisions: string[] = [];
    for (const prefix of capabilityPrefixToKey.keys()) {
      if (internalPrefixes.has(prefix)) collisions.push(prefix);
    }
    expect(
      collisions,
      `Prefixes that appear in BOTH the surfaced index and the internal allowlist (must be exactly one): ${collisions.join(', ')}`,
    ).toEqual([]);
  });

  it('every CAPABILITY_INDEX prefix actually exists as a route in routes.ts', () => {
    const orphans: string[] = [];
    for (const prefix of capabilityPrefixToKey.keys()) {
      if (!routePrefixes.has(prefix)) orphans.push(prefix);
    }
    expect(
      orphans,
      `Prefixes claimed by CAPABILITY_INDEX with no matching route in routes.ts — dead entries: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('every INTERNAL_PREFIXES entry actually exists as a route in routes.ts', () => {
    const orphans: string[] = [];
    for (const { prefix } of INTERNAL_PREFIXES) {
      if (!routePrefixes.has(prefix)) orphans.push(prefix);
    }
    expect(
      orphans,
      `INTERNAL_PREFIXES entries with no matching route in routes.ts — dead allowlist entries: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  for (const prefix of [...routePrefixes].sort()) {
    it(`prefix "/${prefix}" is classified (in CAPABILITY_INDEX or INTERNAL_PREFIXES)`, () => {
      const claimedKey = capabilityPrefixToKey.get(prefix);
      const isInternal = internalPrefixes.has(prefix);
      const surfaced = !!claimedKey || isInternal;

      expect(
        surfaced,
        `Route prefix "/${prefix}" is registered in routes.ts but is NOT classified. ` +
          `Either:\n` +
          `  (a) add prefix to an entry's "prefixes" in src/server/CapabilityIndex.ts CAPABILITY_INDEX (surfaces it in /capabilities), OR\n` +
          `  (b) add { prefix: "${prefix}", reason: "..." } to INTERNAL_PREFIXES in the same file (skips discovery — agent-invisible).\n` +
          `The lint refuses to assume; the author makes the call.`,
      ).toBe(true);
    });
  }
});
