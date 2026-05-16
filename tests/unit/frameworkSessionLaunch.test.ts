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
  resolveInteractiveFramework,
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
    it('passes --sandbox workspace-write + --ask-for-approval never by default (agentic equivalent of --dangerously-skip-permissions)', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
      });
      expect(spec.argv).toEqual([
        '/usr/local/bin/codex',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
      ]);
    });

    it('honors a custom codexSandboxMode', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        codexSandboxMode: 'read-only',
      });
      expect(spec.argv).toContain('--sandbox');
      expect(spec.argv).toContain('read-only');
      expect(spec.argv).toContain('--ask-for-approval');
      expect(spec.argv).toContain('never');
    });

    it('does NOT pass a --resume flag — Codex resume is a subcommand and is not yet supported on this path', () => {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        resumeSessionId: 'sess-42',
      });
      // Codex's --resume is a SUBCOMMAND (codex resume <id>), not a flag.
      // Until TopicResumeMap learns the subcommand form, the launch path
      // starts fresh and emits a console warning.
      expect(spec.argv).not.toContain('--resume');
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
