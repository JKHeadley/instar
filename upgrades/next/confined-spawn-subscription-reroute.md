# Confined (feedback executor) sessions now run on the subscription path

## What Changed

Under `intelligence.subscriptionPath.mode: force` (or `auto` under SDK-pot pressure) every confined spawn was refused (`confinement-reroute-unsupported`), so the feedback executor could never run a canary or a build on such an agent. Spec: `docs/specs/confined-spawn-subscription-reroute.md` (converged, 12 rounds).

- **`src/core/SessionManager.ts`**: the rerouted interactive lane applies the claude-code confinement adapter through one shared helper (`applyClaudeConfinement`: no permission bypass, `dontAsk`, the confined tool list, `env -i` + allowlist, the attempt temp dir); no agent authority in the tmux env; the prompt written to a 0600 file in the attempt temp dir and delivered by one fixed typed line; a deterministic startup driver (`runConfinedStartup`) that answers only the measured trust dialog (exact path, verified focus) and the browser offer's safe default and kills the session on anything else; `confinedDeliveredAt` saved only after the post-submit check; `sendKey`/`rawInject` refuse any key or text to a delivered confined session; the monitor loop skips both auto-answerers for confined sessions; boot kills an undelivered confined rerouted session; `confinedRerouteCapacity()`; the force-mode gate throws a typed `RerouteRefusedError`.
- **`src/core/confinedStartupDialogs.ts`** (new, pure): the pane classifier and the startup state machine, with the measured 2.1.300/2.1.303 frames as fixtures.
- **`src/core/rerouteRefusedError.ts`** (new).
- **Executor** (`FeedbackExecutorService`, `FeedbackExecuteStore`, `buildFeedbackExecutor`): admission defers a claim while the reroute lane is full (`reroute-capacity`, one degradation report after 12 consecutive saturated checks); a `RerouteRefusedError` ends the attempt `stopped` / `reroute-capacity` with its daily start refunded exactly once (`execution_refunds`, capped per claim day), never counting against the item.
- `Session.confinedDeliveredAt` (new optional field).

## What to Tell Your User

Nothing changes for you unless the feedback executor is on. If it is, and your agent runs Claude only through its subscription, its sandboxed fix sessions can now actually start: the two start-up questions Claude asks in interactive mode (trust this folder, use the browser) are answered safely and automatically, and anything unexpected stops the session instead of guessing.

## Summary of New Capabilities

- Confined sessions on the rerouted interactive lane with the same launch guarantees as the headless lane.
- A deterministic, fail-closed startup driver for Claude Code's interactive start-up dialogs.
- Typed reroute-capacity handling in the executor (defer, refund once, never park the item).

## Evidence

- `tests/unit/confined-startup-dialogs.test.ts` (20), `tests/unit/session-manager-confined-reroute.test.ts` (13), `tests/unit/feedback-factory/execute-reroute-capacity.test.ts` (5), `tests/unit/session-manager-confined-spawn.test.ts` (updated).
- `tests/e2e/confined-reroute-lifecycle.test.ts`: real tmux, production-shaped config, a fake interactive Claude drawing the measured dialogs.
- Live on the Mac Studio (2026-10-19, twice): the executor's session canary through the built SessionManager under `force`; trust answered, task delivered, 16/17 probes passed, planted project hook and MCP server did not run. The failing probe is `session-git-status`: Claude Code 2.1.303 writes `/tmp/claude-501/cwd-*`, which the executor's sandbox policy denies (it allows `/tmp/claude`), so every Bash command exits 1. That is the sandbox policy, not this change.

## Addendum (2026-10-20) — the stuck-input recovery regression this PR introduced, now fixed

The D3 confined-write guard reads two class-field Sets that exist only when the SessionManager
constructor ran. The pre-existing `tests/unit/session-multishot-recovery.test.ts` builds its manager
with `Object.create(SessionManager.prototype)`, so `.has()` threw a TypeError — and because
`fireStuckInputRecovery` and `verifyInjection` both deliberately swallow errors, the symptom was
silence: zero stuck-input recovery keys instead of the escalating four. Optional chaining on both Set
reads fixes it without touching what the guard decides (the refusal verdict comes from
`session.confinedConfigHome`, not from the Sets).

Also refreshes `pnpm-lock.yaml`: `@sagemindai/threadline-core@0.1.0` was added to `package.json` on
main without the pnpm lockfile, so every pnpm job failed `ERR_PNPM_OUTDATED_LOCKFILE` — which is what
made this PR's `UX assertions (messaging E2E)` check red. `package-lock.json` already carried it, which
is why the npm-based unit shards installed fine. The lockfile diff is +11/-0 and purely additive.

### Evidence

- Before: `tests/unit/session-multishot-recovery.test.ts` — 4 failed | 8 passed, with
  `[SessionManager] fireStuckInputRecovery error ... Cannot read properties of undefined (reading 'has')`
  logged on all four recovery attempts.
- After: **12 passed (12)**, zero swallowed `fireStuckInputRecovery` errors.
- D3 unchanged: `tests/unit/confined-send-keys-chokepoints.test.ts` +
  `tests/unit/confined-startup-dialogs.test.ts` — **23 passed (23)**.
- Lockfile: `@sagemindai/threadline-core` present in `pnpm-lock.yaml` (importer specifier, package
  resolution with integrity, and snapshot); `git diff --numstat` = +11 / -0.

## ELI16 — when a session got stuck, the thing that wakes it up had gone silent

Instar watches for a session whose typed message never submitted, and nudges it a few times, harder
each time, until it goes through. This change added a safety check in front of those nudges — a
confined, sandboxed session is not allowed to be typed into by anything except its own start-up
driver. The check looks up two lists to decide, and those lists only get created when a session
manager is built the full way. One of our tests builds a deliberately cut-down one, so the lookup
crashed.

The crash was invisible, which is the interesting part. Two layers above it are written to ignore
errors on purpose, because a background checker should never break the thing it is watching. So
instead of a loud failure, a stuck session simply got no nudges at all and stayed stuck. Asking for
those two lists more carefully — "if they exist" rather than assuming they do — fixes it. The safety
check keeps its teeth, because what it actually decides comes from the session record itself, not from
those lists: a genuinely sandboxed session is still refused.

One unrelated thing rides along, because it was failing this change's own checks: a dependency was
added to the project's package list on the main branch without updating one of the two lock files that
pin exact versions. Any build step using that lock file refused to install. Regenerating it adds the
missing entry and nothing else.
