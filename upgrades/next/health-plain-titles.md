## What Changed
Every health problem that has no hand-written entry yet now gets its own plain title, instead of all reading "Something inside me used a backup path".
- **Known parts** (about 35 subsystems) map to a fixed title, for example "Feedback fixes are waiting" or "I pressed Enter for a stuck session".
- **Otherwise** the reporter's own one-line impact becomes the title, but only when it is already short plain words.
- **Otherwise** the title names the part in plain words: "Something in my … used a backup path".
- **No duplicate titles.** No two different rows share a title: a later one gets its own part or a number.

The "In the agent's words" text for these rows is now written for a person:
- the "Using … in the meantime — everything else is working fine" tail is dropped;
- a known part's own plain words replace internal ones;
- anything still carrying code names (such as `verifyInjection`, "sentinel" or "tick") is left out.

The "I haven't sorted this one yet" line stays. This is deterministic: no model call. The phone and the dashboard both read it from `GET /mobile/health-issues`.

## What to Tell Your User
The health list now says what each unsorted problem is about, in plain words, so two different problems no longer look like the same one.

## Summary of New Capabilities
- Each health problem has its own plain title and no internal jargon in its details.

## Evidence
`tests/unit/mobile-health-issues.test.ts` covers:
- Justin's two rows from 2026-11-06 22:49 (feedback fixes, and the stuck-session Enter), each with its own title and plain words;
- an unknown part named in plain words;
- a plain impact line used as a title;
- a code-shaped impact never used as a title;
- the "Using … in the meantime" tail dropped;
- unique titles, with Ask matching each title;
- secrets and local paths scrubbed before the plain-words check.

`tests/unit/console-health.test.ts` and `tests/unit/health-choices.test.ts` are unchanged and pass (89 in all).
