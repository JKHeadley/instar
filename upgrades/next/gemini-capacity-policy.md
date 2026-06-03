<!-- bump: patch -->

## What Changed

Gemini CLI one-shot calls now have a provider-specific capacity policy. When
Gemini reports a 429, `QUOTA_EXHAUSTED`, `resource exhausted`, or a usage/quota
limit, Instar parses any reset window Gemini provides, retries only short
capacity windows once, and otherwise records a local defer window so subsequent
calls fail fast instead of spawning another doomed Gemini process.

Gemini model selection is also constrained to the verified Gemini model set
(`gemini-2.5-flash`, `gemini-2.5-pro`). Unknown raw Gemini ids now resolve back
to the verified default instead of being passed through to the CLI, which avoids
the bad `gemini-2.0-flash` fallback path that produced 404s.

The optional `capacityPolicy.fallbackModel` now changes the retry spawn itself:
both Gemini execution paths rebuild `gemini -m <model>` on retry from the
policy-selected model, so fallback configuration is not just resolved, it is
actually applied to the next CLI invocation.

## What to Tell Your User

- **Gemini quota handling is calmer:** "When Gemini says its quota is exhausted,
  I now remember the reset window and stop repeatedly poking it. Short capacity
  blips get one bounded retry; longer quota windows are surfaced as a clear
  defer instead of looking like a stalled agent."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Gemini capacity defer window | Automatic for Gemini CLI one-shot calls |
| Short Gemini capacity retry | Automatic, one bounded retry for short windows |
| Known-only Gemini model fallback | Automatic; unknown Gemini ids fall back to `gemini-2.5-flash` |

## Evidence

- `npx vitest run tests/unit/geminiCapacityPolicy.test.ts tests/unit/frameworkSessionLaunch.test.ts tests/integration/gemini-capacity-policy-integration.test.ts tests/e2e/gemini-capacity-policy-lifecycle.test.ts`
  — 4 files / 63 tests passed, including spawned retry argv assertions.
- `npx tsc --noEmit`
