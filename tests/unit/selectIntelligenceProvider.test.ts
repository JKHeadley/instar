/**
 * Tests for selectIntelligenceProvider — the single chokepoint that enforces
 * Instar's subscription-by-default principle.
 *
 * Critical safety properties under test:
 *   - API mode requires BOTH flags (intelligenceProvider AND intelligenceProviderConfirmed).
 *   - Setting only intelligenceProvider does NOT engage API mode.
 *   - An ANTHROPIC_API_KEY in the environment alone does NOT cause silent API use.
 *   - Selection always prefers Claude CLI subscription when API mode is rejected.
 *   - `apiKeyIgnored` accurately reports the "env key present, opt-in missing" case.
 */

import { describe, it, expect } from 'vitest';
import { selectIntelligenceProvider } from '../../src/core/selectIntelligenceProvider.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const fakeClaude: IntelligenceProvider = { evaluate: async () => 'cli-response' };
const fakeAnthropic: IntelligenceProvider = { evaluate: async () => 'api-response' };

const buildClaudeOK = (_: string) => fakeClaude;
const buildAnthropicOK = (_: string) => fakeAnthropic;
const buildClaudeFail = (_: string): IntelligenceProvider | null => {
  throw new Error('CLI not available');
};
const buildAnthropicFail = (_: string): IntelligenceProvider | null => {
  throw new Error('API not available');
};

describe('selectIntelligenceProvider — subscription-by-default safety', () => {
  describe('API mode (both flags required)', () => {
    it('engages API mode when both flags AND a key are present', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: true,
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeAnthropic);
      expect(result.source).toBe('anthropic-api-confirmed');
      expect(result.apiModeActive).toBe(true);
      expect(result.apiKeyIgnored).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('REFUSES API mode when intelligenceProvider is set but confirmed is missing', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: false,
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('intelligenceProviderConfirmed');
      expect(result.warnings[0]).toContain('DISABLED');
    });

    it('REFUSES API mode when confirmed is undefined (default)', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        // intelligenceProviderConfirmed omitted entirely
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.warnings[0]).toContain('intelligenceProviderConfirmed');
    });

    it('falls back to CLI when API flags are set but no key is present', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: true,
        anthropicApiKey: undefined,
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.warnings[0]).toContain('ANTHROPIC_API_KEY not found');
    });

    it('falls back to CLI when the Anthropic constructor throws', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: true,
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicFail,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.warnings[0]).toContain('Anthropic provider constructor returned null');
    });
  });

  describe('subscription-by-default (no silent API use)', () => {
    it('uses CLI when no flags are set, even if an API key is in env', () => {
      const result = selectIntelligenceProvider({
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.apiKeyIgnored).toBe(true);
      // No warning on the success path — apiKeyIgnored is the signal for the caller.
      expect(result.warnings).toEqual([]);
    });

    it('does NOT silently fall through to API when CLI is unavailable but key is present', () => {
      const result = selectIntelligenceProvider({
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeFail,
        buildAnthropic: buildAnthropicOK,
      });
      // The critical property: provider is null. No silent API use.
      expect(result.provider).toBe(null);
      expect(result.source).toBe('none');
      expect(result.apiModeActive).toBe(false);
      expect(result.apiKeyIgnored).toBe(true);
      expect(result.warnings.some((w) => w.includes('ANTHROPIC_API_KEY detected'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('Subscription-by-default'))).toBe(true);
    });

    it('returns provider:null with no warnings when neither CLI nor key is available', () => {
      const result = selectIntelligenceProvider({
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeFail,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(null);
      expect(result.source).toBe('none');
      expect(result.apiModeActive).toBe(false);
      expect(result.apiKeyIgnored).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('treats empty-string API key as not present', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: true,
        anthropicApiKey: '',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(fakeClaude);
      expect(result.source).toBe('claude-cli');
      expect(result.apiModeActive).toBe(false);
      expect(result.apiKeyIgnored).toBe(false);
    });
  });

  describe('CLI failure modes', () => {
    it('returns provider:null with empty warnings when CLI fails and no API mode requested', () => {
      const result = selectIntelligenceProvider({
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeFail,
        buildAnthropic: buildAnthropicOK,
        // no api key, no api opt-in
      });
      expect(result.provider).toBe(null);
      expect(result.source).toBe('none');
      expect(result.warnings).toEqual([]);
    });

    it('returns provider:null when claudePath is undefined', () => {
      const result = selectIntelligenceProvider({
        claudePath: undefined,
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.provider).toBe(null);
      expect(result.source).toBe('none');
    });
  });

  describe('apiKeyIgnored flag accuracy', () => {
    it('is true when key is present and no opt-in, regardless of outcome', () => {
      const a = selectIntelligenceProvider({
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(a.apiKeyIgnored).toBe(true);

      const b = selectIntelligenceProvider({
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeFail,
        buildAnthropic: buildAnthropicOK,
      });
      expect(b.apiKeyIgnored).toBe(true);
    });

    it('is false when API opt-in is active', () => {
      const result = selectIntelligenceProvider({
        intelligenceProvider: 'anthropic-api',
        intelligenceProviderConfirmed: true,
        anthropicApiKey: 'sk-test',
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.apiKeyIgnored).toBe(false);
    });

    it('is false when no key is present', () => {
      const result = selectIntelligenceProvider({
        claudePath: '/usr/bin/claude',
        buildClaude: buildClaudeOK,
        buildAnthropic: buildAnthropicOK,
      });
      expect(result.apiKeyIgnored).toBe(false);
    });
  });
});
