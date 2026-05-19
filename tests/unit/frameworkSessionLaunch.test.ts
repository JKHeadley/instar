/**
 * Unit tests — frameworkSessionLaunch.
 *
 * Verifies that the launch-arg builder produces the right argv and
 * env-overrides shape for each framework. Includes a regression-class
 * test against the v0.x Claude shape so a future builder change can't
 * silently break existing Claude-installed agents.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
  resolveInteractiveFramework,
  resolveModelForFramework,
} from '../../src/core/frameworkSessionLaunch.js';

describe('frameworkSessionLaunch.buildInteractiveLaunch', () => {
  describe('claude-code', () => {
    it('produces the legacy v0.x argv shape (binary + --dangerously-skip-permissions)', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
      });
      expect(spec.argv).toEqual(['/usr/local/bin/claude', '--dangerously-skip-permissions']);
    });

    it('appends --resume <id> when a resumeSessionId is provided', () => {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        resumeSessionId: 'abc-123',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '--resume',
        'abc-123',
      ]);
    });

    it('emits CLAUDECODE= override so nested Claude detection stays off', () => {
      const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/x/claude' });
      expect(spec.envOverrides).toEqual({ CLAUDECODE: '' });
    });
  });

  describe('codex-cli', () => {
    it('passes --model gpt-5.3-codex + --dangerously-bypass-approvals-and-sandbox by default (parity with Claude\'s --dangerously-skip-permissions)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
      });
      // The `--model gpt-5.3-codex` flag is required to avoid Codex
      // CLI's default `gpt-5.2-codex`, which OpenAI retired from
      // ChatGPT-subscription auth on 2026-04-14. See models.ts comment
      // block for the empirically-verified working-model list.
      // The bypass flag is the single-flag parity for Claude's
      // `--dangerously-skip-permissions` — both removes approval
      // prompts AND drops the sandbox (which would otherwise block the
      // agent from reaching localhost where instar's server lives).
      expect(spec.argv).toEqual([
        '/usr/local/bin/codex',
        '--model',
        'gpt-5.3-codex',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
    });

    it('honors a custom codexSandboxMode by switching to the flag-pair form (safer profile, no bypass)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        codexSandboxMode: 'read-only',
      });
      expect(spec.argv).toContain('--sandbox');
      expect(spec.argv).toContain('read-only');
      expect(spec.argv).toContain('--ask-for-approval');
      expect(spec.argv).toContain('never');
      expect(spec.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('inserts `resume <id>` as a subcommand right after the binary path when resumeSessionId is set', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'sess-42',
      });
      // Codex's resume is a SUBCOMMAND (codex resume <id>), not a flag.
      // Must be the first arg after the binary; flags follow.
      expect(spec.argv[0]).toBe('/usr/local/bin/codex');
      expect(spec.argv[1]).toBe('resume');
      expect(spec.argv[2]).toBe('sess-42');
      expect(spec.argv).toContain('--model');
      // The flag-style --resume must NEVER appear — Codex doesn't accept it.
      expect(spec.argv).not.toContain('--resume');
    });

    it('does NOT insert `resume` when resumeSessionId is absent (fresh launch)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
      });
      expect(spec.argv).not.toContain('resume');
      expect(spec.argv[1]).toBe('--model');
    });

    it('preserves sandbox + model flags when resuming', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'uuid-7',
        codexSandboxMode: 'workspace-write',
      });
      expect(spec.argv).toContain('resume');
      expect(spec.argv).toContain('uuid-7');
      expect(spec.argv).toContain('--sandbox');
      expect(spec.argv).toContain('workspace-write');
      expect(spec.argv).toContain('--model');
    });

    it('preserves --oss + --local-provider when resuming a local-model session', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'local-uuid',
        codexLocalProvider: 'ollama',
        defaultModel: 'llama3.2:latest',
      });
      expect(spec.argv).toContain('resume');
      expect(spec.argv).toContain('local-uuid');
      expect(spec.argv).toContain('--oss');
      expect(spec.argv).toContain('--local-provider');
      expect(spec.argv).toContain('ollama');
    });

    it('emits CLAUDECODE= override as defense-in-depth', () => {
      const spec = buildInteractiveLaunch('codex-cli', { binaryPath: '/x/codex' });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });
});

describe('frameworkSessionLaunch.resolveInteractiveFramework', () => {
  it('per-call wins over config and env', () => {
    expect(
      resolveInteractiveFramework({
        perCall: 'codex-cli',
        configFramework: 'claude-code',
        envFramework: 'claude-code',
      }),
    ).toBe('codex-cli');
  });

  it('config wins over env when per-call is unset', () => {
    expect(
      resolveInteractiveFramework({
        configFramework: 'codex-cli',
        envFramework: 'claude-code',
      }),
    ).toBe('codex-cli');
  });

  it('env wins when per-call and config are unset', () => {
    expect(
      resolveInteractiveFramework({
        envFramework: 'codex-cli',
      }),
    ).toBe('codex-cli');
  });

  it('defaults to claude-code when nothing is set', () => {
    expect(resolveInteractiveFramework({})).toBe('claude-code');
  });

  it('treats env null the same as unset', () => {
    expect(resolveInteractiveFramework({ envFramework: null })).toBe('claude-code');
  });
});

describe('frameworkSessionLaunch.buildHeadlessLaunch', () => {
  describe('claude-code', () => {
    it('builds --dangerously-skip-permissions + -p prompt', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'hello world',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/claude',
        '--dangerously-skip-permissions',
        '-p',
        'hello world',
      ]);
      expect(spec.envOverrides).toEqual({ CLAUDECODE: '' });
    });

    it('includes --model when specified', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'p',
        model: 'sonnet',
      });
      expect(spec.argv).toContain('--model');
      expect(spec.argv).toContain('sonnet');
      expect(spec.argv[spec.argv.length - 1]).toBe('p');
    });

    it('clears CLAUDECODE in env overrides (nested-detection guard)', () => {
      const spec = buildHeadlessLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        prompt: 'x',
      });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });

  describe('codex-cli', () => {
    it('builds codex exec --json with default sandbox + model', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'analyze this',
      });
      expect(spec.argv[0]).toBe('/usr/local/bin/codex');
      expect(spec.argv).toContain('exec');
      expect(spec.argv).toContain('--json');
      expect(spec.argv).toContain('--skip-git-repo-check');
      expect(spec.argv).toContain('-s');
      expect(spec.argv).toContain('workspace-write');
      expect(spec.argv).toContain('-m');
      expect(spec.argv).toContain('gpt-5.3-codex');
      expect(spec.argv[spec.argv.length - 1]).toBe('analyze this');
    });

    it('honors codexSandboxMode override', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'p',
        codexSandboxMode: 'read-only',
      });
      expect(spec.argv).toContain('read-only');
      expect(spec.argv).not.toContain('workspace-write');
    });

    it('honors model override', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'p',
        model: 'gpt-5.4-codex',
      });
      expect(spec.argv).toContain('gpt-5.4-codex');
      expect(spec.argv).not.toContain('gpt-5.3-codex');
    });

    it('prompt is the last positional arg', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'final-positional',
      });
      expect(spec.argv[spec.argv.length - 1]).toBe('final-positional');
    });

    it('clears CLAUDECODE for defense-in-depth', () => {
      const spec = buildHeadlessLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        prompt: 'x',
      });
      expect(spec.envOverrides.CLAUDECODE).toBe('');
    });
  });

  it('throws for unknown framework', () => {
    expect(() =>
      buildHeadlessLaunch('made-up-framework' as never, {
        binaryPath: '/x',
        prompt: 'y',
      }),
    ).toThrowError(/No headless launch builder/);
  });
});

describe('frameworkSessionLaunch.resolveModelForFramework', () => {
  describe('claude-code', () => {
    it('maps generic tiers to Claude CLI aliases', () => {
      expect(resolveModelForFramework('claude-code', 'fast')).toBe('haiku');
      expect(resolveModelForFramework('claude-code', 'balanced')).toBe('sonnet');
      expect(resolveModelForFramework('claude-code', 'capable')).toBe('opus');
    });
    it('passes Claude tier names through verbatim', () => {
      expect(resolveModelForFramework('claude-code', 'haiku')).toBe('haiku');
      expect(resolveModelForFramework('claude-code', 'sonnet')).toBe('sonnet');
      expect(resolveModelForFramework('claude-code', 'opus')).toBe('opus');
    });
    it('passes raw model ids through verbatim', () => {
      expect(resolveModelForFramework('claude-code', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });
    it('returns undefined for undefined input', () => {
      expect(resolveModelForFramework('claude-code', undefined)).toBeUndefined();
    });
  });

  describe('codex-cli', () => {
    it('maps generic tiers to subscription-safe Codex model ids', () => {
      expect(resolveModelForFramework('codex-cli', 'fast')).toBe('gpt-5.2');
      expect(resolveModelForFramework('codex-cli', 'balanced')).toBe('gpt-5.3-codex');
      expect(resolveModelForFramework('codex-cli', 'capable')).toBe('gpt-5.4');
    });
    it('maps legacy Claude tier names to Codex equivalents (cross-port back-compat)', () => {
      expect(resolveModelForFramework('codex-cli', 'haiku')).toBe('gpt-5.2');
      expect(resolveModelForFramework('codex-cli', 'sonnet')).toBe('gpt-5.3-codex');
      expect(resolveModelForFramework('codex-cli', 'opus')).toBe('gpt-5.4');
    });
    it('passes raw Codex model ids through verbatim', () => {
      expect(resolveModelForFramework('codex-cli', 'gpt-5.4-codex')).toBe('gpt-5.4-codex');
    });
  });

  it('claude headless builder rewrites generic tier to haiku/sonnet/opus', () => {
    const fast = buildHeadlessLaunch('claude-code', { binaryPath: '/x/claude', prompt: 'p', model: 'fast' });
    expect(fast.argv).toContain('haiku');
    expect(fast.argv).not.toContain('fast');
  });

  it('codex headless builder rewrites generic tier to gpt-5.x', () => {
    const balanced = buildHeadlessLaunch('codex-cli', { binaryPath: '/x/codex', prompt: 'p', model: 'balanced' });
    expect(balanced.argv).toContain('gpt-5.3-codex');
    expect(balanced.argv).not.toContain('balanced');
  });
});

describe('frameworkSessionLaunch — Phase 6 local-provider (codex --oss)', () => {
  it('headless: emits --oss + --local-provider <p> when codexLocalProvider set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'hello',
      model: 'llama3.2:latest',
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).toContain('--oss');
    expect(spec.argv).toContain('--local-provider');
    expect(spec.argv).toContain('ollama');
    expect(spec.argv).toContain('llama3.2:latest');
    // local-provider mode does NOT run the OpenAI tier resolver
    expect(spec.argv).not.toContain('gpt-5.3-codex');
  });

  it('headless: defaults to llama3.2:latest when model omitted and local provider set', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).toContain('llama3.2:latest');
  });

  it('headless: lmstudio provider also accepted', () => {
    const spec = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      prompt: 'p',
      model: 'qwen2.5-coder:7b',
      codexLocalProvider: 'lmstudio',
    });
    expect(spec.argv).toContain('lmstudio');
    expect(spec.argv).toContain('qwen2.5-coder:7b');
  });

  it('interactive: emits --oss + --local-provider on the interactive launch path', () => {
    const spec = buildInteractiveLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      codexLocalProvider: 'ollama',
      defaultModel: 'llama3.2:latest',
    });
    expect(spec.argv).toContain('--oss');
    expect(spec.argv).toContain('--local-provider');
    expect(spec.argv).toContain('ollama');
    expect(spec.argv).toContain('llama3.2:latest');
  });

  it('headless: claude-code framework ignores codexLocalProvider (Codex-only flag)', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/x/claude',
      prompt: 'p',
      // @ts-expect-error — codexLocalProvider isn't valid for claude-code
      codexLocalProvider: 'ollama',
    });
    expect(spec.argv).not.toContain('--oss');
    expect(spec.argv).not.toContain('--local-provider');
  });
});
