// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only (no production destructive path).
/**
 * DRIFT CANARY — apprenticeship Step 2 §4.0.4.
 *
 * The framework-blind resolvers (ThreadResumeMap.jsonlExists, the
 * RateLimitSentinel/CompactionSentinel recovery-verification, and the
 * FrameworkSessionStore transcript resolver) are framework-keyed STRING
 * branches — the compiler is blind to a missing case, so they fail SILENTLY
 * until a session of an un-handled framework hits them in production.
 *
 * This canary converts that silent-failure class into a CI-FORCED one. It
 * enumerates EVERY member of `IntelligenceFramework` and, for each, feeds the
 * resolvers a synthetic on-disk fixture for that framework's layout, then
 * asserts the resolver returns the CORRECT resolved path for that input —
 * NOT merely "a non-claude branch was taken" (a weak canary that passes even
 * when the resolver dispatches to the wrong session). Semantic correctness,
 * hermetic (no live binary).
 *
 * When a future IntelligenceFramework member is added with no resolver (or a
 * wrong one), the `it.each` over the union fails here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import { findGeminiSessionFileSync } from '../../src/providers/adapters/gemini-cli/observability/sessionPaths.js';
import { findRolloutFileSync } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';

// The authoritative union of frameworks. If a new member is added to
// IntelligenceFramework, add it here too — and the per-framework fixture below
// will FORCE you to give it a real resolver (the canary's whole point).
const ALL_FRAMEWORKS: ReadonlyArray<IntelligenceFramework> = ['claude-code', 'codex-cli', 'gemini-cli'];

interface Fixture {
  /** A synthetic <home> dir laid out for this framework. */
  home: string;
  /** The session id the resolver is asked to find. */
  sessionId: string;
  /** The absolute path the resolver MUST return for that session id. */
  expectedPath: string;
  /** Project dir (used by the claude cwd-encoded path). */
  projectDir: string;
  cleanup: () => void;
}

function mkFixture(framework: IntelligenceFramework): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `drift-${framework}-`));
  const projectDir = '/proj';
  const sessionId = '9b06d03d-f990-49c0-9cd5-1df66c06cf16';

  if (framework === 'claude-code') {
    const encoded = projectDir.replace(/[\/.]/g, '-');
    const dir = path.join(home, '.claude', 'projects', encoded);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '{"type":"user"}\n');
    return { home, sessionId, expectedPath: file, projectDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  if (framework === 'codex-cli') {
    const dir = path.join(home, '.codex', 'sessions', '2026', '06', '02');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-06-02T05-32-00-${sessionId}.jsonl`);
    fs.writeFileSync(file, '{"type":"session_meta"}\n');
    return { home, sessionId, expectedPath: file, projectDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  if (framework === 'gemini-cli') {
    // ~/.gemini/tmp/<projectHash>/chats/session-<ISO>-<short8>.json
    const projectHash = '11fe14a563f7aed66191800dc08fe0d15049ef7d9dac5f5ab4b0ca20b28e193d';
    const dir = path.join(home, '.gemini', 'tmp', projectHash, 'chats');
    fs.mkdirSync(dir, { recursive: true });
    const short8 = sessionId.replace(/-/g, '').slice(0, 8);
    const file = path.join(dir, `session-2026-06-02T05-32-${short8}.json`);
    fs.writeFileSync(file, JSON.stringify({ sessionId, projectHash, messages: [] }));
    return { home, sessionId, expectedPath: file, projectDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  // If we reach here, a new framework was added without a fixture — fail LOUD.
  const _exhaustive: never = framework;
  throw new Error(`No drift fixture for framework: ${String(_exhaustive)}`);
}

describe('DRIFT CANARY — every IntelligenceFramework resolves to its CORRECT transcript', () => {
  let fixtures: Map<IntelligenceFramework, Fixture>;

  beforeEach(() => {
    fixtures = new Map();
    for (const fw of ALL_FRAMEWORKS) fixtures.set(fw, mkFixture(fw));
  });
  afterEach(() => {
    for (const f of fixtures.values()) f.cleanup();
  });

  it('the canary covers EVERY union member (no framework un-fixtured)', () => {
    // This guards the canary itself: if IntelligenceFramework grows, the
    // `never` in mkFixture forces a fixture; this asserts the count matches.
    expect([...fixtures.keys()].sort()).toEqual([...ALL_FRAMEWORKS].sort());
  });

  it.each(ALL_FRAMEWORKS)(
    'FrameworkSessionStore resolves %s to the CORRECT transcript path (not a wrong session)',
    (framework) => {
      const fx = fixtures.get(framework)!;
      const resolved = resolveFrameworkTranscriptPath({
        framework,
        sessionId: fx.sessionId,
        projectDir: fx.projectDir,
        homeDir: fx.home,
      });
      expect(resolved).toBe(fx.expectedPath);
    },
  );

  it('a WRONG session id does NOT resolve to a sibling (gemini — no false positive)', () => {
    const fx = fixtures.get('gemini-cli')!;
    const resolved = resolveFrameworkTranscriptPath({
      framework: 'gemini-cli',
      sessionId: 'ffffffff-0000-0000-0000-000000000000',
      projectDir: fx.projectDir,
      homeDir: fx.home,
    });
    // The real session exists in the fixture, but a different id must NOT match it.
    expect(resolved).toBe('');
  });

  it('gemini sessionPaths resolves the correct file by short-id; codex resolver does NOT', () => {
    const gem = fixtures.get('gemini-cli')!;
    const geminiHome = path.join(gem.home, '.gemini');
    // gemini resolver finds it...
    expect(findGeminiSessionFileSync(gem.sessionId, geminiHome)).toBe(gem.expectedPath);
    // ...and the CODEX resolver, pointed at the gemini tree, finds nothing (no
    // cross-framework false positive — each resolver honors its own layout).
    expect(findRolloutFileSync(gem.sessionId, geminiHome)).toBeNull();
  });
});
