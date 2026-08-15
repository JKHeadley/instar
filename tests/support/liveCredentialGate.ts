/**
 * Test support — "is this external CLI USABLE here?", not "does the file exist?"
 *
 * ROUND-17 (2026-08-15). Three live-canary tests gated on binary PRESENCE:
 *
 *     const haveGemini = !!detectGeminiPath();
 *     it.skipIf(!haveGemini)(...)
 *
 * Presence is not usability. Gemini is INSTALLED on this dev machine and has no
 * key configured, so the gate said "available", the test ran for real, and it
 * hard-failed on an auth error rather than on anything it was written to catch.
 * The codex canary shares the gate and passes only because that CLI happens to
 * be signed in — one revoked credential from the same failure.
 *
 * This is the same shape as a resolver that always returns a path, so its
 * `if (!path)` gate is unreachable (found the same night, in shipped code): a
 * cheap proxy standing in for the question actually being asked.
 *
 * WHY NOT just widen the skip to "skip when it doesn't work": because then a
 * GENUINE regression — the tool answering wrongly, timing out, or crashing —
 * would skip too, and the test would fall silent exactly when it matters. That
 * is trading a red suite for a blind one.
 *
 * So the rule is narrow: skip ONLY on the specific signature of an absent or
 * unconfigured credential, say so out loud, and let every other failure fail.
 * A test that cannot run must never render the same as one that ran and passed
 * — and it must not render the same as one that ran and FAILED either.
 */

/**
 * Does this error mean "no credential configured" rather than "the tool is
 * broken or wrong"?
 *
 * Deliberately per-CLI and deliberately narrow. A generic matcher over words
 * like "auth" would swallow real failures — an auth REGRESSION is exactly the
 * thing these canaries exist to catch.
 */
export function isUnconfiguredCredentialError(
  cli: 'gemini' | 'codex' | 'grok',
  err: unknown,
): boolean {
  const message = err instanceof Error ? err.message : String(err);
  switch (cli) {
    case 'gemini':
      // Observed verbatim 2026-08-15: `Gemini CLI exited 41 — When using
      // Gemini API, you must specify the GEMINI_API_KEY environment variable.`
      // Both halves required: the exit code alone could be a future reuse, and
      // the phrase alone could appear in unrelated output.
      return /exited 41\b/.test(message) && /GEMINI_API_KEY/.test(message);
    case 'codex':
      return /not logged in|run `?codex login`?|no credentials found/i.test(message);
    case 'grok':
      // The adapter already refuses metered keys BEFORE spawning, so an
      // unauthenticated grok surfaces as its own named policy error rather
      // than a CLI message.
      return /grok-auth-(expired|missing)|no grok session/i.test(message);
  }
}

/**
 * Announce a skip so it is visible in the run. A silent skip is how a test
 * stops existing without anyone noticing — the failure mode this whole module
 * exists to avoid, one step removed.
 */
export function announceCredentialSkip(cli: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[live-canary] SKIPPED — ${cli} is installed but has no usable credential on this host. `
      + `This is an ENVIRONMENT gap, not a passing test: the canary did not run. `
      + `Signature: ${message.split('\n')[0]}`,
  );
}

/**
 * The SPAWN-result shape of the same question.
 *
 * Round-17: the first draft of this module only matched a THROWN error, which
 * covered `gemini-cli-alive-lifecycle` (the provider throws) and would have
 * silently missed `gemini-setup-narrative-lifecycle` — that one calls
 * `spawnGeminiAndWait`, which RESOLVES with `{ exitCode, stderr }` and never
 * throws. A fix covering one of the two failing tests, shipped as if it covered
 * both, is the same partial-coverage defect this whole round has been about;
 * caught by reading the transport instead of assuming both paths fail alike.
 *
 * The host file already uses this idiom — it inspects `exitCode === 126` with
 * an asdf signature and retries — so this matches the surrounding code rather
 * than introducing a new convention.
 */
export function isUnconfiguredCredentialResult(
  cli: 'gemini' | 'codex' | 'grok',
  result: { exitCode: number | null; stderr: string },
): boolean {
  return isUnconfiguredCredentialError(cli, new Error(
    `exited ${result.exitCode} — ${result.stderr}`,
  ));
}
