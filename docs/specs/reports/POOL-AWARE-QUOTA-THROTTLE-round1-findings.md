# Convergence Round 1 — Material Findings (POOL-AWARE-QUOTA-THROTTLE)

Date: 2026-06-16. Reviewers: 6 internal (security, adversarial, integration, scalability, decision-completeness, lessons-aware) + cross-model codex-cli:gpt-5.5 (gemini degraded: timeout) + conformance gate (0 flags).

NOT CONVERGED — material findings below must be resolved, then re-review.

## MUST-FIX (blocking)

F1 [HIGH] DEAD IN PRODUCTION. server.ts:~5220 builds `new QuotaCollector(provider, quotaTracker)` with NO config → registryPath undefined → pollMultipleAccounts never runs → accountSnapshots always [] → state.accounts never written → the pool-aware reader path never fires live. (integration reviewer)

F2 [HIGH] THROTTLE/PLACEMENT ELIGIBILITY MISMATCH (the never-loop GAP). Throttle reads quota-state.json + gates at scheduler shutdown(95). Placement (QuotaAwareScheduler.selectAccount) reads LIVE SubscriptionPool.lastQuota + excludes accounts >= soft(90). In the 90–95% band: throttle="allowed", placement=null → respawn loop = the exact bug the spec claimed to prevent. Two different data sources + two different thresholds. (adversarial, lessons-aware, codex#3, integration M2)

F3 [HIGH] STALE SNAPSHOTS FOLDED AS FRESH 0%. pollMultipleAccounts error branches emit percentUsed=0,isStale=true (no token/expired/budget). Step-4b discards isStale + stamps active account's lastUpdated → unknown account becomes phantom "fresh 0%" → throttle trusts fabricated headroom → spawns into walled account. AccountQuota has no staleness field; spec §2 "null=unknown" never triggers because code injects 0 not null. (adversarial, lessons-aware, codex#4, security-LOW)

F4 [MED] BOUNDED FAIL-OPEN. Degraded-data fail-open is unlimited. Codex: distinguish "unknown" from "safe" — allow a low-concurrency probe / conservative cap, not unbounded spawning. Also gate fail-open to NON-AUTHORITATIVE sources only (an authoritative >100 should still stop); the >100 branch currently fires on the single-account/legacy path for EVERY jsonl-fallback agent (wider blast radius than "pool-aware"). (codex#2, integration, decision-completeness)

F5 [MED] DEFINE "EFFECTIVE USAGE". Spec §2 "lowest effective usage" never defines how weekly vs 5h combine. Make it explicit (e.g. effective = max(weekly,5h)); define tie-breakers + null handling. (codex#1, decision-completeness)

## RESOLUTION DIRECTION (redesign)

ROOT FIX: the throttle must reason over the SAME authoritative, live per-account source the placer uses (SubscriptionPool.lastQuota), via a SHARED eligibility predicate — NOT a separate stale snapshot in quota-state.json. One change resolves F1 (no registryPath needed — read the pool directly/inject live), F2 (same store + same soft-threshold eligibility as selectAccount ⇒ throttle-allowed ⟹ placeable), F3 (live data, exclude isStale/unknown), partially F4.

Concretely:
- QuotaManager (which has both the SubscriptionPool and the QuotaTracker) injects the pool's LIVE per-account quota into state.accounts each tick, carrying isStale + status, OR the throttle takes an injected poolQuotaProvider. Prefer: QuotaManager folds SubscriptionPool.list() lastQuota into state.accounts (fresh, authoritative, same store as placement).
- Shared eligibility: throttle's per-account "available" must use placement's soft-threshold/bindingUtilization (a shared helper in QuotaAwareScheduler), so allowed ⟹ selectAccount returns non-null. Pin with a test on the 90–95% band.
- Staleness: exclude isStale/unknown accounts from the headroom set (unknown ≠ 0%).
- Bounded fail-open: degraded with NO authoritative per-account data → allow at most a low-concurrency probe (or critical-only), gated to non-authoritative source; authoritative >100 (rare) still stops.
- Define effective usage = max(weekly, fiveHour); null 5h = weekly only; both null = unknown (excluded).

## NON-MATERIAL (confirmed OK)
- Migration parity: pure code change, no PostUpdateMigrator entry needed (but hollow until F1).
- Multi-machine: quota-state.json machine-local BY DESIGN (each host polls own creds) — add one sentence to spec.
- Backward-compat single-account: holds (accounts attached only when >1).
- Hot-path perf: trivial O(accounts) over ~5, getState caches 5s, atomic rename — safe.
- Principle (signal-vs-authority): throttle is an existing authority; fail-open is the right direction. PASS.
