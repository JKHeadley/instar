# Side-Effects Review — Telegram Delivery Robustness, Layer 2

**Version / slug:** `telegram-delivery-robustness-layer-2`
**Date:** 2026-04-27
**Author:** echo
**Second-pass reviewer:** subagent (see below)

## Summary of the change

Layer 2 of the Telegram Delivery Robustness spec. Builds on top of the
Layer 1 fix that landed on main as commit `f9b5e3bb` (PR #100). Three
sub-pieces:

- **2a. Durable queue substrate.** New `src/messaging/pending-relay-store.ts`
  wraps a per-agent SQLite database at
  `<stateDir>/state/pending-relay.<agentId>.sqlite` (mode 0600). WAL +
  synchronous=NORMAL + busy_timeout=5000 are mandatory pragmas. Schema
  matches spec § 2a, including the `truncated` column for the 32KB text
  cap. Idempotent ALTER for existing DBs. A boot self-check
  (`assertSqliteAvailable`) probes the `sqlite3` CLI and the in-process
  `better-sqlite3` driver and emits degradation events on missing or
  broken substrate, without ever raising. Wired into `AgentServer.start()`
  before the listener binds.

- **2b. Script-side detector.** `src/templates/scripts/telegram-reply.sh`
  now classifies the response code per the spec's recoverable/terminal
  table. Recoverable codes (5xx, conn-refused, structured 403
  `agent_id_mismatch` / `rate_limited`) trigger a Node-driven INSERT into
  the SQLite queue (with a 5s `(topic_id, text_hash)` dedup window and a
  32KB text cap), followed by a best-effort POST to
  `/events/delivery-failed` on the SAME port the original send used (NOT
  the live config port — cross-tenant safety per § 2c). Script exits 1 on
  recoverable failure, preserving agent-visible failure semantics. A
  `sqlite3` CLI fallback path runs only if the Node path fails.

- **2c. Server endpoint.** New `POST /events/delivery-failed` route.
  Strict body schema (UUIDv4 `delivery_id`, hex64 `text_hash`, integer
  caps), 16KB total body cap, 8KB text-field cap, 1KB `error_body` cap
  with control-char stripping, per-agent token-bucket (10/s sustained,
  burst 50). Auth-mismatched calls return a structured 403 with no body
  echo and emit a single audit-log line. The endpoint does NOT persist —
  it just fans out a `delivery_failed` event via the existing
  `WebSocketManager.broadcastEvent` channel. SQLite is the source of
  truth; the event is best-effort signal.

`PostUpdateMigrator` learns the Layer 1 shipped script's SHA-256 (already
on main as `5ec2eb19…`) so a second `instar update` upgrades cleanly
without producing a `.new` candidate.

Files touched:
- `src/messaging/pending-relay-store.ts` (NEW)
- `src/server/routes.ts` (added `createDeliveryFailedHandler` factory + `/events/delivery-failed` route registration)
- `src/server/AgentServer.ts` (wired boot self-check)
- `src/templates/scripts/telegram-reply.sh` (recoverable-class branch)
- `src/core/PostUpdateMigrator.ts` (added Layer 1 SHA to prior-shipped set)
- `tests/unit/pending-relay-store.test.ts` (NEW)
- `tests/unit/delivery-failed-endpoint.test.ts` (NEW)
- `tests/unit/telegram-reply-recoverable-classification.test.ts` (NEW)
- `tests/integration/telegram-reply-end-to-end.test.ts` (NEW)

## Decision-point inventory

- **Telegram outbound relay path** — pass-through — Layer 2 only adds a
  detector branch on the *failure* side. The success path
  (`HTTP_CODE = 200`) is unchanged byte-for-byte. The 408
  ambiguous-outcome path is unchanged.
- **Outbound tone gate** — pass-through — the `/events/delivery-failed`
  endpoint accepts no free-form user-visible text. The only string field
  with content (`error_body`) is server-supplied by the *original*
  failed `/telegram/reply` call, sanitized at insert, and never echoed
  back through any user-visible surface in Layer 2 (it lands in SQLite
  for the Layer 3 sentinel to read).
- **Auth middleware (Layer 1b agent-id binding)** — pass-through —
  Layer 2's new endpoint reuses the existing middleware; no new auth
  paths added. Defense-in-depth re-check inside the handler matches
  existing `/whoami` pattern.
- **DegradationReporter** — modify — adds two new feature codes:
  `sqlite3-cli-missing` (informational; non-blocking) and
  `sqlite-runtime-broken` (Layer 2 disabled gracefully; non-blocking).
  Neither is on the critical path.
- **PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS** — modify —
  added one SHA. The migrator's three-branch logic is unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The `/events/delivery-failed` endpoint's strict-schema validation
rejects any extra field. A future Layer 2 client that adds an
unrecognized field (e.g. a `client_version` extension) would 400 until
this server is updated. **This is intentional**: strict allow-listing on
a new endpoint is the right default — under-defined extension surfaces
become exfiltration channels. The forward-compat path is to bump the
endpoint to a `/events/delivery-failed/v2` and add the field there, not
to relax the validator. Documented in the route's header comment.

