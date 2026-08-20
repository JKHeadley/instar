# Side-Effects Review — Account-follow-me cross-machine sign-in budget chain

**Version / slug:** `followme-timeout-budget-chain`
**Date:** `2026-08-20`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `required — see Phase 5 below`

## Summary of the change

A cross-machine "Set up" tap on the Subscriptions grid nests FOUR timeout budgets, and the outermost was the SMALLEST. `POST /subscription-pool/matrix/start-cell` and the target's `POST /subscription-pool/follow-me/enroll/start` both inherited the 30s global default, while the relay fetch between them was hard-coded to 40s and the pane-scrape underneath was configured to 180s (`multiMachine.accountFollowMe.remoteScrapeTimeoutMs`). Every cross-machine tap slower than 30s therefore got a bare `408 {"error":"Request timeout"}` from the middleware while the handler was still legitimately working — destroying the handler's own classified outcome (`502 login-did-not-start / retryable`, `409 cannot-resolve-email`, `201 reused`). Reported live by the operator (Justin, topic 50436, 2026-08-20) as "Couldn't start: Request timeout" against a Cloudflare-routed peer.

The fix derives the whole chain from the single operator knob via `resolveFollowMeBudgets()` in `src/server/middleware.ts`, wires four per-path overrides into `buildRequestTimeoutOverrides()`, threads the config value through `src/server/AgentServer.ts`, and replaces the three hard-coded `AbortSignal.timeout(40_000)` literals in `src/server/routes.ts` with derived/named values. A new unit test asserts strict outermost-largest ordering across four knob values so the chain cannot silently re-invert.

Files touched: `src/server/middleware.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`, `tests/unit/followme-timeout-budget-chain.test.ts` (new), `tests/unit/AgentServer-outbound-timeout.test.ts` (wiring assertion widened for the multi-line call + the new arg).

## Decision-point inventory

- `requestTimeout` middleware (`src/server/middleware.ts`) — **modify** — a timer-based terminal authority; its threshold for four follow-me paths changes from the 30s default to derived budgets. No new decision surface, no new condition; only the numeric bound moves.
- `matrix/start-cell` relay abort (`src/server/routes.ts`) — **modify** — hard-coded 40s becomes `resolveFollowMeBudgets(...).relayFetchMs`.
- `follow-me/submit-code` + `follow-me/cancel` relay aborts — **pass-through** — same 40s value, now the named `FOLLOWME_SIMPLE_RELAY_FETCH_MS` constant instead of a bare literal.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change moves exclusively in the permissive direction. Every affected budget strictly increases (30s → ≥100s for start-cell at the default knob; 30s → ≥90s for enroll/start; 30s → 60s for the two simple relays). No request that previously completed can now be cut short.

The specific over-block being REMOVED: a cross-machine sign-in on a peer reachable only over Cloudflare routinely needs 30–60s just to spawn the CLI and scrape the device code. Every one of those was rejected with a message carrying no diagnostic value.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A genuinely hung peer now holds a socket longer.** At the operator's configured 180s knob, `start-cell` holds up to 235s before the middleware fires. That is the intended trade — the alternative is cutting off legitimate work — but a wedged peer is now discovered later. Bounded, never unbounded: the relay's own `AbortSignal` fires first, so the handler always returns before the route budget.
- **The 15s mandate-delivery bound is mirrored, not imported.** `FOLLOWME_MANDATE_DELIVERY_BUDGET_MS` duplicates the `timeoutMs: 15_000` literal in `src/commands/server.ts`. If someone raises that literal without touching the constant, the chain loses slack silently. The test cannot catch this (the value lives behind a closure in a different module). Flagged for the second-pass reviewer; the honest mitigation today is the comment naming the source line.
- **Nothing here bounds the pane scrape itself.** If `remoteScrapeTimeoutMs` is set absurdly high, the whole chain scales with it. That is the operator's knob and deliberately so.

---

## 3. Level-of-abstraction fit

Correct layer, and the change is specifically about restoring layer precedence.

The `requestTimeout` middleware is the lowest-context participant in this stack: it knows only elapsed milliseconds. The route handler is the high-context one — it knows which peer it is waiting on, holds its own bounded sub-budgets, and produces classified, actionable outcomes. The bug was the low-context timer pre-empting the high-context handler and overwriting its verdict with a contentless one.

The fix does not add a layer or move logic between layers. It makes the outer bound a function of the inner bounds so the smart layer always gets to answer first. Deriving from one source (rather than adding a fourth independent constant) is what stops this from being the fourth spot-fix in the same family — `OUTBOUND_MESSAGING_TIMEOUT_MS`, `PARITY_PASS_TIMEOUT_MS` and `POOL_TRANSFER_TIMEOUT_MS` each fixed one instance of this class and left the next nested route nothing to inherit.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface** (in the sense the principle governs).

