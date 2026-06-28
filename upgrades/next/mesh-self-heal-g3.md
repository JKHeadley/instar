## What Changed

Mesh Self-Heal **G3** — the first build increment of `MESH-SELF-HEAL-SPEC` (lease↔job binding, machine-independence). It makes duplicate sessions structurally impossible across a multi-machine setup:

- **Lease-gated spawn** (`src/core/leaseGatedSpawn.ts`): when an inbound Telegram message has no session yet, a machine spawns a session for that topic ONLY if it genuinely holds the fenced awake-lease; otherwise it forwards to the holder ("spawn iff holder, else forward"). It keys on the one trustworthy authority (`holdsLease()`), never an unreliable placement view, and FAILS toward spawn when no forward seam exists — it never strands a message to avoid a duplicate.
- **Single-writer binding lifecycle**: a topic→session binding is cleared the instant its session is killed ("a binding exists IFF a live session exists"), so a dead session can't silently resurrect and double-serve. The cleanup deliberately SKIPS context-exhaustion / recovery kills (which are immediately followed by a same-topic respawn), mirroring the resume-UUID-save guard, so promoting it can never break recovery.
- **Evaluable soak evidence** (`GET /mesh-selfheal/g3`): a read-only ledger records the counterfactual ("how many duplicate sessions I would have prevented if enabled" / "stale bindings I would have cleared") plus a deterministic promotion recommendation — so this dark feature can actually earn graduation instead of rotting silently.

Ships **dark + dry-run** behind `multiMachine.sessionPool.ownershipCheckedSpawn` (dev-gated): a strict no-op on a single machine or with the flag off. Next increments: G2 (nobody-serving alarm), G1 (badge↔job binding).

## Evidence

- New unit suite `tests/unit/leaseGatedSpawn.test.ts` (30 tests) covers both sides of every decision boundary — spawn-iff-holder, forward, dry-run counterfactual, spawn-when-no-seam, binding clear/skip/respawn-imminent.
- New integration suite `tests/integration/mesh-selfheal-g3-route.test.ts` (3 tests) drives `GET /mesh-selfheal/g3` over the real HTTP path and confirms both counters + the promotion recommendation.
- `tests/unit/lint-dev-agent-dark-gate.test.ts` updated for the new gate's dark-gate exclusion entry; full dark-gate lint green (24 tests).
- Typecheck clean; 57 targeted tests green. Independent second-pass review concurred (audited the recovery-bounce fix).

## What to Tell Your User

Nothing changes yet — this ships **off by default** (⚗️ experimental, dark + dry-run) while it soaks on a real two-machine pair. When it's active it prevents the "two of me replying to one message" duplicate-session problem on multi-machine setups, with no action needed from you. Single-machine agents are unaffected.

## Summary of New Capabilities

- `GET /mesh-selfheal/g3` — read-only soak-evidence + promotion recommendation for the lease-gated-spawn gate (agent observability; not a user-invokable capability).
- Config: `multiMachine.sessionPool.ownershipCheckedSpawn` `{ enabled, dryRun }` — opt-in lease-gated spawn + single-writer binding lifecycle (dark + dry-run by default).
