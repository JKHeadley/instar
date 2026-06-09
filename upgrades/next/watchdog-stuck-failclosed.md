<!-- bump: patch -->

## What Changed

Makes the SessionWatchdog's stuck-command escalation **fail CLOSED** instead of fail-open when its LLM "stuck vs legitimate" judge can't run. The watchdog flags a shell command as a candidate after 3 minutes, asks an LLM whether it's genuinely stuck or a legitimate long-running task (build/test/install), and only then sends `Ctrl+C`. Previously, when that judge was UNAVAILABLE (no provider) or ERRORED (rate-limited / circuit-open / timeout — common under load), `isCommandStuck` returned `true` (fail-open) → it Ctrl+C'd **every** command past the 3-minute threshold, interrupting legitimate test suites, builds, and `docs-coverage.mjs` runs (the session shows *"Interrupted · What should Claude do instead?"*). Now: when the judge can't run, the watchdog does NOT interrupt below a deterministic hard ceiling (`monitoring.watchdog.hardCeilingSec`, default **1800s / 30 min**); it only escalates once a command has run past that ceiling — so a genuinely hung command (e.g. `crontab -` waiting on stdin forever) is still recovered deterministically without any LLM. A ceiling of `0` disables it (pure fail-closed — never interrupt without a positive LLM "stuck" verdict). The stdin-consumer fail-closed guard and the positive-LLM-verdict path are unchanged. This is the "No Silent Degradation to Brittle Fallback" standard applied to a destructive action.

## What to Tell Your User

If you saw sessions get interrupted "out of nowhere" — a command suddenly stopping with *"Interrupted · What should Claude do instead?"* — that was my stuck-command watchdog misfiring. It Ctrl+C's commands it thinks are hung, using an AI check to spare legitimate long builds/tests; but when that check couldn't run (which happens exactly when the machine is busy), it assumed the worst and interrupted everything over 3 minutes. Now it does the safe thing instead: if it can't confirm a command is actually stuck, it leaves it alone — and only force-stops something that's been frozen for a very long time (30 min by default) with no other way to tell. So your real work stops getting killed, while a truly hung command is still recovered.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Watchdog fails closed when its stuck-judge is unavailable | automatic — no config needed |
| Tune/disable the deterministic hard ceiling | set `monitoring.watchdog.hardCeilingSec` (default 1800; `0` disables) |

## Evidence

Reproduction (live, from this agent's `logs/server.log`, 2026-06-09): repeated `[Watchdog] "<session>": stuck command (190s) … — sending Ctrl+C` / `(230s)` entries on legitimate autonomous work, plus the user's screenshot of a session interrupted mid-`docs-coverage.mjs --check`. These coincide with the machine under load (LLM circuit open / rate-limited), i.e. the fail-open path: `isCommandStuck` returned `true` because the judge couldn't run.

After the fix: new unit suite `tests/unit/SessionWatchdog-failclosed.test.ts` (8 tests) pins both sides — judge unavailable/erroring below the ceiling → no interrupt; past the ceiling → interrupt; ceiling 0 → never interrupt; LLM "legitimate"/"stuck" verdicts honored unchanged. `tests/unit/SessionWatchdog-pipeline.test.ts` updated (the test that asserted the old fail-open now asserts fail-closed, plus past-ceiling and LLM-confirmed-stuck cases). All 175 watchdog/triage unit tests green; `tsc` + repo lint clean.
