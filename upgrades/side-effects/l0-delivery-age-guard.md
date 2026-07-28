# Side-Effects Review — L0 dequeue-time age guard on the delivery-recovery queue

Change: the DeliveryFailureSentinel's drain gains the L0 zombie-free delivery invariant (drive12 UX-first
enforcement spec, Increment 1): on EVERY claimable pull, rows older than the class policy retire to
dead-letter (audited 'expired-stale' reason) instead of ever reaching processRow, with ONE coalesced
Attention digest (≥6h apart). Policy = shipped data file (`src/data/outbound-queue-expiry.json`,
delivery-recovery 24h; 0 ⇒ no expiry) armed by the per-install top-level `outboundQueueExpiry.enabled`
flag (DARK by default; test agent arms first). Ancestor incident: 2026-07-24 zombie-replay — the #1600
recovery fix drained weeks-old rows (incl. 2 expired secure links) into user topics as new.

1. **Over-block** — The risk is retiring a message the user still wanted. Bounded three ways: the guard
   only acts when ARMED (dark default); age basis is `attempted_at` (original failed send — a 24h-stale
   reply is stale by any reading, and the class policy is a data edit); and a retired row is preserved as
   an audited dead-letter, never deleted — recoverable by inspection. The digest tells the operator what
   was retired and from which conversations.

2. **Under-block** — Scope is deliberately ONE queue class (Increment 1): the main selectClaimable lane.
   The reap-notify lane and other outbound queues join via the registry in Increment 2 (per the spec's
   enumerated-queue-registry decision). Unparseable `attempted_at` is treated as FRESH (never guess-drop)
   — a malformed row still rides the existing recovery policy (TTL/attempts escalation catches it).

3. **Level-of-abstraction fit** — Correct layer per the converged spec's external-review finding: zombie
   prevention belongs in the delivery MACHINERY (dequeue time), not in tests. The startup restore-purge
   stays (different job: boot hygiene); this is the every-pass invariant that covers rows becoming
   claimable long after boot — exactly the class the startup purge structurally misses.

4. **Signal vs authority** — The guard holds deterministic authority over STALE rows only, with a
   deterministic, self-service escape (data-file `0`, or disarm the flag) — the L9/L10 precedent class
   (release-note lint). It never judges content; the tone gate's authority is untouched (fresh rows ride
   the existing state machine unchanged). The digest is signal-only and best-effort.

5. **Interactions** — Runs BEFORE stampede grouping and per-topic rate caps, so retired rows can no
   longer trigger stampede digests (correct: they are not deliverable). The recovery-policy TTL
   (escalation) still governs fresh rows; a row can now retire-by-age before it would have escalated —
   dead-letter vs escalated is a deliberate narrowing (an escalation of a weeks-old row is exactly the
   zombie-adjacent noise we're removing). transition() failures leave the row for the next pass but it
   still never delivers THIS pass (it is excluded from the fresh set first).

6. **External surfaces** — One new low-priority Attention item class (source `delivery-l0-age-guard`),
   coalesced ≥6h; rides the existing single-Attention-hub routing (no new topics; the topic-creation
   budget is untouched). No new route, no new network egress (digest posts to the local server only).

7. **Multi-machine posture** — Machine-local BY DESIGN: each machine's sentinel drains its own SQLite
   queue; the policy data file ships with the code (identical fleet-wide once deployed) and the arm flag
   is per-install (the maturation ladder's unit). No replication needed; no cross-machine URL surface.

8. **Rollback cost** — Three independent levers, cheapest first: (a) config: `outboundQueueExpiry.enabled`
   false (per-install, next boot); (b) data edit: class `maxAgeHours: 0` (no expiry, no code revert) —
   NOTE per the spec this file is protected-path class and a 0-flip on the shipped default requires an
   operator label; (c) single-commit git revert. Retired rows are dead-letters with reasons — no data
   migration either way.

## Second-pass review

**Concern raised: the armed path is dead-on-arrival in a built install — the policy data file is resolved at a path the build never populates.** `AgentServer` reads `new URL('../data/outbound-queue-expiry.json', import.meta.url)`, which from `dist/server/AgentServer.js` resolves to `dist/data/outbound-queue-expiry.json`. The build is plain `tsc`, which emits no JSON (verified: `dist/data/` contains zero `.json` even though `src/data/` ships four); the packaging convention for runtime-read shipped JSON is `<pkg>/src/data/...` (cf. `DEFAULT_MIRROR_PATH = 'src/data/benchmarkPredictions.json'`). So flipping `outboundQueueExpiry.enabled: true` on a deployed agent hits ENOENT → the catch keeps the guard dark with one boot warn — fail-SAFE as the artifact claims, but Increment 1's arming step (Codey arms first) silently cannot happen, and rollback lever (b) edits a file the deployed server never reads. Fix: resolve `../../src/data/...` (or the CapabilityMapper existsSync pattern) and add a wiring-integrity test for the AgentServer resolution path (the current integration test injects the policy directly and cannot catch this).

Minor findings, non-blocking: (1) the digest's "accumulate and retry on a later pass" comment is not what the code does on network failure — the `error`/`timeout` handlers `resolve()` the promise, so `staleDigestPending`/`staleDigestTopics` are cleared and `lastStaleDigestAt` stamped even when nothing posted (a non-2xx also counts as success); only a synchronous `readConfig` throw reaches the catch. Counts are lost, not double-counted — and the retired rows remain audited dead-letters with the event + log line, so this is observability-only. (2) The working tree carries lockfile/toolchain churn unmentioned by the artifact (pnpm-lock.yaml ssh2/undici entries reconciling an out-of-sync committed package.json, new pnpm-workspace.yaml allowBuilds) — should be committed separately or acknowledged.

Everything else concurs on independent trace: dark default holds at all three layers (DEFAULTS `enabled:false`, `=== true` flag check, `{}` passed when unarmed); no path retires or blocks a FRESH row (transition is only called on the stale partition, per-row try/catch, and `postStaleDigest` cannot reject — nothing between partition and `return fresh` can drop the fresh set); a `transition()` throw or `false` leaves the row queued for the next pass while still excluded from delivery THIS pass; unparseable `attempted_at` → fresh, riding the existing recovery policy; guard-before-stampede/rate-cap ordering is correct and the reap-notify bypass is structural (`selectClaimable` PK-range-excludes `reap-notify:` rows) and honestly scoped to Increment 2; signal-vs-authority is acceptable — a deterministic timestamp mechanic with a self-service escape on a safety class the doc explicitly exempts (irreversible-delivery guard, not a judgment over content); the constructor's second param was already optional, so existing callers are unaffected.

### Concern resolution (author, same session)

All three findings addressed before commit: (1) the policy path now resolves `'../../src/data/outbound-queue-expiry.json'`
— correct from BOTH the src/server (dev/test) and dist/server (deployed) layouts per the DEFAULT_MIRROR_PATH
packaging convention — and a new wiring-integrity suite (`outbound-queue-expiry-wiring.test.ts`, 4 tests) pins
the exact expression against both layouts, asserts AgentServer.ts uses it verbatim, and validates the shipped
schema; (2) digest counters now clear (and the coalesce window stamps) ONLY on a confirmed 2xx — a failed,
timed-out, or non-2xx post keeps accumulating for a later pass, matching the stated semantics; (3) the
lockfile/toolchain install churn (pnpm-lock.yaml, pnpm-workspace.yaml) is excluded from the commit.

### Amend note
The two deliberate fail-safe catches now carry `@silent-fallback-ok` annotations (no-silent-fallbacks ratchet compliance) — no behavior change.
