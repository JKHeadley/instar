# Side-effects review — document the durable built-in job enablement surface

**Change:** documentation only. One bullet added to the CLAUDE.md template's Job
Scheduler section, plus a `migrateClaudeMd()` entry so existing agents receive it.
No runtime behaviour changes.

## Why — the visible control is the wrong one, and failing at it is silent

Enabling a built-in job by editing `enabled: true` in
`.instar/jobs/instar/<slug>.md` is futile. `installBuiltinJobs` regenerates that
markdown from the shipped template on **every update** (the same always-overwrite
rule as built-in hooks), so the edit reverts — observed ~20 minutes later on a live
machine on 2026-07-23.

The durable setting is `enabled` in `.instar/jobs/schedule/<slug>.json`, which
`installBuiltinJobs` explicitly PRESERVES across regeneration (it reads
`existing.enabled` and `existing.disabledAtBodyHash` before rewriting) and which
`AgentMdJobLoader` actually reads (`if (!manifest.enabled) return`).

**The failure mode is silence.** The `.md` carries a visible `enabled:` line that
looks authoritative; the edit appears to work; the file shows the new value; then it
quietly reverts at the next update. Nothing in the agent-facing surface said
otherwise.

**Real cost, first-hand.** I lost roughly an hour to this and — worse — concluded
from one failed attempt that *no durable path existed*, then reported that to the
operator as a decision they needed to make. That is a false blocker: the
Self-Unblock standard says the blocker is mine to solve first and that I should ask
for the smallest possible thing. I asked for something they shouldn't have had to
give, because the surface didn't tell me there was a second door.

Per the Agent Awareness Standard — "an agent that doesn't know about a capability
effectively doesn't have it" — the fix is to put it where every session sees it.

## Blast radius

- **Runtime:** none. A template string and a migration branch.
- **Migration Parity:** satisfied — `migrateClaudeMd()` patches existing agents;
  new agents get it via `init`. Content-sniffed on the anchor phrase, so it is
  idempotent.
- **Anchor safety:** inserted immediately after the Job Scheduler block's `Trigger`
  line. If that anchor is absent (an older CLAUDE.md), it appends rather than
  guessing at a position. A CLAUDE.md with no Job Scheduler section is left alone
  entirely — no orphaned guidance appended to an unrelated document.

## Risk

**Could it duplicate on repeated updates?** No — pinned by an idempotency test that
asserts byte-identical output on a second run and exactly one occurrence of the
bullet.

**Could it land in the wrong section?** Pinned by a test asserting the bullet sits
after the `Trigger` line and before the next `**Sessions**` heading.

**Is the guidance itself correct?** Verified against source, not inferred:
`InstallBuiltinJobs.ts` preserves `enabled` from the manifest before regenerating,
and `AgentMdJobLoader.ts` gates on `manifest.enabled`.

## Testing

`tests/unit/PostUpdateMigrator-jobEnableSurface.test.ts` — 5 tests: adds the bullet;
inserts it inside the right block; idempotent on re-run; leaves a
no-Job-Scheduler document untouched; falls back to append when the anchor is absent.
`tsc --noEmit` clean.

## Rollback

Revert. The template loses the bullet; already-patched CLAUDE.md files keep it
harmlessly (it remains accurate).
