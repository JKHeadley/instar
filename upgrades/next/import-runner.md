<!-- bump: patch -->

## What Changed

The migration readiness checker gained the piece that makes its data-integrity
condition achievable: an end-to-end import runner, plus a safe "rehearsal" mode.
Until now the readiness surface could only WAIT for an import integrity report
that nothing could produce. Agents can now trigger a server-side rehearsal that
fetches the real live data, imports it into a throwaway in-memory copy exactly
as the real migration would, and verifies every row survived bit-for-bit —
without writing anything durable. The rehearsal's verdict is visible in the
readiness status, clearly separated from the real thing: only the REAL import
(still credentials-gated) can ever satisfy the readiness condition.

Also closed a small logging gap found live: a timed-out page download that
aborted while reading the response body now produces the same clear "page N
timed out" failure as one that aborted while connecting.

## Evidence

The runner's verification is observation-based: the integrity gate runs over
what the target READS BACK, not what was sent — unit tests prove a target that
silently mangles, drops, or invents rows is caught (checksum-differs /
missing-in-target / extra-in-target respectively). The readiness-honesty rule is
structural, not conventional: the constructor refuses wiring the rehearsal
report onto the canonical integrity path, and a passing rehearsal leaves
`ready: false` with the canonical report absent (asserted at unit, integration,
and E2E tiers — 35 new tests, all green). The body-read classification gap was
reproduced from a live failure log (2026-06-05 11:01Z: raw "operation was
aborted" with no page context) and is covered by a dedicated unit test.

## What to Tell Your User

If your agent is driving a data migration, it can now prove the import pipeline
works against today's real data — a full rehearsal with zero risk — before
anyone flips anything. The readiness status shows the rehearsal result
separately from the real import, so "ready" still means exactly what it meant.

## Summary of New Capabilities

- `POST /cutover-readiness/import-dryrun` — trigger a server-side import
  rehearsal (live fetch → in-memory AS-IS import → per-row integrity gate);
  zero durable data writes; never greens the canonical integrity condition.
- `GET /cutover-readiness/import-dryrun` — the last rehearsal's verdict.
- `GET /cutover-readiness` now includes an informational `importDryRun` leg.
- Maturity: stable for the rehearsal path; the REAL import awaits the
  credentials-gated database adapter (it reuses this same runner).
