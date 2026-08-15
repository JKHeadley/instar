/**
 * Unit — the live-gemini E2Es skip ONLY when the CLI named an environmental cause, and still fail
 * for everything else.
 *
 * The whole value of this classifier is the NEGATIVE direction. A skip that is too broad converts a
 * real regression into a green run with a warning nobody reads, which is strictly worse than the red
 * it replaces. So the cases below that must return `null` are the load-bearing ones: every shape a
 * genuine break in our argv building, transport, or the model's answer would take.
 */
import { describe, it, expect } from 'vitest';
import { geminiEnvRefusal } from '../helpers/geminiEnvRefusal.js';

describe('geminiEnvRefusal — recognises the CLI refusing on its own configuration', () => {
  it('the exact message that made the suite red on 2026-08-14', () => {
    // Verbatim from the failing run, via the provider's thrown Error.
    const msg =
      'Gemini CLI exited 41 — When using Gemini API, you must specify the GEMINI_API_KEY ' +
      'environment variable.\nUpdate your environment and try again (no reload needed if using .env)!';
    // Deliberately environment-independent: the classifier reads only the CLI's own message, which
    // is what makes this verdict the same on every box. Round 8 briefly made it env-dependent and
    // round 9 withdrew that — see the ROUND 9 case below.
    expect(geminiEnvRefusal(msg)).toMatch(/credential/i);
  });

  it.each([
    ['GOOGLE_API_KEY spelling', 'you must specify the GOOGLE_API_KEY environment variable'],
    ['bare env-var mention', 'GEMINI_API_KEY environment variable is required'],
    ['auth method unset', 'Please set an Auth method in your settings'],
    ['not authenticated', 'Error: not authenticated'],
  ])('credential cause: %s', (_name, stderr) => {
    expect(geminiEnvRefusal(stderr)).toMatch(/credential/i);
  });

  it.each([
    ['upstream code', 'status: QUOTA_EXHAUSTED'],
    ['prose form', 'You have exhausted your capacity for this model'],
    ['bare word', 'daily quota reached'],
  ])('quota cause: %s', (_name, stderr) => {
    expect(geminiEnvRefusal(stderr)).toBe('quota exhausted');
  });
});

describe('geminiEnvRefusal — a genuine break is NEVER absorbed', () => {
  it.each([
    ['our argv is wrong', 'error: unknown option `--aproval-mode`'],
    ['our binary path is wrong', 'spawn /usr/local/bin/gemini ENOENT'],
    ['the model refused the prompt', 'Response blocked by safety settings'],
    ['a plain non-zero exit with no cause', 'Gemini CLI exited 1 — '],
    ['a timeout in our transport', 'Gemini CLI timed out after 45000ms'],
    ['an empty answer', 'Gemini CLI produced no output'],
    ['a network fault', 'FetchError: request to https://generativelanguage.googleapis.com failed'],
    ['a wrong-model error', 'models/gemini-9.9-nonexistent is not found for API version v1beta'],
  ])('%s → not environmental, so the test still fails', (_name, stderr) => {
    expect(geminiEnvRefusal(stderr)).toBeNull();
  });

  it('ROUND 9: an ambient credential is IRRELEVANT — the child env is key-free by design', () => {
    // This replaces a round-8 assertion that was exactly backwards. Round 8 claimed that an ambient
    // GEMINI_API_KEY meant the CLI's "no credentials" complaint had to be OUR bug, since our own
    // buildGeminiChildEnv() would have had to drop it. Round 9 read what that function is FOR: the
    // API-key vars are in GEMINI_BILLING_ENV_VARS and are hard-deleted from the child on purpose, so
    // the CLI never runs on a metered key. Probed and confirmed — both arrive undefined in the child
    // while HOME passes through.
    //
    // So the old assertion would have FAILED this test on any box where the operator simply has the
    // key exported, which is ordinary. The weaker, true statement is that the ambient environment
    // does not enter into it at all.
    const msg = 'Gemini CLI exited 41 — you must specify the GEMINI_API_KEY environment variable.';
    expect(geminiEnvRefusal(msg)).toMatch(/credential/i);
  });

  it('an exit code alone proves nothing — only the CLI naming its cause counts', () => {
    // The tests pass stderr, never the code; this pins the reason why. `41` is the credential exit
    // TODAY, and keying on it would silently start skipping whatever gemini assigns 41 next release.
    expect(geminiEnvRefusal('41')).toBeNull();
    expect(geminiEnvRefusal('exited 41')).toBeNull();
  });

  it.each([['null', null], ['undefined', undefined], ['empty', '']])(
    '%s input is not a refusal',
    (_name, input) => {
      expect(geminiEnvRefusal(input as string | null | undefined)).toBeNull();
    },
  );
});
