/**
 * Unit tests for the multi-provider credentials system.
 *
 * Covers:
 *   - Legacy field migration (anthropicApiKey → credentials.anthropic)
 *   - kind detection (oauth-token vs api-key)
 *   - baseUrl propagation
 *   - getProviderCredential fallback chain
 *   - buildProviderEnvFlags for each known provider
 *   - Unknown-provider safe-no-op behavior
 */

import { describe, it, expect } from 'vitest';
import {
  getProviderCredential,
  buildProviderEnvFlags,
} from '../../src/core/Config.js';
import type {
  SessionManagerConfig,
  ProviderCredential,
} from '../../src/core/types.js';

function makeConfig(overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig {
  return {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/bin/claude',
    projectDir: '/tmp/test',
    maxSessions: 1,
    protectedSessions: [],
    completionPatterns: [],
    ...overrides,
  };
}

describe('getProviderCredential', () => {
  it('returns null when no credentials configured for any provider', () => {
    const c = makeConfig();
    expect(getProviderCredential(c, 'anthropic')).toBeNull();
    expect(getProviderCredential(c, 'openai')).toBeNull();
  });

  it('returns the credential from the new credentials map', () => {
    const c = makeConfig({
      credentials: {
        anthropic: { kind: 'api-key', value: 'sk-ant-test123' },
        openai: { kind: 'api-key', value: 'sk-openai-456' },
      },
    });
    expect(getProviderCredential(c, 'anthropic')).toEqual({
      kind: 'api-key',
      value: 'sk-ant-test123',
    });
    expect(getProviderCredential(c, 'openai')).toEqual({
      kind: 'api-key',
      value: 'sk-openai-456',
    });
  });

  it('falls back to legacy anthropicApiKey when credentials map is empty', () => {
    const c = makeConfig({ anthropicApiKey: 'sk-ant-legacy' });
    const cred = getProviderCredential(c, 'anthropic');
    expect(cred?.kind).toBe('api-key');
    expect(cred?.value).toBe('sk-ant-legacy');
  });

  it('detects oauth-token kind from sk-ant-oat prefix in legacy field', () => {
    const c = makeConfig({ anthropicApiKey: 'sk-ant-oat-subscription-token' });
    const cred = getProviderCredential(c, 'anthropic');
    expect(cred?.kind).toBe('oauth-token');
  });

  it('propagates legacy anthropicBaseUrl into credential', () => {
    const c = makeConfig({
      anthropicApiKey: 'x',
      anthropicBaseUrl: 'http://localhost:3456',
    });
    const cred = getProviderCredential(c, 'anthropic');
    expect(cred?.baseUrl).toBe('http://localhost:3456');
  });

  it('credentials map wins over legacy fields when both exist', () => {
    const c = makeConfig({
      anthropicApiKey: 'legacy-key',
      credentials: {
        anthropic: { kind: 'oauth-token', value: 'sk-ant-oat-new' },
      },
    });
    const cred = getProviderCredential(c, 'anthropic');
    expect(cred?.value).toBe('sk-ant-oat-new');
    expect(cred?.kind).toBe('oauth-token');
  });

  it('returns null for unknown providers without legacy fallback', () => {
    const c = makeConfig({ anthropicApiKey: 'x' });
    expect(getProviderCredential(c, 'openai')).toBeNull();
    expect(getProviderCredential(c, 'google')).toBeNull();
    expect(getProviderCredential(c, 'made-up')).toBeNull();
  });
});

describe('buildProviderEnvFlags', () => {
  it('emits CLAUDE_CODE_OAUTH_TOKEN for anthropic oauth-token', () => {
    const cred: ProviderCredential = { kind: 'oauth-token', value: 'sk-ant-oat-xyz' };
    const flags = buildProviderEnvFlags('anthropic', cred);
    expect(flags).toContain('-e');
    expect(flags).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-xyz');
    expect(flags).toContain('ANTHROPIC_API_KEY=');
  });

  it('emits ANTHROPIC_API_KEY for anthropic api-key', () => {
    const cred: ProviderCredential = { kind: 'api-key', value: 'sk-ant-api-abc' };
    const flags = buildProviderEnvFlags('anthropic', cred);
    expect(flags).toContain('ANTHROPIC_API_KEY=sk-ant-api-abc');
    expect(flags).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
  });

  it('emits ANTHROPIC_BASE_URL when credential has baseUrl', () => {
    const cred: ProviderCredential = {
      kind: 'api-key',
      value: 'x',
      baseUrl: 'http://localhost:3456',
    };
    const flags = buildProviderEnvFlags('anthropic', cred);
    expect(flags).toContain('ANTHROPIC_BASE_URL=http://localhost:3456');
  });

  // Spec 12 Rule 1 — Codex must NOT use raw API key. The api-key path is
  // refused at the env-flag boundary so misconfigurations surface loudly
  // instead of silently leaking OPENAI_API_KEY via -e flags.
  it('REFUSES openai api-key credential with a clear spec reference', () => {
    const cred: ProviderCredential = { kind: 'api-key', value: 'sk-openai-789' };
    expect(() => buildProviderEnvFlags('openai', cred)).toThrowError(
      /12-openai-path-constraints/,
    );
  });

  it('emits no env vars for openai oauth-token (Codex uses auth.json)', () => {
    const cred: ProviderCredential = { kind: 'oauth-token', value: 'oauth' };
    const flags = buildProviderEnvFlags('openai', cred);
    expect(flags.find((f) => f.startsWith('OPENAI_API_KEY='))).toBeUndefined();
  });

  it('still emits OPENAI_BASE_URL for openai oauth-token with baseUrl', () => {
    const cred: ProviderCredential = {
      kind: 'oauth-token',
      value: 'oauth',
      baseUrl: 'https://proxy.example.com',
    };
    const flags = buildProviderEnvFlags('openai', cred);
    expect(flags).toContain('OPENAI_BASE_URL=https://proxy.example.com');
  });

  it('does not leak OPENAI_API_KEY in the refusal error message', () => {
    const cred: ProviderCredential = { kind: 'api-key', value: 'sk-SECRET-VALUE' };
    try {
      buildProviderEnvFlags('openai', cred);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-SECRET-VALUE');
    }
  });

  it('emits GOOGLE_API_KEY for google api-key', () => {
    const cred: ProviderCredential = { kind: 'api-key', value: 'AIza-test' };
    const flags = buildProviderEnvFlags('google', cred);
    expect(flags).toContain('GOOGLE_API_KEY=AIza-test');
  });

  it('returns empty array for unknown providers (safe-no-op)', () => {
    const cred: ProviderCredential = { kind: 'api-key', value: 'x' };
    expect(buildProviderEnvFlags('made-up-provider', cred)).toEqual([]);
  });
});
