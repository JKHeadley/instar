# Worktree checker: one scan at a time — Plain-English Overview

> The one-line version: the worktree checker inside every agent server no longer starts a new scan while the previous one is still running; late callers share the running scan's answer.

## The problem in one breath

Every agent server runs a "worktree checker" every 5 minutes and again each time a session ends. For each working copy of the code it asks git two questions. On the Mac Studio there are 345 working copies, so one scan takes longer than 5 minutes when the machine is busy, and new scans start before the old ones finish. On 2026-11-17 we saw about three scans running at once in the Echo server, each spawning git processes in a burst. Together with a second server doing the same, git used about one and a half cores of a machine already at load 40 on 16 cores.

## What already exists

- **The worktree checker** — lists working copies, counts commits not yet on main, lists changed files, and finds abandoned branches. It only reports; it never deletes anything.
- **The 5-minute timer and the session-end hook** — the two things that start a scan. Neither knew whether a scan was already running.

## What this adds

If a scan is already running, a new request waits for that scan and gets its result instead of starting another. When the scan finishes (or fails), the next request starts a fresh one. Nothing else changes: same questions to git, same reports, same alerts.

## The new pieces

- **A "scan in progress" slot** — holds the running scan. It is cleared when the scan ends, including when it fails, so a failure can never block later scans.

## The safeguards

**Cannot hide a newer state for long.** A caller that arrives mid-scan gets a report that is at most one scan old; the next call after it finishes always scans fresh.

**Cannot get stuck.** The slot is cleared in a `finally`, so an error in git or in the scan frees it. A test covers a failing scan followed by a successful one.

**No new authority.** The checker still only reports. No blocking, no deletion, no new settings.

## What ships when

One small change to one file, with two new unit tests. It reaches every agent on the next release; no migration or config is needed.

## What you actually need to decide

Nothing: this is a Tier-1 load fix that a revert fully undoes.
