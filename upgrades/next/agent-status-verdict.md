## What Changed
An agent that answers is never "can't tell" any more.
- **Unsorted notes are notes.** `GET /mobile/health-issues` no longer turns unsorted items into the verdict `unsure`. They keep the agent off "healthy", reading `running` with the headline "Running, with 2 notes I haven't sorted yet."; only a problem that affects the person raises it to `attention`.
- **`unsure` means a failed reading.** It now means only that the agent couldn't read its own health. The route answers 500 with `verdict: "unsure"`, a `reason` (`timeout`, `health-read-failed` or `summary-failed`) and a plain `detail`. An unreadable /health body summarizes to `unsure` with "I couldn't read my own health just now."
- **Dashboard Health page.** It reads `unsure` with nothing affecting the person, from an older server, as running, and says how many notes are unsorted.

## What to Tell Your User
Your agents now show "Running" when they're running, even if they have a few notes I haven't sorted yet. "Can't tell" now only means the app couldn't reach the agent, and the app says since when.

## Summary of New Capabilities
- Health verdict: running with a note count instead of "unsure" for unsorted items; `unsure` only for a failed reading, with its reason.

## Evidence
- `tests/unit/mobile-health-issues.test.ts`: unsorted notes read running with a count; an affecting problem still raises it; only an unreadable /health is unsure, with its headline.
- `tests/unit/console-health.test.ts`: an older server's unsure plus notes reads running on the dashboard.
- `tests/unit/health-choices.test.ts`: an unexplained degraded reads running, not unsure.
- `tests/integration/mobile-health-issues.test.ts`: timeout and unreadable /health answer 500 with `verdict: "unsure"` and the reason.
- 89 unit tests pass.
