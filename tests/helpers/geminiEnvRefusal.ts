/**
 * Did the gemini CLI refuse for an ENVIRONMENTAL reason — one that says nothing about our code?
 *
 * WHY THIS EXISTS. The two live-gemini E2Es gate on `haveGemini = !!detectGeminiPath()`, which asks
 * whether the BINARY IS INSTALLED. That is not the precondition they need: an installed-but-
 * uncredentialed CLI exits before it ever processes our prompt, so the assertion downstream can
 * neither pass nor meaningfully fail — it only reports that this box is not logged in.
 *
 * Measured 2026-08-14: a full-suite run was red on exactly this. `gemini` was on PATH, so both
 * tests ran, and both died with `exited 41 — you must specify the GEMINI_API_KEY environment
 * variable`. CI stays green only by accident (no binary installed there ⇒ clean skip); the box that
 * has gemini installed is the one that goes red.
 *
 * WHY A NARROW POST-HOC MATCH RATHER THAN A PREFLIGHT. The tempting fix is a live preflight ("can
 * this box complete any one-shot?") because it collapses every environmental cause into one
 * predicate instead of a growing list. It is the wrong trade here: a preflight skips on ANY failure,
 * including a transient one, so a real regression on a flaky afternoon disappears silently. Matching
 * the CLI's OWN NAMED refusal skips only for causes it explicitly reported and lets everything else
 * fail loudly. Between a false red (visible, diagnosable, blocks a push) and a silent skip (invisible),
 * the silent skip is the worse error.
 *
 * WHY IT IS SHARED. This is the third environmental cause handled in these tests — the file already
 * carried hatches for an asdf version miss and for quota exhaustion. Three patches to one guard is
 * the point at which the list stops being maintainable in two places at once, so the CLASSIFICATION
 * lives here, once, and the tests decide what to do with the answer.
 *
 * NEVER match on exit code alone. A non-zero exit is exactly what a genuine break in our argv
 * building or transport looks like; only the CLI naming its own cause is evidence of an
 * environmental refusal.
 */

/**
 * Causes the CLI reports about ITS OWN configuration, never about our request.
 *
 * ROUND 9 — A CARVE-OUT WITHDRAWN, BECAUSE IT FIRED ON CORRECT BEHAVIOUR.
 *
 * Round 8 added a condition here: treat "no credentials" as OUR bug whenever the ambient
 * environment holds a `GEMINI_API_KEY`, reasoning that `buildGeminiChildEnv()` is our code, so a
 * dropped credential would be our regression. That reasoning never read what the function is FOR.
 *
 * Measured: `GEMINI_API_KEY` and `GOOGLE_API_KEY` are in `GEMINI_BILLING_ENV_VARS` and are
 * HARD-DELETED from the child env — deliberately, so the CLI can never run on a metered key
 * ("Never billed"). The allowlist says so explicitly: "benign — model/dir overrides, NOT keys". A
 * probe confirms both arrive `undefined` in the child while HOME passes through.
 *
 * So the carve-out inverted its own purpose. On any box where the operator has the key exported —
 * an ordinary thing to have — the child correctly has none, the CLI correctly complains, and the
 * carve-out would have FAILED the test on specified behaviour. Withdrawn: the credential cause is
 * environmental, full stop, because the child is designed to have no key and "no key" is therefore
 * the expected state rather than evidence of anything.
 *
 * RESIDUAL, stated rather than guarded: the CLI authenticates via cached OAuth credentials it finds
 * under HOME/XDG_CONFIG_HOME. If the allowlist ever regressed and dropped those, the CLI would emit
 * this same "no credentials" message and this classifier would skip — hiding a real break. A guard
 * for that would check the child env still carries the vars the OAuth path needs, NOT the API-key
 * vars, which are irrelevant to it. Not built: it guards a hypothetical regression, and this file
 * has now twice demonstrated what speculative tightening costs.
 */
const ENVIRONMENTAL_REFUSALS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'no credentials configured (the child env is key-free by design; OAuth creds absent)',
    pattern:
      /must specify the (?:GEMINI|GOOGLE)_API_KEY|(?:GEMINI|GOOGLE)_API_KEY environment variable|please (?:set|select) an auth method|not authenticated|no auth method/i,
  },
  {
    reason: 'quota exhausted',
    pattern: /QUOTA_EXHAUSTED|exhausted your capacity|\bquota\b/i,
  },
  {
    // A Workspace / Google-Cloud-Assist account that refuses before it reads the
    // prompt because it needs a project id in the environment. Same class as the
    // two above and the same reasoning: the CLI has declined on its OWN
    // configuration, so there is nothing here to assert about instar's code.
    // Missing from this list until 2026-08-16, which made an unrelated red on
    // every machine whose gemini login happens to be a Workspace account.
    reason: 'account needs a Google Cloud project id in the environment (GOOGLE_CLOUD_PROJECT); the child env is key-free by design',
    pattern: /ProjectIdRequiredError|GOOGLE_CLOUD_PROJECT(?:_ID)?\s+env|setting the GOOGLE_CLOUD_PROJECT/i,
  },
];

/**
 * @param text stderr, or a thrown provider error message (the provider embeds the CLI's stderr).
 * @returns a human-readable reason when the CLI named an environmental cause, else null.
 */
export function geminiEnvRefusal(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { reason, pattern } of ENVIRONMENTAL_REFUSALS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}
