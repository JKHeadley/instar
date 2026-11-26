---
title: "Lease job coverage and explicit catch-up"
slug: "lease-job-coverage-and-catchup"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/lease-job-coverage-and-catchup.eli16.md"
review-convergence: "2026-11-05T05:24:13.909Z"
review-iterations: 4
approved: true
review-completed-at: "2026-11-05T05:24:13.909Z"
review-report: "docs/specs/reports/lease-job-coverage-and-catchup-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli timed out in all four rounds"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Lease job coverage and explicit catch-up

## Problem statement

A standby can take the lease while lacking jobs that existed on the old holder. The current `GET /jobs?scope=pool` sees only online peers and ignores a machine declaring zero jobs. There is no durable record of the prior catalog. The current `checkMissedJobs` also triggers overdue work after a restart, including time-specific work a human may already have completed. Luna experienced both failures after its 27 October 2026 laptop-to-Studio handoff. Git-sync must stay disabled for Luna because its backup includes token-bearing config.

## Frontloaded Decisions

- The shipped safe default for catch-up after a lease promotion is `ask`; explicit `skip` and `run-once` choices are per job. A normal same-machine restart keeps its existing behavior.
- Coverage is a unified, metadata-only operator view. Each machine retains its own observed snapshots for offline use, and the pool read merges available snapshots with provenance. The local promoted holder can use its own durable prior observation if the former holder is gone.
- An authenticated peer may supply coverage evidence, never execution authority. The serving route projects only metadata before serialization. The receiver validates identity and bounds before writing. A missing, stale, conflicted, or incomplete source produces an uncertainty alert, not a healthy verdict.
- A safe local catalog reconciliation is attempted before alerting about missing built-in definitions. It is add-only, preserves customized and disabled entries, and never enables git-sync. Jobs sourced from another machine and missing dependencies are reported for operator action; automatic installation or code copying would be unsafe.
- Alerts use the existing operator attention destination, with a durable one-hour retry floor and a daily reminder ceiling. No peer can request a catch-up run.
- Published `GET /jobs?scope=pool` gains a coverage summary containing status, slug, source machine, age, and reason. Dependency paths are not included in that public summary.

## Proposed design

### Catalog observations and peer transport

Add a bounded metadata-only `GET /jobs/coverage-snapshot` response. It loads the local catalog independently of `JobScheduler`, including on a scheduler-less standby, through the same validated legacy and per-slug loaders as scheduler startup. The response includes registry machine ID, a monotonically increasing local catalog generation, completeness, and at most 500 jobs with `slug`, `schedule`, `enabled`, `machines`, optional declared dependency identifiers, and `catchUpPolicy`. It never serializes `execute`, body, gate, auth token, or config. If the catalog exceeds the cap or cannot be parsed, the response explicitly says incomplete and cannot establish health. Explicit empty is valid only when a successfully parsed catalog is known empty; scheduler absence alone is not evidence of an empty catalog. A local refresh updates the served generation.

The standby starts a first peer poll two seconds after boot, then polls every five minutes. It uses the existing credential-safe mesh URL guard and bearer transport with a three-second per-peer timeout, 256 KiB body cap, two concurrent requests, no overlapping ticks, and no overlapping poll ticks. Registered non-revoked peers without a reachable URL remain in the coverage view as unavailable. The request sends a cryptographically random 32-byte nonce. The responder signs a canonical envelope containing protocol version, nonce, responder machine ID, catalog generation, completeness, and the metadata projection using its existing Ed25519 machine signing key. The requester verifies the signature against the non-revoked registry key for the target peer, compares the nonce and target ID, and rejects nonce replay, a mismatch with the registered signing key, or generation rollback. Shared bearer auth remains the HTTP admission gate, but is not used as identity proof. A mismatch, unverifiable identity, malformed response, oversize catalog, or fetch failure marks the peer unavailable/incomplete and preserves its last good observation.