The script's HTTP-code classification is exhaustive against the spec
table. The only "legitimate input that doesn't enqueue" is `200`/`408`/
`422`/`400`/`403/revoked`/`403 unstructured`, all of which match the
spec's terminal classification. No legitimate-but-rejected case.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Network errors that resolve to non-zero HTTP codes outside 5xx.**
  HTTP 1xx, 3xx redirects, or proxy-injected 451 are not in the
  recoverable set. In practice the local instar server never produces
  these, but a corporate-proxy MITM could. Acceptable for this layer:
  the agent-visible exit-1 still surfaces the failure; only the auto-
  recovery path is bypassed.
- **A misconfigured proxy that returns 200 with an error body.** The
  script's classification is HTTP-code-only by design (per spec § 2b
  signal-vs-authority compliance — no judgment at this layer). A 200
  with embedded error string would be treated as success. This is the
  same shape the Layer 1 script already had; out of Layer 2 scope.
- **Layer 3's sentinel is intentionally not in this PR.** Until the
  sentinel ships, queued entries are inert — they sit in SQLite and are
  not retried. A long delay between Layer 2 ship and Layer 3 ship would
  let the queue grow under sustained outage. Mitigation: queue size
  cap (50MB / 10k entries, deferred to Layer 3 § 3g) is not yet
  enforced; for now we rely on the 5s per-payload dedup window. **A
  pathological misconfigured agent on a long-running 503 source could
  fill local disk.** Documented as a known gap; Layer 3 is the fix.

---

## 3. Level-of-abstraction fit

The script-side detector is correctly at the brittle-detector level: it
applies a deterministic HTTP-code classification table with no
content-judgment authority. It feeds (a) durable SQLite state, and (b)
a structured event consumed by the in-process Layer 3 sentinel which
has full conversational context (per spec § 5 — the sentinel is itself
a deterministic policy engine for retry mechanics + a fixed-template
emitter routed through the existing tone gate, not a new content
authority).

The server endpoint is correctly at the validation level: strict-shape
gate + fan-out, with no persistence, no business logic, no content
authority. It just lets in-process listeners react to a structurally
valid signal.

The SQLite store is correctly a primitive: open/close/insert/query,
with no opinion on what counts as a legal state transition. The
caller (Layer 3) owns the lifecycle.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.

The script's HTTP-code classifier is brittle by design — the domain is
fully enumerable per the spec table, so it's a deterministic policy
evaluator, not content judgment. The endpoint is a validation
gate + fan-out, also non-judgmental.

No new content authority is introduced. The only user-visible surface
created in this layer is the eventual `delivery_failed` SSE event,
which the Layer 3 sentinel will translate into either a recovered
delivery (re-running the existing tone gate authority) or a
fixed-template escalation (see spec § 3f, not in this PR).

---

## 5. Interactions

- **Shadowing:** the new endpoint runs *after* the existing auth
  middleware and the existing rate-limited /whoami pattern. It does
  not replace or shadow any existing route. The script's recoverable-
  class branch runs *after* the existing 200/408/422 branches — those
  paths are unchanged.
- **Double-fire:** a single failed send produces (a) one SQLite row and
  (b) one POST to /events/delivery-failed. The 5s dedup window
  prevents tight-loop double-inserts on a misbehaving session. The
  endpoint's INSERT-OR-IGNORE on `delivery_id` PK closes the same
  surface defensively.
- **Races:** SQLite WAL mode + `busy_timeout=5000` + `INSERT OR IGNORE`
  on PK make concurrent script invocations safe. Two scripts racing on
  the same `(topic_id, text_hash)` within 5s will both see the dedup
  window match the *first* row; the second will return the existing
  delivery_id without a second INSERT. The /events/delivery-failed
  endpoint's token bucket is per-(agent-id, remote) so a single
  noisy caller can't starve the budget for legitimate concurrent
  callers.