The principle governs *judgment* decisions — blocking based on what a message means or what an agent intends. A request timeout is explicitly named in the doc's "When this principle does NOT apply" section: it is transport-layer mechanics, not a judgment call, and it evaluates no content.

That said, the bug has a genuine signal-vs-authority shape worth recording: a brittle, zero-context detector (an elapsed-time counter) held terminal authority over a context-rich authority (the handler) and replaced its reasoned verdict with a contentless one. This change removes brittle authority's ability to pre-empt the contextual one. It adds no new blocking power anywhere.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no competing live signals here — the ordering constraint is an arithmetic invariant (an outer bound must exceed the inner bounds it wraps), the domain is fully enumerable, and the invariant is named and asserted in the unit test rather than tuned.

---

## 5. Interactions

- **Shadowing:** The four new entries are matched by the existing longest-prefix matcher (`resolveRequestTimeout`). `'/subscription-pool/follow-me/enroll'` deliberately covers the parameterised target-side `enroll/:id/submit-code` and `enroll/:id/cancel`, because the S7 email gate runs there and a 408 mid-add would strand an enrollment. Verified the prefix does NOT swallow unrelated siblings: an explicit test asserts `/subscription-pool`, `/subscription-pool/poll` and `/subscription-pool/swap` stay on the 30s default. The matcher's `path === prefix || path.startsWith(prefix + '/')` rule means `'/subscription-pool/follow-me/submit-code'` (the FRONTING relay) is a distinct, longer-matching key from the enroll prefix and gets its own budget — confirmed by test.
- **Double-fire:** None. A route resolves exactly one budget; the map is a plain lookup.
- **Races:** None. `buildRequestTimeoutOverrides()` is called once at server construction and produces an immutable map. `resolveFollowMeBudgets()` is pure.
- **Feedback loops:** None. Nothing consumes these budgets as input to anything that adjusts them.
- **Retry interaction (checked, no change needed):** the earlier concern that a timeout could strand or duplicate a pending login on the peer proved unfounded. The target's `enroll/start` already reuses a live pending login unconditionally for self AND peer targets (`src/server/routes.ts`, the D5 single-attempt block), so the spec's "a retry never duplicates a pending login" invariant already held end-to-end. No idempotency change was made; the `if (isSelf)` guard on the coordinator's pre-check is correct as written.

---

## 6. External surfaces