Each machine obtains its own nonce-bound signed observation directly from each source and stores the validated replica under `.instar/state/` atomically with receiver-observed time and source generation. Nonce-bound envelopes are never relayed as fresh evidence. A machine disconnected from a source catches up by polling it when it reconnects; until then its retained observation keeps the original receipt time and ages into stale/unknown. Retain the latest good snapshot per registered machine and an availability state in a bounded local store. Do not replace a prior full snapshot with an ambiguous empty response. A confirmed empty catalog is a new observed state with provenance, not silent deletion. Data older than 24 hours is stale; it may inform a possible-missing warning but cannot establish current coverage. Ignore revoked peers in coverage comparisons and cap total storage; a capacity refusal is visible as incomplete. The pool view merges online and retained replica observations, names conflicts when two verified sources disagree on a slug's metadata, and never chooses an arbitrary winner as authority. Locally retained observations permit an isolated promoted holder to warn without git-sync. Each online machine independently polls registered peers, so its own pool view includes the observations it has verified.

### Promotion check and repair

The role-follow restart applies to any scheduler-enabled lease transition (the separate takeover fix), not only solo-captain mode. The separate safe catalog migration explicitly forces newly inserted git-sync disabled and removes refresh-time auto-enable; this check calls that migration but never enables git-sync. On each transition to awake and at boot after an identified promotion restart, compare the live local catalog with the union of verified prior observations. Run an add-only safe built-in catalog reconciliation first, then reload. List enabled jobs that are missing, disabled locally, or pinned to another machine using the scheduler's case-insensitive machine ID/name matching. Validate declared dependencies only from the local job definition, never peer-supplied paths. A dependency declaration is an explicit allowlist of bounded, relative, nonsecret project paths; validation rejects absolute paths, traversal and secret-bearing segments. Check with containment-safe filesystem operations that do not follow symlinks outside the project root. Missing paths produce a reason, but the path itself is not shown in the public pool summary or alert.

A peer's prior catalog is signal only: a conflict or stale observation cannot silently install, enable, or run a job. The check records an audit of observation, safe reconciliation, comparison and alert outcome. A single consolidated operator alert goes through the existing alerts hub/attention destination, and works when the holder has no scheduler. Persist an episode keyed by the mismatch fingerprint on the current holder. A failed send retries no more than hourly; a successful send gets at most one reminder per day until repaired. Recovery closes the episode. If no trustworthy prior evidence exists, the alert says coverage cannot be proven. The check never claims a healthy result from incomplete input.

### Explicit missed-work policy

Add `catchUpPolicy: 'skip' | 'run-once' | 'ask'` to `JobDefinition`, the legacy loader and validator, `PerSlugManifest`, validation, and manifest-to-runtime mapping. Unknown values reject the declaration; absence means `ask` only after a verified promotion. Other restarts preserve the existing default behavior. A promotion is identified by a durable lease transition identity (holder ID and lease epoch or persisted role-change request), not a bare timestamp that survives unrelated boots. A stale/ambiguous stamp falls back to `ask`. A lease flap, unverified prior holder, or missing shared decision witness also falls back to `ask`; an automatic `run-once` is never inferred across machines.

The scheduler evaluates overdue occurrences while holding normal cron admission behind the promotion sweep. It shares an admission fence with cron so one occurrence cannot be launched by both paths. `skip` persists the choice; `ask` records and alerts, leaving manual run available. `run-once` writes a durable local promotion/slug admission record before requesting one launch, then rechecks live lease/read-only state immediately before launch and records requested, triggered or uncertain states. The record bounds automatic requests to one on that holder for that verified promotion. Because existing job claims are not universally durable or cross-machine, production lease transfers provide no automatic run-once witness and resolve that policy to `ask`; an operator can still choose a manual run. A local automatic run-once is admitted only when a caller supplies an independently verified witness to the scheduler seam. A crash or uncertain admission never silently retries a potentially launched job; it surfaces an `uncertain` outcome for operator review. A gate refusal or queued result is not recorded as completed. A later normal cron occurrence remains eligible. A completed promotion sweep consumes its role stamp, while unresolved ask/skip/uncertain decisions continue to suppress startup replay until a successful run. No policy decision from a peer grants authority to spawn locally.

## Decision points touched

- **Invariant:** signature, nonce, registry key, size and schema validation are deterministic information-integrity floors; a failing floor yields unknown coverage and never blocks scheduler execution.
- **Judgment-candidate:** conflicting or stale coverage evidence is reported with provenance to the operator. The floor forbids a healthy verdict or auto-install from unverified evidence; the operator is the arbiter, with unknown as the deterministic fallback.
- **Invariant:** the add-only built-in repair is bounded by shipped definitions and a preserved disabled state; it cannot enable or replace customized jobs.
- **Invariant:** declared catch-up policy and live lease govern automatic spawn admission. Unknown promotion/claim state resolves to `ask`, and no peer metadata can grant authority.