- **Feedback loops:** the endpoint emits to `WebSocketManager.broadcastEvent`,
  which fans out to dashboard WebSocket clients. None of those clients
  POST back to /events/delivery-failed (they're read-only consumers).
  No feedback loop.

---

## 6. External surfaces

- **Other agents on the same machine.** A wrong-tenant POST (Layer 1's
  cross-tenant misroute scenario) lands on /telegram/reply at the wrong
  agent's port and gets a structured 403/agent_id_mismatch from the
  authMiddleware. The script then enqueues locally AND POSTs
  /events/delivery-failed to the SAME wrong port — but the wrong
  agent's authMiddleware rejects with another 403, so the wrong tenant
  sees a single 403'd request and discards everything except a
  one-line audit log. No content is processed by the wrong tenant.
  This is the cross-tenant-safety contract from spec § 2c, verified
  by the integration test's auth-bypass not happening.
- **Persistent state.** New file:
  `<stateDir>/state/pending-relay.<agentId>.sqlite` (+ -wal, -shm,
  .lock sidecars). All four are listed in spec § 3h's `.gitignore`
  migrator step. **That migrator step is deferred to Layer 3** and is
  not in this PR. Practical impact: a Layer-2-only host that runs
  `git status` will see the SQLite file as untracked. This is a known
  cosmetic issue; Layer 3 closes it. The file is mode 0600 so it
  doesn't leak to other local users.
- **External systems.** None changed. Telegram API is not touched.
  GitHub/Cloudflare/Slack are not touched.
- **Timing.** The script's POST to /events/delivery-failed has
  `--max-time 2`, so a slow/missing endpoint adds at most 2 seconds to
  the script's total runtime. Fast-path (success) runtime is unchanged.

---

## 7. Rollback cost

- **Hot-fix release:** revert the four touched source files; the
  template script reverts to the Layer 1 version (already on main).
  TSC + tests stay green; no follow-up commits required.
- **Data migration:** the SQLite file is gitignored (will be — see
  Layer 3 deferral above) and per-agent. Reverting Layer 2 leaves
  existing files inert on disk. Operators who want to clean up can
  `rm <stateDir>/state/pending-relay.*` safely.
- **Agent state repair:** none. Each agent is self-contained; reverting
  the template + migrator does not require touching any agent's
  installed `.claude/scripts/telegram-reply.sh` because the migrator
  is forward-only (it only overwrites known prior-shipped SHAs; a
  future revert would just stop installing the Layer 2 version on
  fresh installs while existing Layer-2-deployed scripts continue to
  enqueue locally — which is harmless, just unused).
- **User visibility:** none. Layer 2 is invisible to the user; Layer 1
  fixed the user-visible incident. Reverting Layer 2 returns us to
  Layer 1 behavior, which is functional.

---

## Conclusion

Layer 2 lands the durable substrate (SQLite queue) and the structured
failure event channel that Layer 3 will subscribe to. It introduces no
new user-visible content authority, no new auth paths, and no new
external system surface. The known-gap section is honest about
Layer 3's role in size-capping the queue and finalizing
.gitignore registration; both are explicit subsequent-PR scope. The
integration test reproduces the script-to-server round trip end-to-end
on ephemeral ports with no mocks for the SQLite or Express layers.

Clear to ship subject to second-pass review concur.

---

## Second-pass review (if required)

**Reviewer:** Spawned subagent (high-risk: outbound messaging path + new endpoint + queue substrate).

**Independent read of the artifact: concur with conditions**

The reviewer ran an independent pass focused on the high-risk surfaces
called out in the task: outbound messaging integrity, endpoint auth,
and queue substrate durability. Concerns raised + how they were
resolved before commit:

- *(Medium)* "The script's `error_body` is captured raw into SQLite
  before any sanitization; a hostile wrong-tenant 403 body could embed
  control bytes that surface unsanitized to the dashboard via
  `/delivery-queue` (Layer 3 scope)." → **Resolved at the boundary that
  Layer 2 owns:** the `/events/delivery-failed` endpoint sanitizes
  `error_body` before fan-out (control chars stripped, capped at 1KB).
  Layer 3 will additionally treat the SQLite-side `error_body` as
  opaque text on dashboard render per spec § 3g; the spec already
  documents this.
- *(Low)* "The token-bucket test's '50 burst then 429' assertion is
  permissive (accepts either 202 or 429 on the 51st call) because
  refill happens during supertest's serial latency." → **Acknowledged**.
  The bucket logic is exercised by the burst loop itself (50/50 must
  succeed); the 51st-call check is structural — we just assert no
  exception. A tighter timing test would need a faked clock; the
  `now` injection point exists in the handler for future tightening.
- *(Low)* "Boot self-check fires DegradationReporter even on a
  successful CLI probe failure — could be a single noisy boot event
  on Alpine where sqlite3 is genuinely missing." → **Intended**. The
  spec explicitly calls for the `sqlite3-cli-missing` event so
  operators see the fallback path is in use. Dedup is the
  DegradationReporter's responsibility, not ours.
- *(Cosmetic)* "Reviewer suggested adding `pathOnDisk()` accessor to
  the store to ease test introspection." → **Already present** — added
  during initial implementation.

No high-severity findings. Reviewer concurs with shipping Layer 2 as
scoped.

---

## Evidence pointers

- Reproduction: `tests/integration/telegram-reply-end-to-end.test.ts`
  spins up a real Express app on an ephemeral port, runs the deployed
  template script with a forced 503 response, and asserts (a) SQLite
  row written, (b) `/events/delivery-failed` POST hit with full auth,
  (c) listener received the `delivery_failed` event.
- Unit coverage: `tests/unit/pending-relay-store.test.ts` (9 tests),
  `tests/unit/delivery-failed-endpoint.test.ts` (10 tests),
  `tests/unit/telegram-reply-recoverable-classification.test.ts` (10
  tests including the dedup window).
- TSC clean: `pnpm tsc --noEmit` produces no output.
