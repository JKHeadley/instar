# Side-effects review — credential rotation (PR 7 of tunnel-failure-resilience chain)

**Scope (PR 7 of the chain):** Make `authToken` + `dashboardPin`
rotation real on every terminal exit from `relay-active`, plus
boot-recovery. The `rotationPending` flag (set on relay-active entry in
PR 5, persisted to `tunnel.json`) is now consumed: rotating the
authToken invalidates every previously-signed view URL and the dashboard
session — the documented UX cost of having briefly routed private
traffic through a third-party relay. Spec Part 6.

**Files touched:**
- `src/server/middleware.ts` — `authMiddleware` accepts `string | (() =>
  string | undefined)` and resolves the token **per request**, so a
  runtime rotation takes effect immediately (no restart). Backward
  compatible: the string form is byte-identical to before.
- `src/server/AgentServer.ts` — wires the live getter
  `authMiddleware(() => this.config.authToken, …)`. `this.config` is set
  in the constructor and never reassigned, so the getter always reads the
  shared, mutable config object.
- `src/tunnel/TunnelManager.ts` — `setCredentialRotator(fn)`,
  `runCredentialRotation(reason)` (gated on `rotationPending`,
  clears-only-after-success), `recoverPendingRotation()` (boot path), and
  a rotation trigger at the end of `stop()`.
- `src/commands/server.ts` — the rotator closure (regen PIN + authToken →
  `liveConfig.set` + mutate the in-memory `config` → owner DM with the new
  PIN), wired right after tunnel construction; boot-recovery awaited
  **before** `server.start()`.
- Tests: `tests/unit/tunnel-credential-rotation.test.ts` (6),
  `tests/unit/auth-middleware-live-token.test.ts` (5).

**Over-block:** None. The middleware resolves `string → itself`, so all
existing string callers and the 75 auth/tunnel tests are unchanged.

**Under-block:** The getter returning `undefined` means "open" (the
documented test/dev passthrough), same as the old `authToken === undefined`
behavior. In production `authToken` is always set (init generates it;
rotation always assigns a fresh non-empty UUID). The rotator does
`config.authToken = newToken` as a single synchronous assignment after
the `liveConfig.set` calls — there is no window where the live token is
`undefined`; a concurrent in-flight request reads either the old or the
new token, never empty. The instant the assignment lands, the old bearer
token and old signed URLs are rejected (asserted by the rotation tests).

**Level-of-abstraction fit:** The manager owns the WHEN (lifecycle
triggers + the `rotationPending` invariant); the injected closure owns
the WHAT (regenerate/persist/notify). The manager never imports config or
messaging. Mirrors the PR 6 `attachTelegram` seam.

**Signal vs authority:** `rotationPending` is the single-writer
authoritative marker owned by `TunnelLifecycle`. `runCredentialRotation`
clears it **only after** the rotator resolves; a thrown rotator leaves it
set so the next `stop()` or next boot retries (tested). No abstraction
treats a low-context signal as authority.

**Interactions:**
- Boot-recovery runs before `server.start()` (verified ordering:
  rotator wired at tunnel-construction ~L4846 → boot-recovery at L7305 →
  listen inside `server.start()`). The owner DM uses `sendToOwnerDM`
  (private chat), so it does not depend on the Dashboard topic being
  ensured yet.
- The startup `dashboardPin` auto-gen (`if (!config.dashboardPin)`) runs
  after boot-recovery, so a boot-recovery rotation is not clobbered.
- `signViewPath` (routes.ts) and `verifyViewSignature` (middleware) both
  read the live token, so post-rotation: new view URLs are signed with
  the new token and old shared URLs fail verification — the intended
  invalidation (tested).
- The 6-digit PIN keeps the existing `Math.random` generator (a
  convenience factor, not the primary secret); `authToken` is
  `randomUUID()` and is the HMAC key. No change to the secret model.

**Migration parity:** No agent-installed files change. The rotation is
runtime behavior in `server.ts` (every agent runs the new server after
update) and an internal middleware refactor; no new config field, no
CLAUDE.md/hook change (those land in PR 9). `rotationPending` already
existed in the persisted schema since PR 5.

**Tier-2/Tier-3 note:** PR 7 adds no HTTP route — per spec Part 8 the
HTTP-assertable "feature is alive" surface is the `/tunnel` route in
PR 9. PR 7's security guarantee is covered by the live-token middleware
unit tests (both sides of the boundary + view-URL invalidation) and the
manager rotation-lifecycle tests; the boot-recovery wiring is verified at
the `server.ts` call site.

**Rollback cost:** Low. The middleware change is backward compatible;
revert = restore the string arg at the AgentServer callsite, drop the
manager rotation methods + `stop()` trigger, and remove the server.ts
rotator closure + boot-recovery call. No schema or persistent-state
migration (rotated PIN/token are just new values).
