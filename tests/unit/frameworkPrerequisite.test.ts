/**
 * Unit tests for the framework-aware boot prerequisite helpers.
 *
 * resolveConfiguredFramework and checkFrameworkPrerequisite are pure
 * functions extracted from Config.load() so they can be unit-tested
 * without spawning the full config-load flow against the filesystem.
 *
 * The behavior they encode is the v1.0.0 unlock: codex-cli installs
 * no longer fail at startup just because Claude isn't installed.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveConfiguredFramework,
  checkFrameworkPrerequisite,
} from '../../src/core/Config.js';

describe('resolveConfiguredFramework', () => {
  it('returns the config value when it is a valid framework id', () => {
    expect(resolveConfiguredFramework('claude-code', undefined)).toBe('claude-code');
    expect(resolveConfiguredFramework('codex-cli', undefined)).toBe('codex-cli');
  });

  it('respects the env var when config is unset', () => {
    expect(resolveConfiguredFramework(undefined, 'codex-cli')).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, 'codex')).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, 'CODEX')).toBe('codex-cli');
  });

  it('config value wins over env value when both are set', () => {
    expect(resolveConfiguredFramework('claude-code', 'codex-cli')).toBe('claude-code');
    expect(resolveConfiguredFramework('codex-cli', 'claude-code')).toBe('codex-cli');
  });

  it('defaults to claude-code when both are unset or unknown', () => {
    expect(resolveConfiguredFramework(undefined, undefined)).toBe('claude-code');
    expect(resolveConfiguredFramework(undefined, '')).toBe('claude-code');
    expect(resolveConfiguredFramework(undefined, 'unknown-value')).toBe('claude-code');
  });

  it('handles env whitespace and case correctly', () => {
    expect(resolveConfiguredFramework(undefined, '  codex  ')).toBe('codex-cli');
    expect(resolveConfiguredFramework(undefined, 'CLAUDE-CODE')).toBe('claude-code');
  });
});

describe('checkFrameworkPrerequisite', () => {
  it('claude-code + claude present → satisfied', () => {
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'claude-code',
      claudePathDetected: '/usr/bin/claude',
      codexPathDetected: null,
    });
    expect(result.satisfied).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('claude-code + claude missing → not satisfied with install hint', () => {
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'claude-code',
      claudePathDetected: null,
      codexPathDetected: '/usr/bin/codex',
    });
    expect(result.satisfied).toBe(false);
    expect(result.error).toMatch(/Claude CLI not found/);
    expect(result.error).toMatch(/INSTAR_FRAMEWORK=codex-cli/);
  });

  it('codex-cli + codex present → satisfied', () => {
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'codex-cli',
      claudePathDetected: null,
      codexPathDetected: '/usr/bin/codex',
    });
    expect(result.satisfied).toBe(true);
  });

  it('codex-cli + codex missing → not satisfied with @openai/codex install hint', () => {
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'codex-cli',
      claudePathDetected: '/usr/bin/claude',
      codexPathDetected: null,
    });
    expect(result.satisfied).toBe(false);
    expect(result.error).toMatch(/Codex CLI not found/);
    expect(result.error).toMatch(/@openai\/codex/);
  });

  it('codex-cli does NOT require Claude to be installed', () => {
    // This is the v1.0.0 unlock: previously every install needed Claude.
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'codex-cli',
      claudePathDetected: null,        // Claude absent
      codexPathDetected: '/usr/bin/codex', // Codex present
    });
    expect(result.satisfied).toBe(true);
  });

  it('claude-code does NOT require Codex to be installed', () => {
    const result = checkFrameworkPrerequisite({
      configuredFramework: 'claude-code',
      claudePathDetected: '/usr/bin/claude',
      codexPathDetected: null,
    });
    expect(result.satisfied).toBe(true);
  });
});
