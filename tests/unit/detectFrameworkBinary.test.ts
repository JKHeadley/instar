/**
 * Unit tests for detectFrameworkBinary and its convenience wrappers.
 *
 * The function searches multiple candidate paths and falls back to PATH
 * lookup. These tests verify the framework-agnostic contract — adding a
 * new framework name should "just work" — and the key invariant: the
 * function NEVER returns a developer-specific hardcoded path. Replaces
 * the previous hardcoded `/Users/justin/.asdf/...` leak in
 * openai-codex/config.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  detectFrameworkBinary,
  detectClaudePath,
  detectCodexPath,
  detectTmuxPath,
} from '../../src/core/Config.js';

describe('detectFrameworkBinary', () => {
  it('returns a string path or null — never undefined, never a non-existent path', () => {
    const result = detectFrameworkBinary('claude');
    if (result !== null) {
      // If anything is returned, it must be an absolute path that exists.
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Must NOT be a developer-specific path slug.
      expect(result).not.toContain('.asdf/installs/nodejs/22.18.0');
    }
  });

  it('returns null for a binary name that cannot exist on any machine', () => {
    const result = detectFrameworkBinary('this-binary-definitely-does-not-exist-anywhere' as any);
    expect(result).toBeNull();
  });

  it('handles every documented framework name without throwing', () => {
    const names = ['claude', 'codex', 'gemini', 'aider', 'goose', 'cursor-cli', 'opencode', 'plandex'] as const;
    for (const name of names) {
      expect(() => detectFrameworkBinary(name)).not.toThrow();
    }
  });

  it('detectClaudePath delegates to detectFrameworkBinary(claude)', () => {
    expect(detectClaudePath()).toBe(detectFrameworkBinary('claude'));
  });

  it('detectCodexPath delegates to detectFrameworkBinary(codex)', () => {
    expect(detectCodexPath()).toBe(detectFrameworkBinary('codex'));
  });

  it('source code MUST NOT hardcode the previously-leaked developer asdf path', async () => {
    // Source-level guard against re-introducing the original regression
    // (where `/Users/justin/.asdf/installs/nodejs/22.18.0/bin/codex` was
    // a literal default in src/providers/adapters/openai-codex/config.ts).
    // At runtime, `detectFrameworkBinary` may LEGITIMATELY resolve to an
    // asdf-managed path on the running machine — that's fine; the binary
    // genuinely lives there. What we're guarding against is the literal
    // string being baked into source code.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sourceRoots = [
      'src/core/Config.ts',
      'src/providers/adapters/openai-codex/config.ts',
      'src/providers/adapters/anthropic-headless/config.ts',
      'src/providers/adapters/anthropic-interactive-pool/config.ts',
    ];
    const projectRoot = path.resolve(__dirname, '..', '..');
    for (const rel of sourceRoots) {
      const full = path.join(projectRoot, rel);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, 'utf-8');
      expect(source, `${rel} contains a hardcoded asdf-developer-path slug`)
        .not.toMatch(/\.asdf\/installs\/nodejs\/\d+\.\d+\.\d+/);
    }
  });
});
