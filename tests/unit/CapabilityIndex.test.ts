/**
 * CapabilityIndex — module-level sanity tests.
 *
 * These tests pin invariants on the source of truth itself, independently of
 * how /capabilities iterates it. The companion lint
 * tests/unit/capabilities-discoverability.test.ts pins the routes.ts ↔ index
 * relationship; this file pins index ↔ index relationships.
 */

import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_INDEX,
  INTERNAL_PREFIXES,
  buildPrefixToKeyMap,
  buildInternalPrefixSet,
} from '../../src/server/CapabilityIndex.js';

describe('CapabilityIndex — invariants on the registry itself', () => {
  it('CAPABILITY_INDEX has at least the expected core capabilities', () => {
    const keys = CAPABILITY_INDEX.map((e) => e.key);
    for (const required of [
      'telegram',
      'imessage',
      'scheduler',
      'relationships',
      'publishing',
      'privateViewer',
      'tunnel',
      'secrets',
      'topicMemory',
      'commitments',
      'semantic',
      'tokens',
      'git',
      'autonomy',
      'discovery',
    ]) {
      expect(keys, `missing capability key "${required}"`).toContain(required);
    }
  });

  it('every entry key is unique', () => {
    const keys = CAPABILITY_INDEX.map((e) => e.key);
    const uniq = new Set(keys);
    expect(uniq.size).toBe(keys.length);
  });

  it('every entry has a non-empty description', () => {
    for (const entry of CAPABILITY_INDEX) {
      expect(
        entry.description.length,
        `entry "${entry.key}" has empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it('every prefix declared by an entry is unique across the index', () => {
    const seen = new Map<string, string>();
    for (const entry of CAPABILITY_INDEX) {
      for (const prefix of entry.prefixes) {
        const normalized = prefix.startsWith('/') ? prefix.slice(1) : prefix;
        const prior = seen.get(normalized);
        expect(
          prior,
          `prefix "${normalized}" claimed by both "${prior}" and "${entry.key}"`,
        ).toBeUndefined();
        seen.set(normalized, entry.key);
      }
    }
  });

  it('INTERNAL_PREFIXES are unique', () => {
    const prefixes = INTERNAL_PREFIXES.map((e) => e.prefix);
    const uniq = new Set(prefixes);
    expect(uniq.size).toBe(prefixes.length);
  });

  it('every INTERNAL_PREFIXES entry has a reason', () => {
    for (const entry of INTERNAL_PREFIXES) {
      expect(
        entry.reason.length,
        `INTERNAL_PREFIXES entry "${entry.prefix}" has empty reason`,
      ).toBeGreaterThan(0);
    }
  });

  it('buildPrefixToKeyMap returns a map sized to the total declared prefixes', () => {
    const expected = CAPABILITY_INDEX.reduce(
      (acc, e) => acc + e.prefixes.length,
      0,
    );
    expect(buildPrefixToKeyMap().size).toBe(expected);
  });

  it('buildInternalPrefixSet returns a set of size INTERNAL_PREFIXES.length', () => {
    expect(buildInternalPrefixSet().size).toBe(INTERNAL_PREFIXES.length);
  });

  it('secrets entry surfaces the hardened-retrieval hint (regression guard)', () => {
    const secrets = CAPABILITY_INDEX.find((e) => e.key === 'secrets');
    expect(secrets, 'no secrets entry in CAPABILITY_INDEX').toBeDefined();
    // Build with a no-op SecretDrop stub — listPending returns []
    const stubSecretDrop = {
      listPending: () => [] as unknown[],
    } as unknown as Parameters<typeof secrets!.build>[0]['secretDrop'];
    const block = secrets!.build({
      ctx: {} as Parameters<typeof secrets!.build>[0]['ctx'],
      scripts: [],
      secretDrop: stubSecretDrop,
    }) as {
      enabled: boolean;
      endpoints: string[];
      retrievalHint: string;
    };
    expect(block.enabled).toBe(true);
    expect(block.endpoints.some((e) => e.startsWith('POST /secrets/request'))).toBe(true);
    expect(block.retrievalHint).toMatch(/secret-drop-retrieve\.mjs/);
    expect(block.retrievalHint).toMatch(/NEVER prints the response body/);
  });

  it('apprenticeshipProgram surfaces role-coverage and manual cycle routes', () => {
    const apprenticeship = CAPABILITY_INDEX.find((e) => e.key === 'apprenticeshipProgram');
    expect(apprenticeship, 'no apprenticeshipProgram entry in CAPABILITY_INDEX').toBeDefined();
    const block = apprenticeship!.build({
      ctx: { apprenticeshipProgram: {}, apprenticeshipCycleStore: {} } as any,
      scripts: [],
      secretDrop: { listPending: () => [] } as any,
    }) as { endpoints: string[] };
    expect(block.endpoints).toContain('GET /apprenticeship/instances/:id/role-coverage');
    expect(block.endpoints).toContain('POST /apprenticeship/cycles');
    expect(block.endpoints).toContain('GET /apprenticeship/cycles');
    expect(block.endpoints).toContain('POST /apprenticeship/cycles/:id/close');
  });
});