- **Other agents on the machine / install base:** no behavioural change unless account-follow-me is enabled AND the agent is multi-machine. Single-machine agents never take the peer branch.
- **External systems:** none. No provider, Telegram, or GitHub surface is touched.
- **Persistent state:** none. No new files, columns, or ledger entries.
- **Timing/runtime conditions:** yes, by definition — the change is about time budgets. Sockets on the fronting machine are held longer for cross-machine taps (see §2).
- **HTTP response shapes:** unchanged. The same statuses are produced; operators simply now receive the handler's real one instead of a 408 that pre-empted it.
- **Operator surface (Mobile-Complete Operator Actions):** no new operator-facing action. The change makes an EXISTING phone-completable action (the grid's "Set up" / code-paste / cancel cells) actually complete on a slow peer. Nothing moves off the phone.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No file under `dashboard/` is staged; the dashboard's rendering, wording, and layout are untouched. The change is confined to server-side timeout budgets that the existing grid consumes through unchanged response shapes.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN, with a derived cross-machine contract.**

Each machine computes its own budgets from its OWN `remoteScrapeTimeoutMs`, because the budget must bound work happening on THAT machine's hardware and network path. Replicating a single pool-wide budget would be wrong: a Cloudflare-only peer legitimately needs a larger scrape budget than a Tailscale-local one.

The cross-machine contract that DOES matter is the ordering between the fronting machine's relay budget and the target's route budget. This is the one genuine multi-machine finding, and it is stated honestly rather than assumed away:

- **If the fronting machine's knob is set LOWER than the target's**, the fronting relay can abort while the target is still legitimately working. The result is the honest, retryable `502 "could not reach the machine doing the login"` — degraded but truthful, and the target's pending login is reused on retry rather than duplicated (§5). It is never a silent success or a fabricated state.
- The safe direction is therefore preserved under skew, which is why this ships without a cross-machine budget negotiation. Negotiating the budget over the mesh would put another round-trip inside the very path being fixed.
- Operators who set a non-default knob should set it on every machine. <!-- tracked: CMT-036 -->

**User-facing notices:** none emitted — no one-voice gating needed.
**Durable state:** none held — nothing to strand on topic transfer.
**Generated URLs:** none. The `verificationUrl` is produced by the provider and passed through unchanged.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code change, ship as next patch. Pure code change.
- **Data migration:** none. No persistent state is written or read.
- **Agent state repair:** none. Budgets are computed at server construction; a restart fully reverts.
- **User visibility:** reverting restores the 2026-08-20 bug (cross-machine "Set up" 408s on slow peers). No NEW regression is introduced by rolling back, and no state written under the fix would be left behind.

---

## Conclusion

The review produced two design changes. First, the fix was widened from the one reported route to the whole four-level chain after a sweep of every `AbortSignal.timeout` in route scope found three inverted routes, not one — including `follow-me/submit-code`, which is the more severe instance because a verification code is single-use and a 408 there leaves the operator unable to tell whether their one shot was spent. Fixing only the reported route would have moved the operator's failure one step later in the same flow. Second, an intended idempotency change was DROPPED after verification showed the invariant already held on the target side; the original premise (a self-only carve-out breaking spec conformance) was wrong.

One honest weakness is carried rather than hidden: the 15s mandate-delivery bound is mirrored as a constant rather than imported, so a change to the source literal would erode slack without failing a test (§2). Flagged for second-pass.

Clear to ship pending second-pass review, which IS required — this change touches session/enrollment lifecycle and a gate-adjacent middleware.

---

## Second-pass review (if required)

**Reviewer:** Echo (SELF-review — NOT independent)
**Independent read of the artifact: not obtained**

**Honest status.** Phase 5 requires an INDEPENDENT reviewer subagent for changes touching session lifecycle and gate-adjacent middleware, and this change qualifies. This session operates under a standing constraint prohibiting subagent spawning, so no independent reviewer read this artifact. What follows is an adversarial self-review. It is recorded as such rather than as a concurrence, because a self-review labelled "independent" is exactly the confabulation the cross-agent discipline forbids — the reviewer here shares every blind spot of the author. **A genuine second pass is still owed on this change** and should happen at PR review. <!-- tracked: CMT-036 -->

**Adversarial checks actually run (each verified against the code, not reasoned about):**

1. **Is the router mounted at a prefix that would break path matching?** No — `this.app.use(routes)` at `AgentServer.ts:4179` mounts at root, so `req.path` carries the full path and the new prefixes match. Had it been mounted under e.g. `/api`, all four entries would have been silently dead. Checked because a dead override would leave the bug in place while the unit test passed against the map in isolation.
2. **Does the timeout middleware actually wrap these routes?** Yes — registered at ~line 1200, routes at 4179. Registration order is the wrapping order in Express.
3. **Does `'/subscription-pool/follow-me/enroll'` over-match?** It intentionally covers the parameterised `enroll/:id/submit-code` and `enroll/:id/cancel` on the target. It does NOT match the fronting relays `follow-me/submit-code` / `follow-me/cancel` (different segment), which carry their own keys. Asserted by test, including a containment test that `/subscription-pool`, `/subscription-pool/poll`, `/subscription-pool/swap` stay on the default.
4. **The self-target loopback case.** When `machineId === selfMachineId`, start-cell calls its OWN server's enroll/start, so two nested requests hit the same middleware. Ordering still holds (`startCellRouteMs > relayFetchMs > enrollStartRouteMs`), so the inner request cannot outlive the outer one. This case is easy to miss because it is not the reported scenario.
5. **Could a timeout evade the sweep via `AbortController` + `setTimeout`?** One such site exists in `routes.ts` (`/telemetry/disable`, 5s) — well under the default, not an inversion. No other route-scope instance.
6. **Does the change move any budget DOWN?** No. Every affected value strictly increases; no previously-succeeding request can now be cut short.

**Concerns raised by this pass, carried into the artifact rather than resolved:**

- **The mirrored 15s constant (§2).** `FOLLOWME_MANDATE_DELIVERY_BUDGET_MS` duplicates a literal in another module behind a closure. No test can bind them. This is a real, if small, drift surface and the honest mitigation today is only a comment naming the source.
- **Cross-machine knob skew (§7).** Fails safe, but degrades. Not resolved here because negotiating budgets over the mesh would add a round-trip inside the path being fixed.
- **Later detection of a wedged peer (§2).** Accepted trade, stated plainly rather than buried.

**Self-review verdict:** the change is sound and its weaknesses are stated rather than hidden — but this verdict carries the weight of a self-review only.

---

## Evidence pointers

- Negative control: reverting the four override entries fails the new test with 18 failures naming each inverted route; restoring passes 29/29.
- Affected integration suites green: `account-matrix-start-cell-route`, `account-follow-me-submit-code-route`, `account-follow-me-cancel-route`, `account-follow-me-enroll-start-route` — 51 tests.
- Live diagnosis: `GET /subscription-pool?scope=pool` on the reporting agent; `/mesh/rope-health` showing the target peer carrying only `lan` + `cloudflare` ropes (no Tailscale), i.e. the slow path that made a 30s budget routinely insufficient.
