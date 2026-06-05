# ELI16 — Every pull request must explain itself in plain English, in the description

## In plain English

When someone opens a pull request (a proposed code change) and sends you the link, the first thing
you see and read is the PR's DESCRIPTION. That's what you actually approve. But our PRs have been
written in all different styles, and some don't include a plain-English summary at all — so the
reviewer has to read raw code diffs to figure out what's going on.

## What's new

This adds an automatic check that runs on every pull request. It reads the PR's description and
looks for a short "ELI16" section — an explain-it-like-I'm-16 overview of the change. If the
description doesn't have one (or only has a throwaway one line), the check fails and tells the author
exactly what to add. The author edits the description, and the check re-runs and clears on its own —
no new code push needed.

We already required an ELI16 *file* alongside specs; this closes the gap by also requiring the
overview in the PR description itself, where the reviewer actually reads it. The result: every PR
now leads with a human-readable summary, in a consistent format across everyone.

## Why it's safe

The check only ever looks at the PR description text — it can't touch the code, the build, or the
release. The automated release PRs and bot PRs are exempt (no human reads an ELI16 there). The
decision logic is a small pure function with thorough tests on both the "has a good overview → pass"
and "missing/too-short → fail" sides, plus all the exemptions — so it won't accidentally block a PR
that genuinely has its overview. And a failing check is loud and self-clears the moment the
description is fixed, so it can never silently jam anything.
