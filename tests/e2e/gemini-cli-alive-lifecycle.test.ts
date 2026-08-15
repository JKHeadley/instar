/**
 * Tier-3 E2E "feature is alive" lifecycle test — the gemini-cli runtime body
 * (apprenticeship Step 2, the umbrella's Step-2 acceptance: the body works).
 *
 * Unlike a route-backed feature, the gemini body is INFRASTRUCTURE (a runtime
 * adapter), so "alive" means: an agent configured `framework: gemini-cli`
 * resolves a working transport through the PRODUCTION path —
 * `buildIntelligenceProvider` → `GeminiCliIntelligenceProvider` — without a
 * 503/throw, and a real one-shot completes end-to-end against the live binary.
 *
 * This proves the meta-lesson: the existing (framework-agnostic) mind can run
 * on the Gemini body.
 *
 * Two layers:
 *   1. STRUCTURAL (always runs, CI-safe): the production resolution path names
 *      and constructs the gemini provider. Gated to skip cleanly when the
 *      binary is absent (CI without gemini installed stays green).
 *   2. REAL SMOKE (runs ONLY when the binary is present, e.g. the dev box with
 *      v0.25.2 installed): a real `gemini -m gemini-2.5-flash --approval-mode
 *      default -p "<known-answer>"` returns the expected PONG-style text. A
 *      genuine alive proof, not a mock.
 *
 * MEASURED 2026-08-14 (round 10) — WHERE THAT CLAIM CURRENTLY STOPS. On this dev box the smoke
 * assertion has never actually executed. The binary IS present, so layer 2 runs and the file
 * reports green — but the CLI cannot authenticate by any path here, so it always reaches the
 * environmental skip instead of the assertion. Two independent facts, both measured rather than
 * inferred: the child env is key-free BY DESIGN (the API-key vars are hard-deleted as billing
 * vars — see tests/helpers/geminiEnvRefusal.ts), and there is no cached `oauth_creds.json` under
 * ~/.gemini either. Run directly in a shell with no filtering at all, `gemini` still exits 41.
 *
 * So "a genuine alive proof, not a mock" describes what this test WOULD prove on a credentialed
 * box, not what it has proven on this one. The skip is loud, and nothing here is broken — but a
 * reader counting this file among the green ones should not conclude the gemini body was exercised.
 * Stated rather than fixed: making it exercisable needs a credential decision that is the operator's.
 */

import { describe, it, expect } from 'vitest';
import { geminiEnvRefusal } from '../helpers/geminiEnvRefusal.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import { GeminiCliIntelligenceProvider } from '../../src/core/GeminiCliIntelligenceProvider.js';
import { CircuitBreakingIntelligenceProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { SpawnCapIntelligenceProvider } from '../../src/core/SpawnCapIntelligenceProvider.js';
import { detectGeminiPath } from '../../src/core/Config.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const geminiPath = detectGeminiPath();
const haveGemini = !!geminiPath;

describe('Gemini CLI body — feature is alive (E2E)', () => {
  it('the production resolution path constructs a gemini provider (no 503/throw)', () => {
    // Mirror server.ts / composition-root resolution: pick the framework, build
    // the provider. With the binary present this is non-null and wrapped.
    const provider: IntelligenceProvider | null = buildIntelligenceProvider({
      framework: 'gemini-cli',
      ...(geminiPath ? { binaryPath: geminiPath } : {}),
    });

    if (!haveGemini) {
      // CI without gemini installed: the contract is "null, not throw".
      expect(provider).toBeNull();
      return;
    }

    expect(provider).not.toBeNull();
    // The factory wraps every provider in TWO universal funnels (fork-bomb
    // prevention, forkbomb-prevention-simple §P1): circuit breaker (OUTER) →
    // host-wide spawn cap (MIDDLE) → actual provider (INNER).
    expect(provider).toBeInstanceOf(CircuitBreakingIntelligenceProvider);
    const spawnCap = (provider as unknown as { inner: IntelligenceProvider }).inner;
    expect(spawnCap).toBeInstanceOf(SpawnCapIntelligenceProvider);
    const inner = (spawnCap as unknown as { inner: IntelligenceProvider }).inner;
    expect(inner).toBeInstanceOf(GeminiCliIntelligenceProvider);
  });

  it.skipIf(!haveGemini)(
    'a REAL one-shot returns the expected smoke text through the production provider',
    async () => {
      const provider = buildIntelligenceProvider({
        framework: 'gemini-cli',
        binaryPath: geminiPath!,
      });
      expect(provider).not.toBeNull();

      // A deterministic known-answer prompt — the gemini analog of the codex
      // Reply-with-PONGXYZ smoke. Run through the ALIVE provider, not a mock.
      let out: string;
      try {
        out = await provider!.evaluate(
          'Reply with exactly the single word: PONGGEMINI and nothing else.',
          { model: 'fast', timeoutMs: 45_000 },
        );
      } catch (err) {
        // `haveGemini` proves the binary is INSTALLED, not that it is USABLE. An uncredentialed CLI
        // exits before it reads our prompt, so there is nothing here to assert about our code — the
        // provider embeds the CLI's own stderr in this message, and only that named cause is skipped.
        // Anything else rethrows, because a non-zero exit is also what a genuine break looks like.
        const refusal = geminiEnvRefusal(err instanceof Error ? err.message : String(err));
        if (!refusal) throw err;
        console.warn(`Skipping live Gemini smoke assertion: ${refusal}.`);
        return;
      }
      expect(out.toUpperCase()).toContain('PONGGEMINI');
    },
    60_000,
  );
});
