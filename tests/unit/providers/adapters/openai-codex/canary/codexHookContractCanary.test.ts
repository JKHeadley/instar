/**
 * Tests for the Codex hook-contract canary.
 *
 * Layer A (deterministic invariant lock) must always assert the load-bearing
 * shape regardless of host. Layer B (live-binary probe) is best-effort — on a
 * host with a real codex it returns 'pass'; without one it returns 'skip'
 * (NEVER 'fail' for a missing binary).
 */

import { describe, it, expect } from 'vitest';
import {
  runCodexHookContractCanary,
  resolveCodexBinaryForCanary,
  REQUIRED_CODEX_HOOK_EVENTS,
} from '../../../../../../src/providers/adapters/openai-codex/canary/codexHookContractCanary.js';

describe('runCodexHookContractCanary', () => {
  it('locks the load-bearing invariants: regex matcher, shell guard, full Stop trio', () => {
    const result = runCodexHookContractCanary();
    // Layer A must never fail on a correctly-wired tree.
    expect(result.details.matcherIsRegex, '.* matcher').toBe(true);
    expect(result.details.dangerousGuardOnPreToolUse, 'dangerous-command-guard on PreToolUse').toBe(true);
    expect(result.details.stopReviewTrioWired, 'response-review + deferral + scope-coherence on Stop').toBe(true);
    expect(result.details.failures).toEqual([]);
  });

  it('never reports the layer-A invariants as a FAIL when wiring is correct', () => {
    const result = runCodexHookContractCanary();
    // Status is 'pass' (binary present + declares events) or 'skip' (no binary),
    // but layer-A correctness means it must not be 'fail'.
    expect(result.status).not.toBe('fail');
  });

  it('skips (not fails) the binary layer when no codex binary declares the schema', () => {
    const result = runCodexHookContractCanary();
    if (!result.details.binaryProbed) {
      expect(result.status).toBe('skip');
      expect(result.details.missingEventsInBinary).toEqual([]);
    }
  });

  it('when a codex binary IS probed, it declares every required hook event', () => {
    const result = runCodexHookContractCanary();
    if (result.details.binaryProbed) {
      // A real, hooks-capable codex must still carry our depended-on events.
      expect(result.details.missingEventsInBinary).toEqual([]);
      expect(result.status).toBe('pass');
    } else {
      // No representative binary on this host — nothing to assert here.
      expect(result.details.binaryProbed).toBe(false);
    }
  });

  it('exposes the required-events contract list', () => {
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('PreToolUse');
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('Stop');
    expect(REQUIRED_CODEX_HOOK_EVENTS).toContain('SessionStart');
  });

  it('resolveCodexBinaryForCanary returns a string path or null (never throws)', () => {
    const p = resolveCodexBinaryForCanary();
    expect(p === null || typeof p === 'string').toBe(true);
  });
});
