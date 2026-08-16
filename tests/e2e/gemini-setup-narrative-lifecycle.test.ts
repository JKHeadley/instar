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
import { isGeminiAuthRefusal } from '../helpers/gemini-usable.js';

const geminiPath = detectGeminiPath();
const haveGemini = !!geminiPath;

describe('Gemini setup wizard narrative one-shot (E2E)', () => {
  it.skipIf(!haveGemini)(
    'a real gemini-cli one-shot can produce bounded setup narrative',
    async () => {
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

      if (result.exitCode !== 0 && /QUOTA_EXHAUSTED|exhausted your capacity|quota/i.test(result.stderr)) {
        console.warn('Skipping live Gemini narrative assertion: Gemini CLI quota is exhausted.');
        return;
      }

      // Same shape as the quota skip above, for the OTHER environment state that
      // makes a live one-shot impossible: the binary is installed but the account
      // cannot authenticate. `haveGemini` only checks that the binary EXISTS, so
      // it admitted a run that could never succeed (2026-07-30, topic 37155).
      // LOUD by design — a silent skip would make "gemini verified working" and
      // "gemini never ran" indistinguishable.
      if (result.exitCode !== 0 && isGeminiAuthRefusal(result.stderr)) {
        console.warn(
          '[gemini-e2e] SKIPPED — gemini CLI installed but NOT AUTHENTICATED on this ' +
          'machine, so the live one-shot cannot run. Environment state, not a code ' +
          'failure. Reason: ' + result.stderr.split('\n')[0],
        );
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
