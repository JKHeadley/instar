/**
 * Tier-3 E2E smoke for the Gemini setup driver's bounded narrative step.
 *
 * Runs the real gemini-cli one-shot path with the same canonical argv/model
 * the driver uses. The assertion is intentionally modest: Gemini returns
 * prose for a narrative-only step and does not include command/tool language.
 */

import { describe, expect, it } from 'vitest';
import { detectGeminiPath } from '../../src/core/Config.js';
import { GEMINI_WIZARD_MODEL } from '../../src/commands/setup-wizard/model-constants.js';
import {
  buildGeminiChildEnv,
  buildGeminiOneShotArgv,
  spawnGeminiAndWait,
} from '../../src/providers/adapters/gemini-cli/transport/geminiSpawn.js';

const geminiPath = detectGeminiPath();
import {
  isUnconfiguredCredentialResult,
  announceCredentialSkip,
} from '../support/liveCredentialGate.js';

const haveGemini = !!geminiPath;

describe('Gemini setup wizard narrative one-shot (E2E)', () => {
  it.skipIf(!haveGemini)(
    'a real gemini-cli one-shot can produce bounded setup narrative',
    async (ctx) => {
      const prompt = `
You are the Instar setup wizard. Generate exactly one short welcoming
paragraph for a new user. Do not include commands, shell snippets, file
paths, tool names, bullet lists, or questions. Output prose only.
`.trim();

      const baseEnv = {
        ...buildGeminiChildEnv(),
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      };
      let result = await spawnGeminiAndWait(
        geminiPath!,
        buildGeminiOneShotArgv(GEMINI_WIZARD_MODEL, prompt),
        {
          timeoutMs: 45_000,
          env: baseEnv,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode === 126 && /asdf|No preset version installed/i.test(result.stderr)) {
        const versions = [...result.stderr.matchAll(/nodejs\s+([0-9]+\.[0-9]+\.[0-9]+)/g)]
          .map((m) => m[1]);
        const fallbackVersion = versions[versions.length - 1];
        if (fallbackVersion) {
          result = await spawnGeminiAndWait(
            geminiPath!,
            buildGeminiOneShotArgv(GEMINI_WIZARD_MODEL, prompt),
            {
              timeoutMs: 45_000,
              env: { ...baseEnv, ASDF_NODEJS_VERSION: fallbackVersion },
              maxOutputBytes: 64 * 1024,
            },
          );
        }
      }

      // Round-17: `haveGemini` gates on the BINARY EXISTING, which is not the
      // same as usable — this box has gemini installed with no credential, so
      // the gate said "available" and the canary hard-failed on auth. Unlike
      // the sibling e2e (where the provider THROWS), `spawnGeminiAndWait`
      // RESOLVES with { exitCode, stderr }, so the thrown-error matcher alone
      // would have missed this file entirely — a fix for "both failing tests"
      // that covered one. Same narrow rule: only the unconfigured-credential
      // signature skips; a rejected credential, a wrong answer, a timeout or a
      // crash all still fail.
      if (isUnconfiguredCredentialResult('gemini', result)) {
        announceCredentialSkip('gemini-cli', new Error(result.stderr));
        ctx.skip();
        return;
      }

      if (result.exitCode !== 0 && /QUOTA_EXHAUSTED|exhausted your capacity|quota/i.test(result.stderr)) {
        // Round-17: this was a bare `return`, which renders as a PASS — the
        // same "could not run looks identical to ran and passed" defect the
        // credential gate above exists to avoid, already present in this file.
        console.warn('[live-canary] SKIPPED — Gemini CLI quota is exhausted; the canary did not run.');
        ctx.skip();
        return;
      }

      expect(result.exitCode).toBe(0);
      const out = result.stdout.trim();
      expect(out.length).toBeGreaterThan(20);
      expect(out).not.toMatch(/\b(run|execute|shell|command|tool|read_file|search_file_content)\b/i);
    },
    60_000,
  );
});
