# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Framework-Onboarding Mentor System — the issue ledger (foundation).** This is the first
piece of a larger system that teaches new agent frameworks (Codex now; Cursor / Aider / Gemini
later) how to behave well on Instar, and saves every lesson so the next framework onboards
faster. This release ships the durable, two-table SQLite **issue ledger** that records
behavioral issues observed during onboarding — one canonical row per distinct root cause, plus
per-occurrence evidence — and two read-only HTTP routes to query it. Recurrence is counted in
distinct *episodes* (not raw ticks) and materialized so the onboarding playbook ranks by
"how badly it hurts × how often it happens" without an expensive read-time scan.

It is **observability only** — the ledger never gates a job, blocks a message, or constrains a
session. Evidence is stored as opaque references (path+line, log ref, PR#), secret-scanned at
capture, never inlined log text. The full mentor loop (the scheduled job that drives the
mentee, auto-captures issues, and tracks graduation) ships staged in later releases; this PR is
the foundation everything else stands on.

## What to Tell Your User

- I now keep a structured, durable notebook of the real-world problems a new AI engine hits
  when it's learning to run on Instar — bucketed by whether it's the engine's own limit, an
  Instar integration gap, or a one-off mistake.
- Only the first two kinds travel forward as a reusable "here's what bit the last engine, check
  these first" checklist — so each new engine we add onboards faster than the last.
- This is plumbing for a bigger mentoring system that's still rolling out gradually; nothing
  changes in your day-to-day yet, and it never blocks anything.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Framework issue ledger | `curl -H "Authorization: Bearer $AUTH" http://localhost:<port>/framework-issues` (read-only; optional `?framework=&bucket=&status=&limit=`) |
| Onboarding playbook | `curl -H "Authorization: Bearer $AUTH" "http://localhost:<port>/framework-issues/playbook?targetFramework=X"` — generalizable lessons from PRIOR frameworks, impact-ranked |
| Auto-created on update | The ledger's SQLite DB auto-creates under `server-data/` on first boot — no migration step |
