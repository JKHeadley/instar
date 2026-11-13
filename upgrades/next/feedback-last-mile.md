## What Changed

The Claude reviewer started from the server now gets the same account a new session would get from the subscription pool, when the agent has no configured sign-in key. Before this, each such call answered "Not logged in", so no feedback fix could pass its review on that machine. A configured key or a login already set on the process still wins, and with no account that has room the review stays refused. This needs Telegram or Slack to be connected, and session pinning on or at least two usable pool accounts; otherwise the reviewer uses the default login, as sessions do.

A degraded reviewer's reason now appears in the audit log and in the text a retry reads. Two review rules changed. Rule 3 still covers credentials in any file and new reach in shipped code. For tests it now names what counts: network, home-directory or credential paths, dynamic code, shelling out to anything but git or node on the test's own temporary folder, and writing or deleting outside that folder. Rule 5 still refuses steering of the review and any guidance telling an agent to run a command, contact a host, handle a secret, bypass a check, suppress a report or trust a source. It no longer refuses test input, plain feature documentation or review records that address nobody.

The feedback executor now merges with the installed package's safe-merge script instead of the copy in the agent's source checkout, which can be out of date. Safe-merge ignores Vercel's "Authorization required to deploy" status on a verified fork PR when every Vercel status on the head is that refusal, because nothing was built. A real Vercel failure, or a GitHub Actions job named Vercel, still refuses. The docs coverage check passes again: one more command is documented.

The executor's secret check now holds a modified file only for a credential-shaped value the original lacks. Before, any match in the file held it, and 440 files in this repository match as they stand. An added file, a missing original or a binary file still holds on any match. The check's text windows now overlap by 16 KB, so a key block across a window boundary is seen whole. Fixes already on hold stay on hold.

## Evidence

Reproduction, 2026-11-07 on the operated Studio: the executor's Claude reviewer call, run with the server's own environment and settings, answered "Not logged in" every time, while a pool session on the same machine signed in. With the pool account handed to the child, the same call returned a verdict. Before: every worker fix reached review and the Claude reviewer reported degraded. After (unit level, tests/unit/claudeReviewerLogin.test.ts): the child gets the pool account's config home when no key or process login is set, and stays refused when no account has room.

Secret check, same day: 440 files in this repository already match the credential pattern, so any worker fix touching one was held (7 fixes held as needs-review-secret-shape). The new check holds only a value the original file lacks; tests/unit/feedback-factory/execute-units.test.ts covers a pre-existing match (not held), a new value (held), and an added or unreadable file (held).

## What to Tell Your User

Automated fixes could not pass their final review on machines where every Claude login lives in the account pool. They can get that review now. Two rules that wrongly refused normal test cleanup were corrected, and other things that stopped a finished fix from reaching a merge were fixed. Automated fixes still have to pass the review and the checks.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Claude reviewer on pool-only machines | Automatic |
| Automated fixes merge with the installed merge script | Automatic |
