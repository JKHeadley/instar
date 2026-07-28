# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Built-in scheduled jobs load again — the second (and final) layer of the fleet-wide
job-load failure.** The prior fix carried the required `priority`/`expectedDurationMinutes`
fields into each per-slug JSON manifest. That let every entry survive to the *next*
checkpoint — the agentmd `.md` frontmatter validator — which then rejected all of them: its
closed-set key allowlist (`ALLOWED_FRONTMATTER_KEYS`) was a "Phase 1a starter set" of
agent-behavior keys and never included the scheduling/execution vocabulary
(`schedule`, `priority`, `expectedDurationMinutes`, `model`, `enabled`, `tags`,
`unrestrictedTools`, `gate`, …) that every shipped template legitimately carries in
frontmatter. So the loader hard-rejected each built-in job on the first scheduling key it
saw (`schedule`) with `agentmd-frontmatter-invalid`, leaving the job count at zero. The
allowlist now includes that vocabulary. Existing `.md` files self-heal on the next load
(their frontmatter simply stops being rejected).

## What to Tell Your User

- Your agent's automatic background jobs (health checks, reflection, evolution, the
  overseers) are running again — they were quietly dead, and this revives them with nothing
  for you to do.
- The change only teaches the job reader to recognize scheduling labels it was wrongly
  rejecting; it adds no new behavior, and a job still can't grant itself extra tool access
  through those labels — the locked-down job record remains the only authority for that.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Built-in jobs load again | Automatic on update; `GET /jobs` shows the full set, no `agentmd-frontmatter-invalid` lines |

## Evidence

Found by deploying the prior fix to a real server: `jobCount` stayed `0` on v1.3.24 with 18
fresh `agentmd-frontmatter-invalid: Unknown frontmatter key "schedule"` log lines. Proven by:
a **gap-closer** unit test that installs every real shipped template and drives it through the
**full** `loadAgentMdJobs` path — asserting `jobs.length === installedCount` (derived, not
hardcoded), zero `agentmd-frontmatter-invalid`, and **valid scheduling values** (the
assertion the prior manifest-only test missed); a closed-set regression (a genuinely-unknown
key still rejects); a manifest-wins precedence test; a security regression (frontmatter
`unrestrictedTools` cannot self-grant); and a live before/after on the affected server
(`jobCount 0 → 18`). Spec converged 2 iterations across 3 reviewers.
