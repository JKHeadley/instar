/**
 * Unit tests for openaiKeyLeakageCanary.
 *
 * Spec: specs/provider-portability/12-openai-path-constraints.md § Rule 1a.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { runOpenAiKeyLeakageCanary } from '../../../../../../src/providers/adapters/openai-codex/canary/openaiKeyLeakageCanary.js';

describe('openaiKeyLeakageCanary', () => {
  const saved = {
    apiKey: process.env.OPENAI_API_KEY,
    orgId: process.env.OPENAI_ORG_ID,
    projectId: process.env.OPENAI_PROJECT_ID,
    killSwitch: process.env.INSTAR_DISABLE_RULE1_OPENAI,
  };

  afterEach(() => {
    restore('OPENAI_API_KEY', saved.apiKey);
    restore('OPENAI_ORG_ID', saved.orgId);
    restore('OPENAI_PROJECT_ID', saved.projectId);
    restore('INSTAR_DISABLE_RULE1_OPENAI', saved.killSwitch);
  });

  it('passes with no OpenAI env variables set', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
    delete process.env.INSTAR_DISABLE_RULE1_OPENAI;
    const result = runOpenAiKeyLeakageCanary();
    expect(result.status).toBe('pass');
    expect(result.failures).toHaveLength(0);
  });

  it('passes when sentinels are set in parent env (helper scrubs them)', () => {
    process.env.OPENAI_API_KEY = 'sk-PRE-EXISTING';
    process.env.OPENAI_ORG_ID = 'org-PRE-EXISTING';
    process.env.OPENAI_PROJECT_ID = 'proj-PRE-EXISTING';
    delete process.env.INSTAR_DISABLE_RULE1_OPENAI;
    const result = runOpenAiKeyLeakageCanary();
    expect(result.status).toBe('pass');
  });

  it('restores parent env after the check', () => {
    process.env.OPENAI_API_KEY = 'sk-USER-CHOICE';
    runOpenAiKeyLeakageCanary();
    expect(process.env.OPENAI_API_KEY).toBe('sk-USER-CHOICE');
  });

  it('explicitly clears the kill-switch during the check, even if parent had it set', () => {
    // If we ran the canary with kill-switch active, the helper would
    // legitimately pass OPENAI_API_KEY through and the canary would fail
    // spuriously. The canary must clear the kill-switch during the check.
    process.env.INSTAR_DISABLE_RULE1_OPENAI = '1';
    process.env.OPENAI_API_KEY = 'sk-CALLER-CHOICE';
    const result = runOpenAiKeyLeakageCanary();
    expect(result.status).toBe('pass');
    // ...and restore kill-switch after.
    expect(process.env.INSTAR_DISABLE_RULE1_OPENAI).toBe('1');
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
