import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
import { FRAMEWORK_ALIASES, resolveFrameworkAlias } from '../../src/core/frameworkFacts.js';
import { frameworkFromEnv } from '../../src/core/intelligenceProviderFactory.js';
import { KNOWN_FRAMEWORKS, isKnownFramework } from '../../src/commands/init.js';

/**
 * Round-21 found the same defect at five independent sites, after seventeen
 * review rounds had not: a hand-written framework list that fell behind the
 * canonical union. TypeScript cannot catch it (a subset of a union is a valid
 * value, and exhaustiveness checking only fires on a `switch` without a
 * `default`), and the residue is never a crash — it is a silent fallback to
 * Claude's behaviour.
 *
 * These tests are written against the CANONICAL union rather than a literal
 * list, so they keep working — and keep failing on drift — when a sixth
 * framework is added. A test that enumerated the frameworks itself would be
 * one more copy to go stale, which is the bug.
 */

describe('framework list drift', () => {
  it('the canonical union is non-trivial (guards every assertion below)', () => {
    // Without this, a bug that emptied SUPPORTED_FRAMEWORKS would make every
    // "for each framework" test below pass vacuously.
    expect(SUPPORTED_FRAMEWORKS.length).toBeGreaterThanOrEqual(5);
    expect(SUPPORTED_FRAMEWORKS).toContain('claude-code');
    expect(SUPPORTED_FRAMEWORKS).toContain('grok-build');
  });

  describe('init KNOWN_FRAMEWORKS', () => {
    it('accepts EVERY canonical framework', () => {
      // The pre-fix value listed three of five, so `isKnownFramework` rejected
      // pi-cli and grok-build. Both refresh paths filter on it and fall back to
      // ['claude-code'] on an empty result, which scaffolded Claude settings
      // into grok-only and pi-only agents on every update.
      for (const framework of SUPPORTED_FRAMEWORKS) {
        expect(isKnownFramework(framework), `isKnownFramework('${framework}')`).toBe(true);
      }
      expect([...KNOWN_FRAMEWORKS].sort()).toEqual([...SUPPORTED_FRAMEWORKS].sort());
    });

    it('CONTROL: still rejects a non-framework string', () => {
      expect(isKnownFramework('not-a-framework')).toBe(false);
      expect(isKnownFramework(undefined)).toBe(false);
    });
  });

  describe('INSTAR_FRAMEWORK alias resolution', () => {
    it('resolves the full id of every canonical framework', () => {
      for (const framework of SUPPORTED_FRAMEWORKS) {
        expect(resolveFrameworkAlias(framework), `alias('${framework}')`).toBe(framework);
      }
    });

    it('gives every framework a short alias — an asymmetry here is the drift in miniature', () => {
      for (const framework of SUPPORTED_FRAMEWORKS) {
        const shortForms = Object.entries(FRAMEWORK_ALIASES)
          .filter(([key, value]) => value === framework && key !== framework);
        expect(shortForms.length, `no short alias for '${framework}'`).toBeGreaterThanOrEqual(1);
      }
    });

    it('the provider-factory resolver AGREES with the shared table on every alias', () => {
      // This is the assertion that would have caught the original defect:
      // two resolvers for one environment variable, disagreeing on exactly
      // the two most recently added frameworks.
      for (const alias of Object.keys(FRAMEWORK_ALIASES)) {
        expect(
          frameworkFromEnv({ INSTAR_FRAMEWORK: alias }),
          `frameworkFromEnv('${alias}')`,
        ).toBe(FRAMEWORK_ALIASES[alias]);
      }
    });

    it('CONTROL: an unknown value resolves to null on both paths, not to a default', () => {
      // Falling back to claude-code here would be the same silent-substitution
      // failure in a different coat.
      expect(resolveFrameworkAlias('nonsense')).toBeNull();
      expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'nonsense' })).toBeNull();
      expect(frameworkFromEnv({})).toBeNull();
    });

    it('tolerates surrounding whitespace and case', () => {
      expect(resolveFrameworkAlias('  GROK  ')).toBe('grok-build');
    });
  });

  describe('one alias table, not three (round-22)', () => {
    /**
     * Three tables of framework spellings existed on this branch: the canonical
     * one in frameworkFacts, a hand-written copy in ProfileIntentClassifier (the
     * conversational lane), and a three-name list in the `instar route` CLI. The
     * copies were CORRECT — round-10 had already caught the classifier missing
     * `grok`, which broke "use grok here" while the literal id worked. Correct-today
     * is the state a duplicate is in immediately before it drifts, and this test
     * is what makes a re-introduced copy fail rather than wait to be noticed.
     */
    const classifierSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/ProfileIntentClassifier.ts'),
      'utf-8',
    );

    it('the conversational lane DERIVES its aliases instead of re-listing them', () => {
      // The literal shape that used to be here. A regression restores it.
      expect(classifierSource).not.toMatch(/const FRAMEWORK_ALIASES: Record<string, string> = \{\s*\n\s*codex:/);
      expect(classifierSource).toContain('CANONICAL_FRAMEWORK_ALIASES');
    });

    it('every framework short form survives the derivation', () => {
      // The derivation is `alias !== canonical`. Reproduced here against the real
      // table so a filter that silently drops a spelling fails: the property that
      // matters is that "use grok here" still resolves, not that a filter exists.
      const derived = Object.entries(FRAMEWORK_ALIASES)
        .filter(([alias, canonical]) => alias !== canonical);
      for (const framework of SUPPORTED_FRAMEWORKS) {
        const shortForm = derived.find(([, canonical]) => canonical === framework);
        expect(shortForm, `no short form survives for '${framework}'`).toBeDefined();
      }
      expect(derived.length).toBe(SUPPORTED_FRAMEWORKS.length);
    });

    it('the route CLI derives its known-framework list from the canonical one', () => {
      const routeSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/commands/route.ts'),
        'utf-8',
      );
      expect(routeSource).not.toMatch(/KNOWN_FRAMEWORKS\s*=\s*\['claude-code', 'codex-cli', 'gemini-cli'\]/);
      expect(routeSource).toContain('SUPPORTED_FRAMEWORKS');
    });
  });
});
