/**
 * Unit tests for buildCodexChildEnv() — Rule 1a env-scrubbing.
 *
 * Spec: specs/provider-portability/12-openai-path-constraints.md § Rule 1a.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// NOTE: This test imports the helper AFTER the test file is loaded, which
// means the BOOT_OPENAI_BASE_URL module-level constant captures whatever
// value `process.env.OPENAI_BASE_URL` had at vitest's process boot — NOT at
// individual test setup. We don't mutate OPENAI_BASE_URL in tests; we test
// the scrub of OPENAI_API_KEY / OPENAI_ORG_ID / OPENAI_PROJECT_ID instead,
// which the helper reads at call time.
import {
  buildCodexChildEnv,
  buildCodexTmuxSessionEnv,
} from '../../../../../src/providers/adapters/openai-codex/transport/codexSpawn.js';

describe('buildCodexChildEnv — Rule 1a env-scrubbing', () => {
  const saved = {
    apiKey: process.env.OPENAI_API_KEY,
    orgId: process.env.OPENAI_ORG_ID,
    projectId: process.env.OPENAI_PROJECT_ID,
    killSwitch: process.env.INSTAR_DISABLE_RULE1_OPENAI,
    home: process.env.HOME,
    pathVar: process.env.PATH,
  };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
    delete process.env.INSTAR_DISABLE_RULE1_OPENAI;
  });

  afterEach(() => {
    restore('OPENAI_API_KEY', saved.apiKey);
    restore('OPENAI_ORG_ID', saved.orgId);
    restore('OPENAI_PROJECT_ID', saved.projectId);
    restore('INSTAR_DISABLE_RULE1_OPENAI', saved.killSwitch);
    restore('HOME', saved.home);
    restore('PATH', saved.pathVar);
  });

  it('default: scrubs OPENAI_API_KEY from inherited env', () => {
    process.env.OPENAI_API_KEY = 'sk-LEAK';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('default: scrubs OPENAI_ORG_ID from inherited env', () => {
    process.env.OPENAI_ORG_ID = 'org-LEAK';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_ORG_ID).toBeUndefined();
  });

  it('default: scrubs OPENAI_PROJECT_ID from inherited env', () => {
    process.env.OPENAI_PROJECT_ID = 'proj-LEAK';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_PROJECT_ID).toBeUndefined();
  });

  it('passes through HOME from allowlist', () => {
    process.env.HOME = '/Users/test-home';
    const env = buildCodexChildEnv();
    expect(env.HOME).toBe('/Users/test-home');
  });

  it('passes through PATH from allowlist', () => {
    process.env.PATH = '/usr/local/bin:/usr/bin';
    const env = buildCodexChildEnv();
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
  });

  it('does NOT pass through arbitrary unlisted variables', () => {
    process.env.RANDOM_PROJECT_SECRET = 'should-not-leak';
    const env = buildCodexChildEnv();
    expect(env.RANDOM_PROJECT_SECRET).toBeUndefined();
    delete process.env.RANDOM_PROJECT_SECRET;
  });

  it('options.apiKey explicitly sets OPENAI_API_KEY (Phase A deprecated path)', () => {
    process.env.OPENAI_API_KEY = 'sk-FROM-PARENT-ENV';
    const env = buildCodexChildEnv({ apiKey: 'sk-FROM-OPTIONS' });
    expect(env.OPENAI_API_KEY).toBe('sk-FROM-OPTIONS');
  });

  it('options.codexHome sets CODEX_HOME', () => {
    const env = buildCodexChildEnv({ codexHome: '/tmp/codex-home' });
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
  });

  it('kill-switch active passes OPENAI_API_KEY through from parent env', () => {
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    process.env.OPENAI_API_KEY = 'sk-ALLOWED-VIA-KILLSWITCH';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_API_KEY).toBe('sk-ALLOWED-VIA-KILLSWITCH');
  });

  it('kill-switch active with NO parent OPENAI_API_KEY does not set the variable', () => {
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('kill-switch must be exact "1" — other truthy strings are ignored', () => {
    process.env.INSTAR_DISABLE_RULE1_OPENAI = 'true';
    process.env.OPENAI_API_KEY = 'sk-SHOULD-BE-SCRUBBED';
    const env = buildCodexChildEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('options.apiKey wins over kill-switch (caller intent is explicit)', () => {
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    process.env.OPENAI_API_KEY = 'sk-FROM-PARENT';
    const env = buildCodexChildEnv({ apiKey: 'sk-FROM-OPTIONS' });
    expect(env.OPENAI_API_KEY).toBe('sk-FROM-OPTIONS');
  });
});

describe('buildCodexTmuxSessionEnv — Rule 1a session-extras allowlist', () => {
  it('always includes INSTAR_SESSION_ID', () => {
    const tuples = buildCodexTmuxSessionEnv({ sessionId: 'ocs-test' });
    expect(tuples).toContainEqual(['INSTAR_SESSION_ID', 'ocs-test']);
  });

  it('includes CODEX_HOME when provided', () => {
    const tuples = buildCodexTmuxSessionEnv({
      sessionId: 'ocs-test',
      codexHome: '/custom/codex',
    });
    expect(tuples).toContainEqual(['CODEX_HOME', '/custom/codex']);
  });

  it('omits CODEX_HOME when absent', () => {
    const tuples = buildCodexTmuxSessionEnv({ sessionId: 'ocs-test' });
    expect(tuples.find(([k]) => k === 'CODEX_HOME')).toBeUndefined();
  });

  it('drops OPENAI_API_KEY from extraEnv even if caller tries to inject it', () => {
    const tuples = buildCodexTmuxSessionEnv({
      sessionId: 'ocs-test',
      extraEnv: { OPENAI_API_KEY: 'sk-LEAK', LANG: 'en_US.UTF-8' },
    });
    expect(tuples.find(([k]) => k === 'OPENAI_API_KEY')).toBeUndefined();
    expect(tuples).toContainEqual(['LANG', 'en_US.UTF-8']);
  });

  it('drops OPENAI_ORG_ID and OPENAI_PROJECT_ID from extraEnv', () => {
    const tuples = buildCodexTmuxSessionEnv({
      sessionId: 'ocs-test',
      extraEnv: {
        OPENAI_ORG_ID: 'org-LEAK',
        OPENAI_PROJECT_ID: 'proj-LEAK',
      },
    });
    expect(tuples.find(([k]) => k === 'OPENAI_ORG_ID')).toBeUndefined();
    expect(tuples.find(([k]) => k === 'OPENAI_PROJECT_ID')).toBeUndefined();
  });

  it('drops unknown env vars (allowlist semantics, not blocklist)', () => {
    const tuples = buildCodexTmuxSessionEnv({
      sessionId: 'ocs-test',
      extraEnv: { ARBITRARY_VAR: 'whatever', LANG: 'C' },
    });
    expect(tuples.find(([k]) => k === 'ARBITRARY_VAR')).toBeUndefined();
    expect(tuples).toContainEqual(['LANG', 'C']);
  });

  it('admits CODEX_DEFAULT_MODEL and CODEX_DEFAULT_PROFILE from extraEnv', () => {
    const tuples = buildCodexTmuxSessionEnv({
      sessionId: 'ocs-test',
      extraEnv: {
        CODEX_DEFAULT_MODEL: 'gpt-5.3-codex',
        CODEX_DEFAULT_PROFILE: 'agent',
      },
    });
    expect(tuples).toContainEqual(['CODEX_DEFAULT_MODEL', 'gpt-5.3-codex']);
    expect(tuples).toContainEqual(['CODEX_DEFAULT_PROFILE', 'agent']);
  });

  it('returns a fresh array — caller mutation does not leak into next call', () => {
    const a = buildCodexTmuxSessionEnv({ sessionId: 'a' });
    a.push(['INJECTED', 'value']);
    const b = buildCodexTmuxSessionEnv({ sessionId: 'b' });
    expect(b.find(([k]) => k === 'INJECTED')).toBeUndefined();
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
