/**
 * Tests for the Codex event-normalizer canary.
 *
 * The canary fails the build if Codex's JSONL event vocabulary ever
 * shifts under us. These tests verify the canary itself behaves
 * correctly against known fixtures.
 */

import { describe, it, expect } from 'vitest';
import { runCodexEventNormalizerCanary } from '../../../../../../src/providers/adapters/openai-codex/canary/codexEventNormalizerCanary.js';

describe('runCodexEventNormalizerCanary', () => {
  it('passes against the captured Codex 0.130.0 fixtures', () => {
    const result = runCodexEventNormalizerCanary();
    expect(result.status).toBe('pass');
    expect(result.failures).toHaveLength(0);
    expect(result.recognizedTypeCount).toBeGreaterThanOrEqual(12);
  });

  it('runs fast (synchronous, no I/O)', () => {
    const start = Date.now();
    runCodexEventNormalizerCanary();
    expect(Date.now() - start).toBeLessThan(100);
  });
});
