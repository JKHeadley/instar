/**
 * Unit tests for openai-codex agenticSessionHeadless env-scrubbing.
 *
 * Spec 12 Rule 1a — the tmux spawn path must not leak OPENAI_API_KEY into
 * the Codex child process, neither via tmux's inherited env nor via the
 * tmux `-e VAR=VAL` session-env flags.
 *
 * These tests intercept `execFileSync` so we can capture (a) the env passed
 * to tmux itself and (b) the `-e` flag tuples appended to the tmux args.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process BEFORE importing the SUT so the mocked execFileSync is
// captured by the SUT's import binding.
const execFileSyncSpy = vi.fn();
const spawnSpy = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncSpy(...args),
  spawn: (...args: unknown[]) => spawnSpy(...args),
}));

// Import SUT after mocks are installed.
import { createAgenticSessionHeadless } from '../../../../../src/providers/adapters/openai-codex/transport/agenticSessionHeadless.js';
import type { OpenAiCodexConfig } from '../../../../../src/providers/adapters/openai-codex/config.js';

const baseConfig: OpenAiCodexConfig = {
  codexPath: '/usr/local/bin/codex',
  tmuxPath: '/usr/local/bin/tmux',
  defaultModel: 'gpt-5.3-codex',
  defaultSandboxMode: 'workspace-write',
  defaultWorkingDirectory: '/tmp',
  // The apiKey field is present in OpenAiCodexConfig (Phase A deprecated).
  // Setting it must NOT cause OPENAI_API_KEY to leak via the tmux spawn.
  apiKey: 'sk-MUST-NOT-LEAK',
  codexHome: '/tmp/codex-home',
};

describe('openai-codex agenticSessionHeadless — Rule 1a tmux spawn env scrub', () => {
  const saved = {
    apiKey: process.env.OPENAI_API_KEY,
    home: process.env.HOME,
  };

  beforeEach(() => {
    execFileSyncSpy.mockReset();
    spawnSpy.mockReset();
    execFileSyncSpy.mockReturnValue('');
    // Set OPENAI_API_KEY in parent env to verify it's scrubbed from tmux's
    // inherited env.
    process.env.OPENAI_API_KEY = 'sk-PARENT-ENV-LEAK';
  });

  afterEach(() => {
    if (saved.apiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.apiKey;
  });

  it('passes a scrubbed env object to execFileSync(tmuxPath, ...)', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({ prompt: 'hello' });

    // The first execFileSync call is the `tmux new-session` spawn.
    const firstCall = execFileSyncSpy.mock.calls[0];
    expect(firstCall[0]).toBe(baseConfig.tmuxPath);
    const opts = firstCall[2] as { env?: NodeJS.ProcessEnv };
    expect(opts).toBeDefined();
    expect(opts.env).toBeDefined();
    expect(opts.env!.OPENAI_API_KEY).toBeUndefined();
    expect(opts.env!.OPENAI_ORG_ID).toBeUndefined();
    expect(opts.env!.OPENAI_PROJECT_ID).toBeUndefined();
  });

  it('does NOT emit `-e OPENAI_API_KEY=...` even when config.apiKey is set', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({ prompt: 'hello' });

    const firstCall = execFileSyncSpy.mock.calls[0];
    const tmuxArgs = firstCall[1] as string[];

    // Find every `-e` flag's payload (the next arg after each `-e`).
    const eFlagPayloads: string[] = [];
    for (let i = 0; i < tmuxArgs.length; i++) {
      if (tmuxArgs[i] === '-e' && i + 1 < tmuxArgs.length) {
        eFlagPayloads.push(tmuxArgs[i + 1]);
      }
    }

    expect(eFlagPayloads.find((p) => p.startsWith('OPENAI_API_KEY='))).toBeUndefined();
    expect(eFlagPayloads.find((p) => p.startsWith('OPENAI_ORG_ID='))).toBeUndefined();
    expect(eFlagPayloads.find((p) => p.startsWith('OPENAI_PROJECT_ID='))).toBeUndefined();
  });

  it('does emit CODEX_HOME via -e when configured', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({ prompt: 'hello' });

    const firstCall = execFileSyncSpy.mock.calls[0];
    const tmuxArgs = firstCall[1] as string[];
    const eFlagPayloads: string[] = [];
    for (let i = 0; i < tmuxArgs.length; i++) {
      if (tmuxArgs[i] === '-e' && i + 1 < tmuxArgs.length) {
        eFlagPayloads.push(tmuxArgs[i + 1]);
      }
    }
    expect(eFlagPayloads).toContain(`CODEX_HOME=${baseConfig.codexHome}`);
  });

  it('does emit INSTAR_SESSION_ID via -e on every spawn', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({ prompt: 'hello' });

    const firstCall = execFileSyncSpy.mock.calls[0];
    const tmuxArgs = firstCall[1] as string[];
    const eFlagPayloads: string[] = [];
    for (let i = 0; i < tmuxArgs.length; i++) {
      if (tmuxArgs[i] === '-e' && i + 1 < tmuxArgs.length) {
        eFlagPayloads.push(tmuxArgs[i + 1]);
      }
    }
    expect(eFlagPayloads.find((p) => p.startsWith('INSTAR_SESSION_ID='))).toBeDefined();
  });

  it('drops caller-supplied OPENAI_API_KEY in options.env', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({
      prompt: 'hello',
      env: { OPENAI_API_KEY: 'sk-CALLER-LEAK' },
    });

    const firstCall = execFileSyncSpy.mock.calls[0];
    const tmuxArgs = firstCall[1] as string[];
    const eFlagPayloads: string[] = [];
    for (let i = 0; i < tmuxArgs.length; i++) {
      if (tmuxArgs[i] === '-e' && i + 1 < tmuxArgs.length) {
        eFlagPayloads.push(tmuxArgs[i + 1]);
      }
    }
    expect(eFlagPayloads.find((p) => p.includes('sk-CALLER-LEAK'))).toBeUndefined();
  });

  it('admits allowlisted caller env vars (CODEX_DEFAULT_MODEL) via -e', async () => {
    const sess = createAgenticSessionHeadless(baseConfig);
    await sess.start({
      prompt: 'hello',
      env: { CODEX_DEFAULT_MODEL: 'gpt-5.3-codex' },
    });

    const firstCall = execFileSyncSpy.mock.calls[0];
    const tmuxArgs = firstCall[1] as string[];
    const eFlagPayloads: string[] = [];
    for (let i = 0; i < tmuxArgs.length; i++) {
      if (tmuxArgs[i] === '-e' && i + 1 < tmuxArgs.length) {
        eFlagPayloads.push(tmuxArgs[i + 1]);
      }
    }
    expect(eFlagPayloads).toContain('CODEX_DEFAULT_MODEL=gpt-5.3-codex');
  });
});
