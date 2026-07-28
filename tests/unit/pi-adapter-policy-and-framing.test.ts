/**
 * Pi adapter Phase B/C — unit tests for the two correctness-critical pieces
 * (PI-HARNESS-INTEGRATION-SPEC §4.1 + §4.3):
 *
 *   1. The SUBSCRIPTION GUARD (policy.ts) — both sides of every decision
 *      boundary: deny-by-default for Anthropic/Claude-routed patterns
 *      (including aggregator pass-throughs and the pattern-less case),
 *      allow for everything else, allow+audit on explicit override.
 *
 *   2. STRICT-LF JSONL FRAMING (rpcClient.ts) — pi's RPC protocol splits on
 *      `\n` ONLY. U+2028/U+2029 are valid inside JSON strings; a framing
 *      layer that splits on them (Node `readline`) corrupts records. The
 *      splitter is pinned here so that refactor fails loudly.
 *
 *   3. The factory boundary (§4.4): pi-cli requires binary + model pattern;
 *      missing either degrades to null; a denied pattern degrades to null
 *      (never throws out of the factory).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assertPiProviderAllowed,
  isAnthropicRoutedModelPattern,
} from '../../src/providers/adapters/pi-cli/policy.js';
import { PiAnthropicRouteError } from '../../src/providers/adapters/pi-cli/errors.js';
import { createStrictLfSplitter } from '../../src/providers/adapters/pi-cli/transport/rpcClient.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';

describe('pi subscription guard (spec §4.3) — deny side', () => {
  it.each([
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-8:high',
    'claude-sonnet-4-6',
    'openrouter/anthropic/claude-3.5-sonnet',
    'Anthropic/Claude-Opus',
  ])('denies %s', (pattern) => {
    expect(isAnthropicRoutedModelPattern(pattern)).toBe(true);
    expect(() => assertPiProviderAllowed(pattern)).toThrow(PiAnthropicRouteError);
  });

  it('denies a PATTERN-LESS call (pi ambient default could be an Anthropic login)', () => {
    expect(isAnthropicRoutedModelPattern(undefined)).toBe(true);
    expect(() => assertPiProviderAllowed(undefined)).toThrow(PiAnthropicRouteError);
  });

  it('the error message explains extra-usage billing and the override path', () => {
    try {
      assertPiProviderAllowed('anthropic/claude-sonnet-4-6');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('EXTRA USAGE');
      expect(message).toContain('allowAnthropicProviders');
    }
  });
});

describe('pi subscription guard — allow side', () => {
  it.each([
    'openai-codex/gpt-5.5',
    'mock/mock-model',
    'github-copilot/gpt-5.5',
    'groq/llama-3.3-70b',
  ])('allows %s without any override', (pattern) => {
    expect(isAnthropicRoutedModelPattern(pattern)).toBe(false);
    expect(() => assertPiProviderAllowed(pattern)).not.toThrow();
  });

  it('explicit override allows an Anthropic pattern AND audit-logs the cost warning', () => {
    const audit = vi.fn();
    expect(() =>
      assertPiProviderAllowed('anthropic/claude-sonnet-4-6', {
        allowAnthropicProviders: true,
        auditLog: audit,
      }),
    ).not.toThrow();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(String(audit.mock.calls[0][0])).toContain('extra usage');
  });

  it('the override never applies implicitly (false ≠ true; absent ≠ true)', () => {
    expect(() =>
      assertPiProviderAllowed('anthropic/claude-sonnet-4-6', { allowAnthropicProviders: false }),
    ).toThrow(PiAnthropicRouteError);
  });
});

describe('strict-LF JSONL splitter (spec §4.1)', () => {
  it('splits on \\n only and tolerates \\r\\n', () => {
    const lines: string[] = [];
    const splitter = createStrictLfSplitter((l) => lines.push(l));
    splitter.push('{"a":1}\n{"b":2}\r\n{"c"');
    splitter.push(':3}\n');
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('does NOT split on U+2028/U+2029 inside JSON strings (the readline trap)', () => {
    const lines: string[] = [];
    const splitter = createStrictLfSplitter((l) => lines.push(l));
    const record = JSON.stringify({ text: 'line sep para' });
    splitter.push(record + '\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toBe('line sep para');
  });

  it('flush emits a trailing partial line exactly once', () => {
    const lines: string[] = [];
    const splitter = createStrictLfSplitter((l) => lines.push(l));
    splitter.push('{"tail":true}');
    expect(lines).toHaveLength(0);
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(['{"tail":true}']);
  });
});

describe('factory boundary (spec §4.4)', () => {
  it('pi-cli without a model pattern degrades to null (never throws)', () => {
    const provider = buildIntelligenceProvider({
      framework: 'pi-cli',
      binaryPath: '/usr/local/bin/pi',
    });
    expect(provider).toBeNull();
  });

  it('pi-cli with an allowed pattern constructs a provider', () => {
    const provider = buildIntelligenceProvider({
      framework: 'pi-cli',
      binaryPath: '/usr/local/bin/pi',
      piModel: 'openai-codex/gpt-5.5',
    });
    expect(provider).not.toBeNull();
  });

  it('pi-cli with a DENIED pattern degrades to null (guard fires at construction)', () => {
    const provider = buildIntelligenceProvider({
      framework: 'pi-cli',
      binaryPath: '/usr/local/bin/pi',
      piModel: 'anthropic/claude-sonnet-4-6',
    });
    expect(provider).toBeNull();
  });

  it('pi-cli with a denied pattern + explicit override constructs (and is audited downstream)', () => {
    const provider = buildIntelligenceProvider({
      framework: 'pi-cli',
      binaryPath: '/usr/local/bin/pi',
      piModel: 'anthropic/claude-sonnet-4-6',
      piAllowAnthropicProviders: true,
    });
    expect(provider).not.toBeNull();
  });
});
