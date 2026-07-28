# Transcript-audit artifact gate - ELI16

> The one-line version: an apprenticeship cycle that drove the mentee through the real Telegram UX now refuses to be recorded unless the objective post-drive transcript audit actually ran — and the CLI learned to read a transcript that lives on another agent's server.

## The problem in one breath

PR #864 shipped a great observation tool: a judgment-free auditor that scans the real drive transcript for UX antipatterns (duplicate notices, resend asks, infra noise, content-free updates) and files each finding durably. But it shipped as a manual CLI — nothing anywhere made it RUN. The constitution article ratified the same day ("Observation Needs Structure", PR #861) says exactly why that's a trap: a responsibility to observe is a wish unless an unskippable artifact proves the looking happened. An auditor nobody is forced to run is that same wish, one level up. We had built the eyes and left them optional.

## What already exists

- **The operator-seat UX gate (PR #856)** — cycle records refuse to exist without the mentor's SUBJECTIVE seat-counts (dupNotices, asksOfUser, …).
- **The post-drive transcript auditor (PR #864)** — the OBJECTIVE half: regex classifiers over the real transcript, findings filed to the framework ledger with stable dedupe keys.
- **The framework issue ledger** — durable issue records keyed by (framework, dedupKey).

## What this adds

A `telegram-playwright` cycle — the channel whose entire point is experiencing the mentee's real UX — now requires a `transcriptAudit` block at record time: which topics were audited, the drive window, the report's per-category counts, every finding's dedup key, and an honesty declaration of WHERE the findings were filed (`local` / `remote` / `dry-run` / `failed`). No block, no record — the refusal error teaches the exact CLI command that produces the artifact. Other channels accept the block optionally (and validate it when supplied).

## The new pieces

- **The store gate** — `record()` validates the block's full shape with self-describing refusals, channel-dependent: required on `telegram-playwright`, optional elsewhere. Legacy rows read honestly as `transcriptAudit: null`, exactly like the two prior column migrations.
- **The anti-fabrication tooth** — a block declaring `ledger: 'local'` with filed findings is cross-checked at the route against the REAL framework ledger: if none of the claimed dedup keys exist there, the record is refused. You can't satisfy the gate by describing an audit that never happened. Remote/dry-run/failed declarations are accepted as declared — the declaration itself stays queryable, so meta-analysis can see how often audits actually file vs. dry-run.
- **`--history-base-url` on the auditor CLI** — the drive transcript usually lives on the MENTEE's server (the mentor drives through the shared Playwright seat, so the mentee's bot records the messages). The CLI can now read history from that server (auth via `INSTAR_HISTORY_AUTH_TOKEN`) while still filing findings into the auditing agent's OWN ledger. Without this, the canonical cross-agent flow was impossible and "remote" would have been the only honest declaration forever.

## The safeguards

**The local token never leaks to a remote server.** When the history read goes remote and no remote token is provided, the CLI sends NO auth header rather than the local one.

**Honest degradation, never silent.** No ledger wired on the recording server → the cross-check skips (the declaration is still stored). Corrupt stored blocks degrade to `null` on read instead of bricking history.

**Grandfathering preserved.** Pre-gate rows migrate via the same idempotent ALTER pattern as `channel` and `operatorSeatUx` — nothing retroactively breaks, nothing un-fires an earned keystone.

**Teaching surfaces updated everywhere.** The mentor's standing orders (step 5), the CLAUDE.md template, and a targeted PostUpdateMigrator line-rewrite for agents that already carry the apprenticeship section — so deployed agents learn the new shape on their next update instead of hitting mystery 400s.

## What does NOT change

The gate never runs the audit FOR you (the transcript may live on a server this one can't reach) — it refuses to pretend the audit happened. Recording on other channels, the SLA monitor, role coverage, and every existing read surface behave exactly as before.