## Security and privacy

The peer endpoint projects metadata before sending it. It rejects oversized or malformed catalogs and never returns command, body, gate, token, config, or raw dependency path in the public coverage view. Peer IDs are verified against registry identity. Snapshot persistence uses an allowlist after validation. Dependency declarations come from trusted local definitions and are checked within the project root without escaping via symlinks. Alert text includes slug and status only. Git-sync remains disabled; this feature does not copy token-bearing config or job execution bodies through the coverage path.

## Multi-machine posture

- Coverage view: unified by the pool read, combining local retained observations with reachable peer summaries; unavailable machines are named.
- Snapshot records: signed metadata is replicated by each recipient polling the source with its own nonce and merged on pool read. Local files are validated replica storage, not a separate authoritative catalog; source machine and age remain visible. A disconnected machine can only use its last replica and must label uncertainty.
- Alert episode: the current lease holder sends one voice through the existing attention destination. An episode is keyed by lease epoch and can be reconstructed from the unified observations after a holder change.
- Catch-up decision: the lease promotion identity is shared, while the local journal witnesses a holder's automatic request. A live lease gates admission. Production has no shared proof of an earlier holder's launch, so `run-once` resolves to `ask` on a lease transfer; no cross-machine exactly-once claim is made.

## Supervision and failure behavior

The polling loop is Tier 0 deterministic supervision because it observes catalog metadata without judging job behavior. It starts two seconds after boot and repeats every five minutes. Two concurrent requests use three-second timeouts, a 256 KiB response cap, one immediate retry, and no redirects. Failure counts and next eligible times survive restart; backoff grows from five to ten minutes and holds at fifteen minutes after three failures. A failed observation retains the last good signed snapshot and marks the peer unavailable. Metadata-only audit records are size bounded under `.instar/state/job-coverage-audit.jsonl`. The current awake holder sends one consolidated uncertainty alert when coverage cannot be proved, retries a failed send after at least an hour, and reminds no more than daily. The polling loop never blocks scheduler startup. Shutdown clears the timers; each in-flight fetch has its own timeout.

## Testing and acceptance

1. A standby snapshots a verified old holder's catalog while online; after the old holder goes offline and the standby takes the lease, the holder reports exact missing/disabled/pinned jobs and source age. Its scheduler starts after promotion.
2. Scheduler-less standby serves its own validated catalog. An ambiguous empty response, stale snapshot, conflicting sources, excess jobs, malformed catalog, identity mismatch or failed fetch never produces a healthy coverage verdict.
3. No command, gate, body, config, token or raw dependency path crosses the peer response or durable snapshot path. Local dependency checks cannot traverse out of the project root.
4. A verified promotion applies `skip`, `run-once` or `ask` once across restart, crash, gate refusal and cron race. Default is ask. Read-only standby never launches.
5. Safe built-in reconciliation preserves custom jobs and disabled git-sync. Coverage episodes retry at most hourly after send failure and remind at most daily after delivery.
6. Existing same-machine catch-up behavior is unchanged. Peer polling is bounded, supervised and stopped on shutdown.

## Maturation plan

- **test-agent-live:** Two throwaway paired machines prove signed snapshots, offline takeover, scheduler-less catalogs, stale and corrupt evidence, and all three catch-up policies with no external secrets.
- **dev-agent-live:** Enable on Echo's paired machines after the throwaway proof. Observe one planned lease move and one intentionally offline peer; review the alert and admission audit for seven days.
- **fleet:** Roll out default-on only after the development pair meets the graduation criterion; single-machine agents use the existing scheduler path.
- **graduation criterion:** One verified planned takeover and one offline takeover report accurate coverage, zero duplicate automatic catch-up requests, zero git-sync enablement, and no credentialed data in a snapshot over seven days.
- **dark-window:** At most 14 days between merge and fleet decision; a failed security or duplicate-run drill resets the window. The safety default `ask` remains active while coverage evidence is dark.

## Rollback

Reverting source leaves metadata snapshots inert and removes the new coverage surface. Existing role-follow and safe built-in migration fixes remain independently deployable. Reverting catch-up policy restores automatic missed-job behavior on promotion; operators should inspect overdue jobs before rollback.

## Open questions

*(none)*
