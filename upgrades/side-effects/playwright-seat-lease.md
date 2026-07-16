# Side-Effects Review — Playwright operator-seat lease

**Version / slug:** `playwright-seat-lease`
**Date:** `2026-07-16`
**Author:** Instar-codey
**Second-pass reviewer:** independent reviewer (Codex collaboration agent)

## Summary of the change

Adds `PlaywrightSeatLease`, an atomic host-wide TTL lease stored under `~/.instar/state`; exposes an authenticated acquisition route; and extends the installed MCP PreToolUse hook to acquire or renew before every Playwright call. Tests cover renewal, conflict, expiry, corrupt-state recovery, route wiring, installed-hook content, and an end-to-end hook conflict.

## Decision-point inventory

- `external-operation-gate.js` Playwright preflight — **add** — blocks a tool only when the lease API positively reports another live holder.
- `PlaywrightSeatLease.acquire` — **add** — deterministically grants same-holder renewal, rejects a different live holder, and reclaims expired state.

## 1. Over-block

The host-wide default-seat key conservatively serializes Playwright calls even if two MCP installations happen to use physically distinct implicit defaults. This trades some possible parallelism for correctness. The ten-minute quiet-period TTL can also make a new drive wait after the former drive finished without explicitly releasing.

## 2. Under-block

Callers without a spawn-unique `INSTAR_SESSION_ID` and callers whose local server or lease store is unavailable fail open. A browser call exceeding the ten-minute bounded MCP execution window could outlive its lease because renewal occurs at tool-call boundaries; Instar's browser calls are bounded below that window. Only a confirmed conflict holds blocking authority. This coordinates trusted local agent sessions, not hostile processes that already possess the agent's bearer credential.

## 3. Level-of-abstraction fit

The lease is enforced at the MCP PreToolUse chokepoint, the only layer through which all agent Playwright calls pass. The authority is a filesystem-backed mutual-exclusion invariant, not a probabilistic detector. State is host-wide rather than registry-local because the contested resource is a physical browser profile shared across agent homes.

## 4. Signal vs authority compliance

- [x] Yes — but the blocking rule is a hard mutual-exclusion invariant, not brittle inference.

The gate does not infer whether another drive “looks active.” It blocks only on an unexpired, atomically written ownership record for the same physical seat, keyed by the spawn-unique session id rather than a reusable tmux name. Uncertainty or infrastructure failure does not fabricate a conflict.

## 4b. Judgment-point check

No competing-signals judgment point is introduced. Exclusive ownership of one mutable browser seat is an enumerable safety invariant: same holder renews, different live holder waits, expired holder is reclaimed.

## 5. Interactions

- **Shadowing:** Playwright lease acquisition runs before the existing mutability fast path, intentionally covering read-like snapshots; on success the existing external-operation classification continues unchanged.
- **Double-fire:** same-holder acquisition is idempotent and only extends expiry.
- **Races:** cross-process writes use an exclusive lock plus atomic rename. Stale lock files are recoverable after the bounded lock window.
- **Feedback loops:** no background loop, notice, retry, or autonomous action is added.

## 6. External surfaces

Other agents on the same host share the lease and may receive a plain busy response. A new machine-local state file stores only holder/session labels and timestamps, no cookies, page data, credentials, or URLs. No external service API changes and no operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — `physical-credential-locality`.** The protected browser cookies and user-data directory physically live on one machine. Each machine therefore coordinates its own seat; replicating the lease would incorrectly block an independent browser on another host. It emits no user-facing notices, strands no topic-owned durable state, and generates no URLs.

## 8. Rollback cost

Revert and ship a patch. The leftover lease JSON is harmless and expires by timestamp; no migration or agent-state repair is required. The hook migrator will replace the enforcement hook with the reverted template.

## Conclusion

The review rejected live-profile cloning and moved coordination to a host-wide lease at the actual Playwright tool chokepoint. It also decoupled safety from the optional registry gate and replaced reusable-name ownership with spawn-unique identity. The remaining deliberate tradeoffs are a bounded post-drive wait and fail-open degradation when coordination itself is unavailable. Independent second-pass review now concurs.

## Second-pass review

**Reviewer:** independent reviewer (Codex collaboration agent)
**Independent read of the artifact:** concur

Concur for the dispatched dogfood contention case after the review-driven corrections: spawn-unique ownership closes predecessor impersonation; the fleet-available route closes the registry-gate hole; the ten-minute TTL covers the explicitly bounded Instar MCP execution window; and trusted-local-peer/fail-open boundaries are disclosed. The conservative post-drive hold is an accepted latency tradeoff, not a correctness blocker.

## Evidence pointers

- `tests/unit/PlaywrightSeatLease.test.ts`
- `tests/integration/playwright-profile-routes.test.ts`
- `tests/unit/hook-installation.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This closes a missing concurrency primitive rather than a malformed prompt/hook contract class.
