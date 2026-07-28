/**
 * Codex model-tier resolution + retired-model regression guard.
 *
 * Context: OpenAI retired `gpt-5.2` from the ChatGPT-account Codex surface on
 * 2026-06-03 (it now returns HTTP 400 "not supported when using Codex with a
 * ChatGPT account"). Both codex tier maps — the adapter resolver
 * (openai-codex/models.ts) and the session-launch resolver
 * (frameworkSessionLaunch.ts) — hardcoded the `fast`/`haiku` tier to gpt-5.2,
 * which silently broke EVERY cheap codex call (CommitmentSentinel, tone-gate,
 * classification) on every codex agent. These tests pin the corrected mapping
 * and guard the retired name so a future edit can't reintroduce it.
 */

import { describe, it, expect } from 'vitest';
import { resolveCliModelFlag } from '../../src/providers/adapters/openai-codex/models.js';
import { resolveModelForFramework } from '../../src/core/frameworkSessionLaunch.js';

const RETIRED_ON_CHATGPT_ACCOUNT = 'gpt-5.2';

describe('codex model-tier resolution (post gpt-5.2 retirement 2026-06-03)', () => {
  describe('adapter resolver — resolveCliModelFlag (intel / one-shot path)', () => {
    it('fast tier resolves to the cheapest still-accepted model (gpt-5.4-mini)', () => {
      expect(resolveCliModelFlag('fast')).toBe('gpt-5.4-mini');
    });
    it('balanced tier resolves to gpt-5.4-mini', () => {
      expect(resolveCliModelFlag('balanced')).toBe('gpt-5.4-mini');
    });
    it('capable tier resolves to gpt-5.5', () => {
      expect(resolveCliModelFlag('capable')).toBe('gpt-5.5');
    });
    it('undefined falls back to the balanced default', () => {
      expect(resolveCliModelFlag(undefined)).toBe('gpt-5.4-mini');
    });
    it('a raw model id passes through verbatim', () => {
      expect(resolveCliModelFlag('gpt-5.4')).toBe('gpt-5.4');
    });
  });

  describe('session-launch resolver — resolveModelForFramework(codex-cli, ...)', () => {
    it('fast tier resolves to gpt-5.4-mini', () => {
      expect(resolveModelForFramework('codex-cli', 'fast')).toBe('gpt-5.4-mini');
    });
    it('legacy haiku alias resolves to gpt-5.4-mini (not the retired model)', () => {
      expect(resolveModelForFramework('codex-cli', 'haiku')).toBe('gpt-5.4-mini');
    });
    it('balanced/capable tiers are unchanged', () => {
      expect(resolveModelForFramework('codex-cli', 'balanced')).toBe('gpt-5.4-mini');
      expect(resolveModelForFramework('codex-cli', 'capable')).toBe('gpt-5.5');
    });
  });

  describe('retired-model regression guard', () => {
    it('NO tier in EITHER resolver produces the retired gpt-5.2', () => {
      for (const tier of ['fast', 'balanced', 'capable', 'haiku', 'sonnet', 'opus']) {
        expect(resolveCliModelFlag(tier)).not.toBe(RETIRED_ON_CHATGPT_ACCOUNT);
        expect(resolveModelForFramework('codex-cli', tier)).not.toBe(RETIRED_ON_CHATGPT_ACCOUNT);
      }
      expect(resolveCliModelFlag(undefined)).not.toBe(RETIRED_ON_CHATGPT_ACCOUNT);
    });
  });
});
