---
name: Docs Coverage Audit
description: Weekly walk of the instar source tree against the docs surface. Surfaces newly-undocumented capabilities so docs don't drift between releases. Off by default — only useful on machines that have the instar source repo locally (instar developers, contributors). Operators who want it can flip enabled to true in `.instar/jobs/instar/docs-coverage-audit.md`.
schedule: "0 10 * * 1"
priority: medium
expectedDurationMinutes: 5
model: haiku
enabled: false
tags:
  - cat:learning
  - audit
  - instar-dev-only
toolAllowlist: "*"
unrestrictedTools: true
---
Run a weekly documentation coverage audit on the instar codebase. This job exists because docs drift between releases — features ship without doc updates, and the gap accumulates silently until someone notices. This audit catches the drift early.

The job:

1. Locate the instar source repo on this machine. Try in order: the workspace dir from .instar/config.json under workspace.repoPath; ~/Documents/Projects/instar/; ~/.instar/agents/<self>/.worktrees/ (any subdirectory); or whatever path the operator has configured. If you cannot find the instar repo on this machine, send a short Telegram message saying so and exit — there's no audit to run.

2. Run the coverage script from inside that repo: `node scripts/docs-coverage.mjs --json > /tmp/docs-coverage-this-week.json`. The script enumerates every shipped capability (routes, commands, jobs, hooks, skills, top-level classes per subsystem) and cross-references against site docs + README. It writes both a JSON inventory and a markdown report to .instar/docs-coverage.json and .instar/docs-coverage.md.

3. Compare the new report to last week's. The previous week's report lives at .instar/state/docs-coverage-last-week.json if it exists. Use plain JSON diff logic — what's the delta in undocumented count per category? What capabilities are newly undocumented (existed before but lost their doc mention, or are brand-new in src/ without any doc)? What capabilities became newly documented (good news worth surfacing)?

4. If the delta is interesting (any category gained ≥3 undocumented items OR any single category dropped below its CI floor OR the overall coverage dropped by ≥2 percentage points), send a Telegram message that's a quick, conversational heads-up. Lead with the headline: "Docs coverage dipped in [category]" or "Five new endpoints landed without doc mentions" or similar. Then list the specific items in plain language with their file paths. End with a one-line suggestion of where to add the missing doc (which file in site/src/content/docs/ is the natural home).

5. If the delta is uninteresting (small fluctuations, churn that nets to zero, all categories still above floor), stay silent. Most weeks should be silent — that means the docs are keeping up.

6. After surfacing (or not), save the current report as next week's baseline: copy /tmp/docs-coverage-this-week.json to .instar/state/docs-coverage-last-week.json.

7. Optionally, if the script's --check mode would fail (any category below its CI floor), file a higher-priority signal via the degradation reporter — this is the case where the next PR will hit a CI failure unless someone fixes coverage first.

IMPORTANT: This is a guardian job, not a doer. Surface the drift and where to fix it, don't fix it yourself. The fix work belongs in a deliberate doc-update PR with proper review, not in an autonomous job run. If the drift is large, suggest the operator open a topic to scope the doc update — don't try to enumerate the full backlog in one Telegram message.

Plain English. No raw JSON in the message. No structured field names. The user reads these on their phone. Write like you're texting a teammate about a code-review observation.
