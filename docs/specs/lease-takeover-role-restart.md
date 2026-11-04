---
title: "A machine whose lease role changed restarts once"
slug: "lease-takeover-role-restart"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/lease-takeover-role-restart.eli16.md"
review-convergence: "2026-11-04T17:03:37.000Z"
review-iterations: 2
review-completed-at: "2026-11-04T17:03:37.000Z"
review-report: "docs/specs/reports/lease-takeover-role-restart-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to on-for-new-agents, proven parts first; condition named in docs/specs/lease-takeover-no-shared-medium.md)"
---

# A machine whose lease role changed restarts once

## Problem statement

Taking the lease does not start scheduled jobs. `server.ts` builds the scheduler only when `coordinator.isAwake`
at boot, and nothing subscribes to `promote`. So a standby that takes over runs no jobs. The reverse is worse: a
machine that loses the lease keeps firing jobs, because nothing stops its scheduler.

## Proposed design

On `roleChange`, a machine whose new role differs from the role it booted with asks for one planned restart,
through the same `restart-requested.json` an update uses. The role is saved in the registry and boot reads it, so
the normal boot path builds, or does not build, the scheduler.

**Why a restart.** The alternative is a scheduler that can start and stop on a live process. That touches 98
references on every multi-machine agent, to serve a rare event. A restart reuses one tested path and also covers
anything else that keys off the boot role. It costs about a minute of startup after a takeover, and up to 15
minutes more with no jobs if the machine already used its restart in that window.

**Conditions.** `soloCaptainHold` on, no machine named preferred, at least one non-revoked peer. So this is dark
by default, and Echo, which names a preferred machine, is unchanged.

**Losing authority stops jobs at once.** On any change away from awake, under those conditions, the scheduler is
paused immediately, whatever a restart is waiting on. A restart rebuilds; it is never what stops work. Returning
to awake resumes it.

**Bound.** A durable stamp allows one role restart per 15 minutes, so a flapping lease cannot loop. The request is
written first and the stamp second: a lost stamp costs at most one more restart, and after any restart the role
matches boot, so that cannot loop. A one-minute check repeats the decision while the role differs from boot, so a
change inside the window, or a failed request, resolves without another role change. Returning to the boot role
needs no restart.

**A limit we accept.** The bound needs the stamp. If it cannot be written, and the lease is also flapping, restarts
are not held to one per 15 minutes. That takes two failures together, behind a switch that is off by default, so
this spec does not build recovery for it. The restart log line shows it if it happens.

**What this does not do.** Telegram polling belongs to the lifeline, which this restart does not touch. It needs
`pollFollowsLease` live on the pair, as docs/specs/lease-takeover-no-shared-medium.md says. <!-- tracked: topic 137054 -->

## Decision points touched

- **Restart on role change:** invariant, config facts plus a recorded time. It cannot block anything.

## Multi-machine posture

Machine-local. The stamp is this machine's own. Peers see a short gap, as with any restart; the lease fence is
unchanged. A restart of the new holder finds its own lease and re-acquires as change 3 of the takeover spec says.

## Testing

Unit: each decision, both directions, the 15-minute edge, the stamp across a restart, a failed request leaving no
stamp. Wiring test: the check sits
on the real event, reads the boot role, needs all three conditions, pauses on demotion, and retries. Live: in the power-off drill, a standby
that takes over must show jobs running after its restart, and in the link-cut drill the old holder's jobs must stop.

## Maturation plan

- **ladder:** multiMachine.leaseSelfHeal.soloCaptainHold

Same switch and rung as the takeover change. It stays dark until those drills pass.

## Migration

None. No config, and the stamp file is created on first use.

## Rollback

`soloCaptainHold.enabled: false`, read live.

## Open questions

None.
