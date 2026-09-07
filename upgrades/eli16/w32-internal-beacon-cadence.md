# Window 32 internal beacon cadence — plain-English overview

PromiseBeacon has two different responsibilities: optional user-facing progress messages and internal follow-through, which includes heartbeat bookkeeping and session-loss recovery. Quiet hours and the daily LLM spend cap correctly suppress messages, but they were evaluated before those two responsibilities split. On an installation with user output disabled, the same gates therefore suppressed the free internal heartbeat and recovery checks too. During overnight work, a healthy executor could look stale, while a lost executor could not enter the existing revival ladder.

Quiet hours and the spend cap now apply only when user-facing output is enabled. With output disabled, PromiseBeacon performs no send, no summary LLM call, and no user-facing Attention action. It still runs its pre-existing owner-gated session-loss/revival logic and, when the session is healthy, records the due commitment's internal `lastHeartbeatAt`. Unit, integration, and booted-server E2E regressions pin both suppressors at once, prove repeated cadence remains bounded, prove the standby machine stays inert, and prove owner recovery stays live without producing user output.

The recurring internal write is now explicitly registered as the `promise-beacon-internal-cadence` eternal-sentinel controller. The repository's shared convergence ratchet drives it at N and 2N horizons and through restart reconstruction, enforcing the durable 60-second minimum cadence rather than trusting documentation.

The repository-wide lifecycle E2E also separates its manual-trigger job from its every-second cron job. They previously shared one slug, so the cron could correctly acquire that slug immediately before the manual request and make the test nondeterministically receive the production double-run refusal. The test now exercises both behaviors independently without weakening the scheduler guard.

No configuration or operator action is required.
