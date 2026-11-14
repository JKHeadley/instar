# Job warnings say why and link to the job; app messages work without a configured owner

## What Changed
The "Scheduled job ... is not running" warning no longer fires for jobs whose start check simply answers "nothing to do" (polling jobs with an empty inbox). A real warning now says why in plain words and links to the job's page in the dashboard (runs, skips, Run now), and waits for the public link rather than send without one. Sending from the Instar app into a Telegram topic now uses the agent's one verified operator when no owner is configured, instead of refusing with "This agent has no Telegram owner to speak as."

## What to Tell Your User
You'll stop getting "this job isn't running" warnings for jobs that are fine and just had nothing to do. When one of those warnings is real, it now says what's wrong and has a link straight to the job. And if messages from the app to a Telegram conversation used to fail with "no Telegram owner", they go through now.

## Summary of New Capabilities
- Job warnings carry a direct link to the job's dashboard page.
- App-to-Telegram messages work on agents set up without an owner setting, as long as one operator is verified.

## Evidence
Tests: tests/unit/job-continuity-alert.test.ts (healthy "nothing to do" gate stays quiet; broken gate warns with plain reason and link; no link → waits), tests/integration/mobile-operator-chat.test.ts (verified-only owner delivers; no owner still refuses). Live case: Luna on the Studio, 2026-11-11, job admin-tasks-watch (gate exits 1 on an empty inbox) and the app send refused with chat-unavailable.
