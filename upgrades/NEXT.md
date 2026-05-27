# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — Stage-B auto-capture (§19.2).** Building on the issue
ledger shipped last release, this adds the *write path*: a single atomic `captureRun()` entry
point that the mentor tick will call after observing a framework, plus a **capture funnel** that
logs **every** run — including runs that found nothing. That funnel is the structural guard
against a silent, broken writer: because a zero-finding run is still recorded as a run, "ran and
found nothing" is always distinguishable from "never ran / writer is dead." Regression candidates
(a new issue matching a previously-fixed one) are *surfaced for review, never auto-linked* — the
writer doesn't get to decide a regression.

A new read-only route `GET /framework-issues/capture-stats` exposes the funnel (runs vs
observations written, broken down per framework). Still observability-only — nothing gates, and
there is no production caller yet (the mentor job that calls `captureRun` ships in a later staged
PR), so this is dormant infrastructure with full test coverage.

## What to Tell Your User

- The "notebook" now has a guaranteed *hand that writes* — whatever I notice while inspecting a
  framework gets recorded automatically, and there's a visible counter so a broken writer can't
  hide by looking quiet.
- Nothing changes in your day-to-day yet; it's the next layer of a system that's still rolling
  out gradually and stays off by default.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stage-B auto-capture | `FrameworkIssueLedger.captureRun({ framework, tickId, findings })` — one atomic call the mentor tick makes; writes findings + logs the run |
| Capture funnel | `curl -H "Authorization: Bearer $AUTH" http://localhost:<port>/framework-issues/capture-stats` — runs vs observations written, per framework (inert-writer guard) |

## Evidence

Net-new feature, not a bug fix — no prior failure to reproduce. Behavior is verified by tests:
the inert-writer guard is proven by a unit test asserting a **zero-finding `captureRun` still
increments the funnel's run count while observations stay at 0** (so "ran, found nothing" ≠ "never
ran"), and a Tier-3 e2e boots the real server, runs a capture against the live ledger, and confirms
`GET /framework-issues/capture-stats` reflects both the run and the written observation. 46 feature
tests + 299 capability tests green; affected push-config suite (842) green vs canonical main.
