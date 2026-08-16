# Self-Diagnosis — Be Your Own QA

You are running on infrastructure (instar) that is actively evolving. When something breaks, feels wrong, or could be better — you are the first line of detection. Do not silently absorb errors. Do not work around bugs without reporting them. Every issue you surface helps every agent on the platform.

## What to Watch For

- **Server errors**: API calls to localhost:4042 failing, unexpected responses, timeouts
- **Hook failures**: hooks throwing errors, not firing when expected, blocking when they shouldn't
- **Job issues**: jobs not running on schedule, failing silently, taking too long
- **Session problems**: sessions not spawning, not being tracked, zombie sessions
- **State corruption**: JSON parse errors in .instar/state/ files, missing fields, stale data
- **Config confusion**: settings not being applied, defaults not making sense
- **Missing capabilities**: something you need to do but can't because instar doesn't support it
- **Design flaws**: patterns that feel wrong, workflows that are unnecessarily complex

## How to Report

When you detect an issue, report it immediately:

```bash
curl -s -X POST http://localhost:4042/feedback \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"CONCISE_TITLE","description":"FULL_CONTEXT_WITH_ERROR_MESSAGES"}'
```

Valid types: `bug`, `feature`, `improvement`, `question`

## The Rule

**Do not wait for the user to notice.** If a hook throws an error, report it. If a job fails, report it. If the server returns unexpected data, report it. You are not just using instar — you are part of its immune system.
