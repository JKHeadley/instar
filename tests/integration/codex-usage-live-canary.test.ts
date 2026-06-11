/**
 * Live codex usage canary (token-audit-completeness, L5 state-detection
 * robustness): ONE real `codex exec --json` call asserting per-call usage is
 * actually recorded.
 *
 * SKIP-VS-FAIL BOUNDARY (pinned by the spec — a canary that reddens on
 * weather gets skip-listed, which is the suppression path that re-opens the
 * rot):
 *  - NAMED-SKIP: codex binary absent, or the failure is environmental (auth
 *    error, rate-limit signature, network error, non-zero exit).
 *  - FAIL on the discriminating cases: SUCCESSFUL exit + ZERO recorded usage
 *    — whether the stream was non-empty (parse rot) or empty (emission rot).
 */
import { describe, it, expect } from 'vitest';
import { detectCodexPath } from '../../src/core/Config.js';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';

const ENVIRONMENTAL_SIGNATURES = [
  /not logged in/i,
  /auth/i,
  /rate.?limit/i,
  /usage limit/i,
  /quota/i,
  /network/i,
  /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/,
  /timed? ?out/i,
  /exit \d+/i, // non-zero exit (env/CLI trouble) — NOT the parse-rot case
];

describe('live codex canary — per-call usage is recorded', () => {
  it('one real codex exec --json call records usage', async (ctx) => {
    const codexPath = detectCodexPath();
    if (!codexPath) {
      ctx.skip(); // named-skip: no codex binary on this machine
      return;
    }

    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const provider = new CodexCliIntelligenceProvider({
      codexPath,
      // Force exec-json regardless of this machine's config — the canary
      // tests the json path specifically.
      resolveExecJson: () => true,
    });

    let result: string;
    try {
      result = await provider.evaluate('Reply with exactly the word: PONG', {
        timeoutMs: 90_000,
        onUsage: (u) => usages.push(u),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ENVIRONMENTAL_SIGNATURES.some((re) => re.test(msg))) {
        ctx.skip(); // named-skip: environmental failure, not parse rot
        return;
      }
      throw err;
    }

    // SUCCESS path: zero recorded usage is the discriminating failure —
    // exactly the token-blindness this spec exists to prevent.
    expect(result.length).toBeGreaterThan(0);
    expect(
      usages.length,
      'codex exec --json succeeded but recorded ZERO usage — parse/emission rot (do NOT skip-list this; fix the parser)',
    ).toBeGreaterThan(0);
    expect(usages[0].inputTokens + usages[0].outputTokens).toBeGreaterThan(0);
  }, 120_000);
});
