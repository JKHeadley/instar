# Side-Effects Review - apprenticeship transcript-audit gate

**Version / slug:** `apprenticeship-transcript-audit-gate`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Makes the post-drive transcript audit (PR #864) structurally unskippable on the channel it was built for: `telegram-playwright` apprenticeship cycles now refuse to record without a validated `transcriptAudit` block. Adds a route-level anti-fabrication cross-check for `ledger:'local'` claims, a `--history-base-url` split on the auditor CLI so the cross-agent flow (read mentee's transcript, file to own ledger) actually works, and updates every teaching surface (mentor standing orders, CLAUDE.md template, targeted migrator line-rewrite).

## Decision-point inventory

- `validateTranscriptAudit` (store) - add - refuses telegram-playwright cycles without the artifact; validates shape on any channel when supplied.
- `POST /apprenticeship/cycles` (route) - modify - cross-checks `ledger:'local'` claimed dedup keys against the real FrameworkIssueLedger; refuses fabricated claims.
- `FrameworkIssueLedger.hasDedupKey` - add - read-only existence probe, no new write authority.
- `runPostDriveTranscriptAuditCli` - modify - splits history reads (possibly remote) from ledger writes (always local).
- `PostUpdateMigrator` cycle-line rewrite - add - idempotent CLAUDE.md text patch.

## 1. Over-block

The gate refuses telegram-playwright cycle records lacking the audit block. Risk: a mentor who genuinely CANNOT run the audit (mentee server down, history route unavailable) is blocked from recording the cycle. Mitigation: the `ledger:'failed'` declaration exists precisely for this — run the auditor, let it fail, declare `failed` with the reason in `notes`, and the record is accepted honestly. The refusal message teaches the producing CLI including the cross-agent flag. The cross-check can also over-block if an agent files findings locally and the ledger write genuinely succeeded but into a DIFFERENT framework value — the check is framework-agnostic (any framework's dedup key counts), which minimizes this.

## 2. Under-block

Fabrication remains possible for `remote` / `dry-run` / `failed` declarations — the route cannot verify another server's ledger without cross-agent auth machinery (out of scope for this slice). Accepted deliberately: the declaration is durably recorded and queryable, so a pattern of suspicious declarations is itself visible to meta-analysis. The operatorSeatUx block has the same trust model. A future slice can verify `remote` claims over Threadline.

## 3. Level-of-abstraction fit

The shape gate lives in the store (single writer, same place as the operatorSeatUx gate — the two halves of the same observation record). The ledger cross-check lives in the route because only the route has the FrameworkIssueLedger dependency; the store stays persistence-only. The CLI split is read-side only; the write path is untouched.

## 4. Blast radius

- New column `transcript_audit_json` via the established idempotent ALTER pattern; legacy rows read as null. No data rewrite.
- One existing caller class affected: mentor sessions recording telegram-playwright cycles over HTTP. They get a teaching 400 until they supply the block — this is the designed behavior (same rollout shape as #856, which the mentor loop absorbed same-day). Standing orders updated in the same PR so newly-spawned mentor sessions know before they hit it.
- Non-telegram-playwright callers: zero behavior change unless they supply a malformed block (which previously would have been silently ignored — now validated).
- The CLI defaults preserve #864 single-server behavior byte-for-byte when `--history-base-url` is omitted.

## 5. Failure modes

- Remote history server unreachable → auditor CLI errors per-topic read; mentor declares `ledger:'failed'`. No silent skip.
- No FrameworkIssueLedger on the recording server → cross-check skipped (declaration recorded); shape still validated. Documented in tests.
- Corrupt stored audit JSON (hand-edited row) → reads as null via the lenient parse path with `@silent-fallback-ok` justification, mirroring operatorSeatUx.

## 6. Security

The local auth token is never sent to a remote history server: remote reads use `--history-auth-token` / `INSTAR_HISTORY_AUTH_TOKEN` or no header at all. Token-via-flag is discouraged in the help text (ps visibility); the env var is the documented path.

## 7. Migration parity

- New agents: template teaches the new POST shape.
- Existing agents: targeted PostUpdateMigrator line-rewrite (idempotent, content-sniffed on old-line-present + new-marker-absent) updates the apprenticeship section they already carry.
- Mentor loop: standing orders (buildAutoloopGoal step 5) teach audit-then-record including the cross-agent read.
