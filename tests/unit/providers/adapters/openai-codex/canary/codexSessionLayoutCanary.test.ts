/**
 * Tests for the Codex session-layout canary.
 */

import { describe, it, expect } from 'vitest';
import { runCodexSessionLayoutCanary } from '../../../../../../src/providers/adapters/openai-codex/canary/codexSessionLayoutCanary.js';

describe('runCodexSessionLayoutCanary', () => {
  it('passes when rollouts are discoverable under the canonical layout', async () => {
    const result = await runCodexSessionLayoutCanary();
    expect(result.status).toBe('pass');
    expect(result.details.rolloutFoundByUuid).toBe(true);
    expect(result.details.listFoundFixture).toBe(true);
    expect(result.details.walkRespectedDateParts).toBe(true);
  });
});
