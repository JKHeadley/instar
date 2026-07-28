/**
 * Framework arg-rendering completeness matrix — codex-instar audit Item 9.
 *
 * codey raised concern that subprocess spawn paths must remain compatible
 * with Codex CLI arg contracts, and asked for centralized framework-specific
 * argument rendering with a test matrix. The centralization itself was found
 * to already exist (`src/core/frameworkSessionLaunch.ts` with
 * `buildInteractiveLaunch` + `buildHeadlessLaunch` + per-framework builders),
 * and the existing `frameworkSessionLaunch.test.ts` has 38 cases exercising
 * both frameworks.
 *
 * This file adds the EXPLICIT audit-completeness invariant: every supported
 * framework MUST produce a valid launch spec for the canonical input set —
 * if a new framework is added without updating the builder, this test fails
 * loudly. It's the structural enforcement that catches Item 9's worry
 * (silent skew between frameworks) before it ships.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
} from '../../src/core/frameworkSessionLaunch.js';
import type { IntelligenceFramework } from '../../src/core/types.js';

// The canonical list of frameworks this audit-completeness matrix should
// cover. Adding a new framework to instar means adding it here so the
// matrix catches missing builders structurally. DERIVED from the runtime
// registry (SUPPORTED_FRAMEWORKS) rather than hand-listed — the hand-list
// had silently drifted (gemini-cli was missing from it), which is exactly
// the skew this matrix exists to catch. Deriving makes the coverage
// structural: a framework added to the registry is in the matrix by
// construction.
import { SUPPORTED_FRAMEWORKS } from '../../src/core/TopicFrameworksStore.js';
const ALL_SUPPORTED_FRAMEWORKS: IntelligenceFramework[] = [...SUPPORTED_FRAMEWORKS];

// Canonical inputs the matrix exercises. Per-framework binary paths
// are pretend (the builder only echoes them into argv).
const STUB_BINS: Record<string, string> = {
  'claude-code': '/opt/homebrew/bin/claude',
  'codex-cli': '/opt/homebrew/bin/codex',
  'gemini-cli': '/opt/homebrew/bin/gemini',
  'pi-cli': '/opt/homebrew/bin/pi',
};
function binaryPathFor(framework: IntelligenceFramework): string {
  const bin = STUB_BINS[framework];
  if (!bin) throw new Error(`framework-arg-rendering-matrix: no stub binary for "${framework}" — add it to STUB_BINS`);
  return bin;
}

describe('framework arg-rendering matrix (audit completeness) — codex-instar Item 9', () => {
  describe.each(ALL_SUPPORTED_FRAMEWORKS)('framework=%s', (framework) => {
    it('produces a non-empty interactive launch spec with argv starting at the binary path', () => {
      const spec = buildInteractiveLaunch(framework, {
        binaryPath: binaryPathFor(framework),
      });
      expect(spec).toBeDefined();
      expect(Array.isArray(spec.argv)).toBe(true);
      expect(spec.argv.length).toBeGreaterThan(0);
      expect(spec.argv[0]).toBe(binaryPathFor(framework));
      expect(spec.envOverrides).toBeDefined();
    });

    it('produces a non-empty headless launch spec with argv starting at the binary path', () => {
      const spec = buildHeadlessLaunch(framework, {
        binaryPath: binaryPathFor(framework),
        prompt: 'hello world',
      });
      expect(spec).toBeDefined();
      expect(Array.isArray(spec.argv)).toBe(true);
      expect(spec.argv.length).toBeGreaterThan(0);
      expect(spec.argv[0]).toBe(binaryPathFor(framework));
      expect(spec.envOverrides).toBeDefined();
    });

    it('routes the prompt string into the headless argv (no silent drop)', () => {
      const distinctivePrompt = 'codex-instar-audit-item-9-marker';
      const spec = buildHeadlessLaunch(framework, {
        binaryPath: binaryPathFor(framework),
        prompt: distinctivePrompt,
      });
      // The prompt should appear somewhere in argv. Frameworks have
      // different positions (-p for Claude, positional for Codex), so we
      // just check presence rather than position.
      expect(spec.argv.some(a => a.includes(distinctivePrompt))).toBe(true);
    });
  });

  it('refuses an unknown framework name (no silent fall-through)', () => {
    expect(() =>
      buildInteractiveLaunch('made-up-framework' as IntelligenceFramework, {
        binaryPath: '/opt/whatever',
      }),
    ).toThrow(/No interactive launch builder registered/);
    expect(() =>
      buildHeadlessLaunch('made-up-framework' as IntelligenceFramework, {
        binaryPath: '/opt/whatever',
        prompt: 'x',
      }),
    ).toThrow();
  });

  it('every supported framework must have BOTH interactive and headless builders', () => {
    // Cross-check: if a framework appears in ALL_SUPPORTED_FRAMEWORKS, it
    // must successfully build BOTH spec types. This catches the case where
    // a new framework gets one builder but not the other — the silent skew
    // codex-instar audit Item 9 worried about.
    for (const framework of ALL_SUPPORTED_FRAMEWORKS) {
      expect(() =>
        buildInteractiveLaunch(framework, { binaryPath: binaryPathFor(framework) }),
      ).not.toThrow();
      expect(() =>
        buildHeadlessLaunch(framework, {
          binaryPath: binaryPathFor(framework),
          prompt: 'x',
        }),
      ).not.toThrow();
    }
  });
});
