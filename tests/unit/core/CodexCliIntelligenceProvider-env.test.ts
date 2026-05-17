/**
 * Unit tests for CodexCliIntelligenceProvider env-scrubbing.
 *
 * Spec 12 Rule 1a — every Codex spawn site in the repo MUST route
 * through `buildCodexChildEnv()` rather than inheriting `process.env`
 * wholesale. CodexCliIntelligenceProvider was a missed callsite during
 * cycle 1.1's first audit and is covered here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process BEFORE importing the SUT so the mocked execFile is
// captured by the SUT's import binding.
const execFileSpy = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileSpy(...args),
}));

import { CodexCliIntelligenceProvider } from '../../../src/core/CodexCliIntelligenceProvider.js';

describe('CodexCliIntelligenceProvider — Rule 1a env-scrubbing', () => {
  const saved = {
    apiKey: process.env.OPENAI_API_KEY,
    orgId: process.env.OPENAI_ORG_ID,
    projectId: process.env.OPENAI_PROJECT_ID,
  };

  beforeEach(() => {
    execFileSpy.mockReset();
    // Set a sentinel in parent env to verify it's scrubbed from child env.
    process.env.OPENAI_API_KEY = 'sk-PARENT-LEAK-SENTINEL';
    process.env.OPENAI_ORG_ID = 'org-PARENT-LEAK';
    process.env.OPENAI_PROJECT_ID = 'proj-PARENT-LEAK';

    // Default mock: invoke the callback synchronously with empty stdout,
    // and return a fake child with stdin.end available.
    execFileSpy.mockImplementation((_path, _args, _opts, cb) => {
      const fakeChild = { stdin: { end: () => {} } };
      // execFile callback signature: (error, stdout, stderr)
      setImmediate(() => cb(null, 'mocked-judgment-output', ''));
      return fakeChild;
    });
  });

  afterEach(() => {
    restore('OPENAI_API_KEY', saved.apiKey);
    restore('OPENAI_ORG_ID', saved.orgId);
    restore('OPENAI_PROJECT_ID', saved.projectId);
  });

  it('passes a scrubbed env to execFile (no OPENAI_API_KEY)', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
    });
    await provider.evaluate('test prompt');

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const opts = execFileSpy.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(opts.env).toBeDefined();
    expect(opts.env!.OPENAI_API_KEY).toBeUndefined();
    expect(opts.env!.OPENAI_ORG_ID).toBeUndefined();
    expect(opts.env!.OPENAI_PROJECT_ID).toBeUndefined();
  });

  it('does NOT pass {...process.env} (regression guard)', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: '/usr/local/bin/codex',
    });
    await provider.evaluate('test prompt');

    const opts = execFileSpy.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    // process.env always has hundreds of keys. buildCodexChildEnv returns
    // ~15-20 (allowlist + boot snapshots). If the count is high, we're
    // back to the inherit-wholesale pattern.
    const keyCount = Object.keys(opts.env!).length;
    expect(keyCount).toBeLessThan(50);
  });

  it('honors the kill-switch path (env-allowlist contract)', async () => {
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    try {
      const provider = new CodexCliIntelligenceProvider({
        codexPath: '/usr/local/bin/codex',
      });
      await provider.evaluate('test prompt');
      const opts = execFileSpy.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
      // With kill-switch + parent OPENAI_API_KEY set, the helper re-admits
      // the value. This documents the kill-switch behavior; an unintended
      // regression that broke the kill-switch would surface here.
      expect(opts.env!.OPENAI_API_KEY).toBe('sk-PARENT-LEAK-SENTINEL');
    } finally {
      delete process.env.INSTAR_DISABLE_RULE1_OPENAI;
    }
  });

  it('drops CLAUDECODE / CLAUDE_SESSION_ID (allowlist semantics)', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_SESSION_ID = 'cs-test-123';
    try {
      const provider = new CodexCliIntelligenceProvider({
        codexPath: '/usr/local/bin/codex',
      });
      await provider.evaluate('test prompt');
      const opts = execFileSpy.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(opts.env!.CLAUDECODE).toBeUndefined();
      expect(opts.env!.CLAUDE_SESSION_ID).toBeUndefined();
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_SESSION_ID;
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
