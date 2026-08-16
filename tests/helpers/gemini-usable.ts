/**
 * Is the gemini CLI USABLE on this machine — not merely INSTALLED?
 *
 * WHY THIS EXISTS (2026-07-30, topic 37155). The two gemini live-CLI e2e suites
 * gated themselves on `detectGeminiPath()`, i.e. "is the binary present". On this
 * machine the binary is present and the ACCOUNT cannot authenticate:
 *
 *     Error authenticating: ProjectIdRequiredError: This account requires setting
 *     the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.
 *
 * So the gate admitted a run that could never succeed, and both suites failed for
 * a reason that has nothing to do with the code under test. That is the same
 * defect class this branch has been fixing all day: a check that measures
 * something ADJACENT to what it claims — presence standing in for usability.
 *
 * It also explains a live process defect: the cross-model convergence reviewer's
 * gemini family has produced nothing across many rounds on this machine. It was
 * read as a flaky/slow tool. It is an unauthenticated one.
 *
 * DELIBERATELY NOT A BLANKET CATCH. Only the auth-refusal signatures below count
 * as "environment, not code"; every other failure still fails the test. And a
 * skip on this path is LOUD — it prints why — because a silent skip would leave
 * "gemini verified working" and "gemini never ran" indistinguishable, which is
 * exactly the confusion this helper exists to end.
 */

/** Auth-refusal signatures: the CLI ran and declined to authenticate. */
const AUTH_REFUSAL = [
  /ProjectIdRequiredError/i,
  /GOOGLE_CLOUD_PROJECT(_ID)?\b.*env var/i,
  /Error authenticating/i,
  /Please set an Auth method/i,
  /not (?:logged in|authenticated)/i,
];

export function isGeminiAuthRefusal(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err ?? '');
  return AUTH_REFUSAL.some((re) => re.test(text));
}

/**
 * Run `body`. If it fails with an auth refusal, report it loudly and return
 * `'skipped'` so the caller can end the test without asserting; any other error
 * propagates unchanged.
 */
export async function skipIfGeminiUnauthenticated(
  body: () => Promise<void>,
): Promise<'ran' | 'skipped'> {
  try {
    await body();
    return 'ran';
  } catch (err) {
    if (!isGeminiAuthRefusal(err)) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      '[gemini-e2e] SKIPPED — the gemini CLI is installed but NOT AUTHENTICATED on ' +
      'this machine, so the live one-shot cannot run. This is an environment state, ' +
      'not a code failure — and it is the same state that makes the cross-model ' +
      'reviewer\'s gemini family silent. Reason: ' +
      (err instanceof Error ? err.message.split('\n')[0] : String(err)),
    );
    return 'skipped';
  }
}
