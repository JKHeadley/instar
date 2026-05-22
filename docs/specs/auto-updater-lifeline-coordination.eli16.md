# Auto-updater ↔ lifeline coordination — plain-English overview

> **One-line shape:** when the server auto-updates across a breaking version boundary, the lifeline gets restarted at the same time. The fact that we shipped four of five fixes two days ago and deferred this one is exactly the pattern that bit us again today — so this PR also adds a structural check that blocks future deferrals.

## What broke (again)

On Wednesday I shipped PR #284: five interlocking fixes to make the agent's "ingress paused — server auto-updated past lifeline" case auto-recover. The fixes worked for the LIFELINE process. They lived in the code on disk. They did NOT live in the LIFELINE PROCESS that was already running before the fixes shipped.

Today, two days later, a different running agent (b2lead-insights) reported the same outage. Their server had auto-updated 27 times to v1.2.28; their lifeline kept running v1.1.0. The PR-#284 fixes were on disk but invisible to the stuck process.

The root cause: PR #284's spec literally said *"lifeline auto-restart on server upgrade — out of scope today."* Two days later that exact deferral produced the regression.

## What this change does

**Layer 1 — auto-updater coordinates the restart.** When the auto-updater applies a version bump that crosses major.minor (1.1 → 1.2 is breaking; 1.2.0 → 1.2.28 is not), it now signals the lifeline to restart at the same time it signals the server. Two signal files written atomically; both consumers respect them.

**Layer 2 — server signals if it sees skew directly.** Belt-and-suspenders. When the server gets a forward request from a wrong-version lifeline (HTTP 426), it ALSO writes the lifeline-restart signal. Even if the auto-updater missed the bump or is in a weird state, the server itself directly tells the lifeline to restart.

**Layer 3 — server supervisor watches the signal as a third channel.** Covers the case where the lifeline's own tick loop is wedged and can't read the signal itself. The supervisor sees the signal, sees the lifeline hasn't reacted in 60 seconds, and force-restarts it.

**Layer 4 — one-time migration unsticks agents on pre-PR-#284 lifelines RIGHT NOW.** Without this, every agent currently running a v1.1.0 lifeline would need a manual kick. The migrator writes the signal once on next update for any agent whose running lifeline is older than its server.

**Layer 5 — the meta-fix: structural no-deferrals enforcement.** The instar-dev pre-commit gate now scans the spec for "deferred / out of scope today / follow-up / preemptive fix" patterns. If a deferral isn't linked to a tracked commitment ID, the commit is blocked. This is the structural answer to today's feedback ("we need to change how we develop"). It moves the "no deferrals" rule from my head into the hook system where it can't be forgotten.

## Why all of this is in one PR

Two days ago we shipped four fixes and deferred one. That deferral produced today's regression. The lesson is structural, not motivational: deferrals breed incompleteness. So:

- Every layer that touches this failure class ships together.
- The meta-fix that prevents this specific class of deferral ships in the same PR.
- Tests at all three tiers (unit, integration, e2e) cover the full path.
- The CLAUDE.md template tells future agents about it.
- The release note + ELI16 + side-effects review + cross-model review all ship in the same commit.

## What's NOT in scope (the only tracked forward note)

The v3 Self-Healing Remediator (your May 13 approval) will eventually absorb this signal-file orchestration into its probe-and-runbook architecture. That's tracked in topic 3079 with active development. The absorption is mechanical when Tier 3 lands — this layer doesn't compete with it, it temporarily fills the gap.

## What gets safer for every agent, not just b2lead

- Any agent whose server crosses a breaking version boundary now self-coordinates the lifeline restart.
- Any agent currently stuck on a pre-PR-#284 lifeline self-recovers on its next update cycle without manual intervention.
- Any future PR that tries to ship a partial fix with "we'll do the rest later" is blocked at commit time.
