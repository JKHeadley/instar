import { describe, expect, it } from 'vitest';
import {
  aggregateExitCode,
  extractAddedRoutePrefixes,
  findMissingCapabilityPrefixes,
} from '../../src/commands/devPreflight.js';

describe('dev preflight route heuristic', () => {
  it('flags an added route prefix missing from CapabilityIndex', () => {
    const diff = [
      'diff --git a/src/server/routes.ts b/src/server/routes.ts',
      '+router.get(\'/foo/status\', (_req, res) => res.json({ ok: true }));',
    ].join('\n');

    const warnings = findMissingCapabilityPrefixes(diff, new Set(['capabilities']));

    expect(warnings).toEqual([
      {
        prefix: 'foo',
        routes: ['router.get(\'/foo/status\', (_req, res) => res.json({ ok: true }));'],
      },
    ]);
  });

  it('does not flag an added route prefix already in CapabilityIndex', () => {
    const diff = '+app.post("/foo/create", handler);';

    expect(findMissingCapabilityPrefixes(diff, new Set(['foo']))).toEqual([]);
  });

  it('returns clean when the diff adds no route registrations', () => {
    const diff = [
      '+const path = "/foo/not-a-route";',
      '+function registerThing() { return true; }',
    ].join('\n');

    expect(extractAddedRoutePrefixes(diff).size).toBe(0);
    expect(findMissingCapabilityPrefixes(diff, new Set())).toEqual([]);
  });

  it('aggregates exit code from real failures only', () => {
    expect(aggregateExitCode({
      lintExitCode: 0,
      discoverabilityExitCode: 0,
      routeWarnings: [{ prefix: 'foo', routes: ['router.get("/foo", handler);'] }],
    })).toBe(0);
    expect(aggregateExitCode({
      lintExitCode: 1,
      discoverabilityExitCode: 0,
      routeWarnings: [],
    })).toBe(1);
    expect(aggregateExitCode({
      lintExitCode: 0,
      discoverabilityExitCode: 1,
      routeWarnings: [],
    })).toBe(1);
  });
});
