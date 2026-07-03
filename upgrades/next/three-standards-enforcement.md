<!-- bump: patch -->

## What Changed

Enforcement machinery for three operator-ratified constitutional standards, per
`docs/specs/three-standards-enforcement.md` (converged). This ships the STRUCTURE that makes
each standard stick — the standard TEXTS ship separately under the already-granted ratification.

- **Standard A — reject an undefended machine-local.** The `/spec-converge` integration reviewer
  is upgraded from "a cross-machine posture is *declared*" to "the default posture is `unified`;
  an undefended `machine-local` is a MATERIAL FINDING." A machine-local surface is now allowed
  only with a `machine-local-justification: <key>` marker drawn from a CLOSED taxonomy
  (`physical-credential-locality` / `hardware-bound-resource` / `operator-ratified-exception`),
  and the check is bidirectional (an infeasible `unified` is equally a finding). The marker is the
  cheap deterministic signal; the LLM reviewer holds the semantic authority (Signal vs. Authority).
- **Standard B — self-heal before notify.** A new `/spec-converge` review-check that flags any
  monitor/watcher/recurring-notice-source whose operator-facing escalation is reachable on first
  detection. A watcher must declare its self-heal step, its `remediation-actions`, its P19 brakes
  (including flapping detection and a `max-notification-latency`), and a contested severity class.
- **Standard C — alerts-topic routing default.** A table-driven routing CONTRACT test at the
  Telegram adapter boundary proving a topic-less non-critical notice routes to the one hub topic by
  default, HIGH/URGENT keep their own topic, an existing-owning-topic send mints no new topic, and
  an unresolvable hub falls back safely — plus a guard that the hub id is never a baked-in constant.
- **Migration Parity.** `migrateThreeStandardsReviewChecks` re-copies the two upgraded spec-converge
  skill files to already-installed agents, mirroring the existing multi-machine-posture migration.

Honest framing: the purely-deterministic marker/field lints for A and B are hard-sequenced to land
WITH each standard's registry guard, not in this change; until then A/B enforcement is the per-spec
conformance-check gate plus the LLM review-lens (a semantic audit), never a no-LLM guarantee.

## What to Tell Your User

Nothing changes in how you talk to me day to day. This is internal development plumbing: when I
design a new capability, my own spec-review now pushes back harder on two mistakes it used to let
slide — quietly assuming a feature only ever runs on one of your machines, and building a watchdog
that pings you the instant it sees a problem instead of trying to fix it first and telling you only
when it genuinely cannot. It also adds a test proving stray housekeeping notices land in your one
alerts topic instead of spawning a new topic each time. You do not need to do anything.

## Summary of New Capabilities

No new user-facing capability. Internal enforcement only: stronger spec-review checks for
cross-machine posture and self-heal-before-notify, an idempotent migration so existing agents
receive the upgraded checks, and a routing contract test for topic-less notices.

## Evidence

- `npx vitest run tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts` — 7 passed
  (content-presence of the A/B review-lenses in the shipped prompts + migration idempotency and
  fingerprint-guard).
- `npx vitest run tests/integration/notification-flood-burst-invariant.test.ts` — 12 passed
  (5 new Standard C routing-contract cases + 7 existing burst-bound cases).
- `npx tsc --noEmit` — clean.
- Side-effects review: `upgrades/side-effects/three-standards-enforcement.md`.
