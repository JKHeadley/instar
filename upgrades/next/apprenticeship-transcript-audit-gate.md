<!-- bump: minor -->

## What Changed

Closes the loop on the UX-blindspot arc: the post-drive transcript auditor
(PR #864) is no longer optional on the channel it was built for. An
apprenticeship cycle recorded with `channel: 'telegram-playwright'` — the
dogfooded drive through the mentee's real Telegram UX — now structurally
REFUSES to exist without a `transcriptAudit` block proving the objective
audit ran:

- `POST /apprenticeship/cycles` requires `transcriptAudit: { topicIds, window:
  {start,end}, summary, findingDedupKeys, generatedAt, ledger:
  'local'|'remote'|'dry-run'|'failed', notes? }` on telegram-playwright cycles
  (optional-but-validated on other channels). The refusal error teaches the
  exact CLI that produces the artifact.
- **Anti-fabrication tooth**: a block declaring `ledger:'local'` with filed
  findings is cross-checked against the REAL framework ledger — if none of the
  claimed dedup keys exist, the record is refused. Honest declarations
  (`remote`/`dry-run`/`failed`) are accepted as declared and stay queryable.
- `instar dev:post-drive-transcript-audit` gains `--history-base-url` (+
  `INSTAR_HISTORY_AUTH_TOKEN`): read the drive transcript from the MENTEE's
  server (where the Playwright drive actually lands) while filing findings
  into your OWN ledger. The local token is never sent to the remote server.
- Mentor standing orders, the CLAUDE.md template, and a targeted
  PostUpdateMigrator line-rewrite all teach the new shape — deployed agents
  learn it on update instead of hitting mystery 400s.

Why: "Observation Needs Structure" (PR #861) — an observation tool nobody is
forced to run is the same prose-wish the article bans, one level up. #856
gated the subjective half (mentor seat-counts); this gates the objective half.

## What to Tell Your User

Nothing user-visible changes day to day. Under the hood, the apprenticeship
program's drive records now require proof that the objective transcript audit
ran — so UX friction caught on a drive can no longer be silently skipped, and
fabricated audit claims are refused against the real findings ledger.

## Summary of New Capabilities

- `transcriptAudit` block on `POST /apprenticeship/cycles` — required for
  telegram-playwright cycles, validated everywhere, ledger-verified for
  `local` claims.
- `FrameworkIssueLedger.hasDedupKey(key)` — read-only existence probe.
- `instar dev:post-drive-transcript-audit --history-base-url <url>` — split
  read/write servers for the cross-agent mentor flow.

## Evidence

All three test tiers green: store unit (21), auditor CLI unit (8, incl. the
token-isolation case), routes integration (21, incl. both sides of the
anti-fabrication boundary), e2e lifecycle (7, incl. the feature-alive gate
case through AgentServer). Migration test (4) covers rewrite, idempotency,
and no-double-fire. `tsc --noEmit` clean.
