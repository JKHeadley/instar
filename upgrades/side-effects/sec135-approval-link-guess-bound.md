# Side-Effects Review — Confirm-page PIN guesses from strangers go through the sign-in limits (SEC-135)

**Version / slug:** `sec135-approval-link-guess-bound`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `echo (separate pass over the security-sensitive diff, recorded below)`

## Summary of the change

Spec: `docs/specs/sec135-approval-link-guess-bound.md` (approved by Justin 2026-11-21 10:16 PST, Telegram topic 141385: accept the experience cost at medium, faster staged path (b)).

The recommended-services confirm page gave every page open its own 5-guess PIN budget, and anyone could open 30 a minute, so about 9,000 PIN guesses an hour per machine were possible. Behind one dev-gated switch, `security.approvalLinks.enabled`:

- `src/server/AgentServer.ts`: the sign-in closures are split into a decision (`publicPinAdmission`) and sign-in/step-up's renderer (`publicPinAdmit`, bodies unchanged); `publicPinFailure` charges every durable key in one write and takes extra keys; `readCurrentPin` is sign-in's own PIN read. A new synchronous `publicPinVerify` (insecure-connection first, class admission, per-request key, constant-time compare, one-write charge, in-memory per-request fallback) and `publicPinContext` are exposed as `ctx.publicPin` (`src/server/publicPinHook.ts`).
- `src/core/PinAttemptStore.ts`: `recordFailures(keys)` (one persist) and `windowSeconds`; `recordFailure` delegates to it.
- `src/server/routes.ts`: the switch (`resolveDevAgentGate`), `verifyConfirmPin` and `ownerOpen` deps for the recommended-services routes. `checkConfirmPin` stays as the off path; `/mcp/approve/:id` and the email-code route are untouched.
- `src/server/recommendedServiceRoutes.ts`: the confirm POST renders the verifier's verdict (fixed `pin-paused` wording on the public path, a separate one on marker/local); the GET gives owner opens their own allowance and protected tokens, `too-many-pages` with a refill time, `allProtected` for an owner open when all 50 are protected; `confirmStats` in `GET /recommended-services`; graduation evidence rows.
- `src/recommended/confirmTokens.ts`: `mint(binding, { protected })`, owner allowance, eviction rules; no options = old behaviour exactly. `src/recommended/confirmStats.ts`: the counters, flushed at most once a minute.
- `dashboard-pair/service-yes.js`: `X-Instar-Request` on the open, retry brakes, the new messages.
- `src/server/middleware.ts`: a comment at the CORS allow-header list.
- Registries: `src/core/devGatedFeatures.ts`, `src/data/feature-ladders.json` (`security.approvalLinks`), `src/data/state-coherence-registry.json` (`pin-attempts`, `recommended-service-confirm-stats`), awareness entry `src/data/awareness/approval-link-guess-bound.md`.

## Decision-point inventory

- Confirm-answer admission (public path) — modify — from "per-token budget only" to sign-in's public limits plus the per-token budget (invariant per spec: same numbers as sign-in).
- Confirm-answer admission (marker / local paths) — modify — sign-in's marker path and local budget, plus the per-token budget.
- Confirm-page mint (owner open) — add — separate 30/min allowance, protected rows.
- Token eviction at the 50-per-service cap — modify (switch on only) — oldest unprotected; refuse when all are protected.
- Sign-in and step-up admission — pass-through — refactored onto the same functions, answers unchanged.

---

## 1. Over-block

The intended cost, accepted by the owner: an owner on a browser that never unlocked the dashboard, away from the machine, is refused while a public limit is reached (an attack, their own repeated wrong tries, or their network's allowance spent), exactly as on sign-in. They see a message naming the ways through. A local process flooding owner opens can fill the 50 protected rows for a service; the owner then sees the "still active" message (inherited local gap, spec section 3). A many-tab browser restore beyond 30 owner opens a minute retries with brakes and may give up after three tries with a reload message.

---

## 2. Under-block

- A process on the machine itself reaches the local path (bounded by the 10-per-5-minute local budget), as on sign-in.
- A stolen remembered-browser marker uses the marker path (its own backoff and abuse cap of 50), as on sign-in.
- The fleet keeps today's exposure until the maturation review graduates the switch (accepted, faster staged path).
- `/mcp/approve/:id` is out of scope by design: a stranger cannot mint its request ids.
- The email-code route keeps today's public aggregate (unchanged by design).

---

## 3. Level-of-abstraction fit

Right layer: the limits are sign-in's own, reached through one hook beside sign-in, so the two surfaces cannot drift. The confirm route only renders the verdict. No parallel limiter is added.

---

## 4. Signal vs authority compliance

- [x] Yes — but the logic is deterministic rate limiting on an irreversible-consequence boundary (a guessed PIN grants owner authority), which the spec classifies as an invariant.

These are rate controls, not judgments: they bound guess counts and never decide identity. A marker or local connection only picks the allowance; the PIN remains the only proof.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals point. Every number is piece 1c's shipped sign-in policy. The owner allowance (30/min, 50 rows) is the spec's declared judgment-candidate with floor, arbiter and fallback (the existing store values).

---

## 5. Interactions

- Sign-in and confirm answers now share the throttle and the durable aggregate: a flood on either refuses strangers on both (intended).
- `PIN_ALERT_ONLY_KEY` is now fed on confirm pages only by marked and local wrong guesses (with the switch on); `/mcp/approve` still feeds it as before. Stranger confirm guesses raise `DashboardPin.bruteForce` instead.
- Sign-in's local-budget and durable charges now happen in one write instead of up to three; counts are identical.
- The existing per-token key format (`req:<sha256 of recsvc:id:token>`) is reused, so counts carry across a switch flip.

---

## 6. External surfaces

- New response fields: `pin-paused` 429 body on confirm POST; `retryAfterSeconds` and `allProtected` on `too-many-pages` (switch on); `confirmStats` in `GET /recommended-services` (switch on).
- The confirm page now sends `X-Instar-Request: 1` on its GET (harmless with the switch off) and keeps a short-lived retry lock in localStorage.
- Nothing visible to other agents.

## 6b. Operator-surface quality

The refusal wordings are the spec's fixed plain sentences and name what to do. An expired page says it timed out and asks for a reload.

---

## 7. Multi-machine posture

- Page tokens (with `protected`): machine-local by design. machine-local-justification: physical-credential-locality (spec Multi-machine posture: single-use credential accepted only on the minting machine; replicating would add a forgery path through unauthenticated pull replication).
- PIN counters: no new rows; `state/pin-attempts.json` is now declared machine-local in the registry, describing piece 1c's per-machine posture.
- Confirm counters: per machine, proxied-on-read (each machine reports its own; the graduation review sums every machine's from the pool roster).

---

## 8. Rollback cost

Set `security.approvalLinks.enabled: false` (restores piece 1c's behaviour exactly), or revert the commit. Older code ignores the `protected` token field; token rows expire within 30 minutes. `confirm-stats.json` becomes unused and harmless. No migration.

---

## Conclusion

Closes the SEC-135 guessing rate on development agents now and on the fleet after the maturation review, with no new limits and sign-in's behaviour unchanged.

## Second-pass review

Separate pass over the security-sensitive diff (AgentServer verifier, PinAttemptStore, confirm route, token store, owner-open check):

- No await between admission, compare and charge in `publicPinVerify`; the parallel last-attempt test confirms exactly one compare.
- The constant-time compare hashes both sides to 32 bytes first, as sign-in does.
- The per-request key is checked on all three paths and has an in-memory fallback when the store is absent; the store keeps counts in memory when a write fails. The in-memory map's 4096-entry cap cannot evict a live token's counter, because the verifier only runs for a live token (at most 50 per service).
- `ownerOpen` requires the exact header and a verified HMAC marker or own-loopback host; the CORS allow list excludes the header (pinned by a test).
- Found and fixed in this pass: a stranger's mint refused because all 50 rows were protected originally returned `allProtected: true`, telling a stranger that owner pages were live. Now only an owner open gets the flag.
- Insecure-connection refusal comes first and is not counted.

Concur with the review.

## After Local Verify (2026-11-23)
The full run on head e485208cc failed one unit test, and the run record does not name the file. On a head brought up to date with main, the fifteen unit tests nearest this change pass: the SEC-135 suites, the ladder, dev-gated, awareness and bounded-accumulation registries, the PIN store and verifier, and the middleware and security scans. The change is resubmitted unchanged for a fresh run.

## Release 1.3.1989 conflict repair

Tier 2 maintenance under the existing approved specification. A fresh remote readback identified published PR 3586 head 467c8eafd4b767cbea5761aeaa58fd0fbcc4a72d. The existing isolated checkout was fast-forwarded to that published head before merging current main ec9401e5bdf28ed5ab1ff13f88e0032cc7895fc6. The single conflict is Git suggesting that the still-unreleased note move from upgrades/next to the released-note directory. The resolution keeps the original fragment byte-for-byte in upgrades/next so the normal release assembler still includes it. The routes source auto-merges; no runtime behavior is manually changed.

The existing over-block, under-block, layer fit, signal versus authority, interactions, external-surface, multi-machine and rollback analysis remains applicable. Per-request counters and their store-outage fallback, public and owner/local budget separation, constant-time comparison, source identity derivation, owner-open proof, bounded records and insecure-connection refusal order remain the existing approved behavior. No new authority, limit, credential, data migration or production activation is introduced. Rollback is an ordinary merge correction; installed state is untouched.

Verification uses one sequential runner under normal admission for focused service/verifier/store checks, the real HTTP flood suite, the production lifecycle suite and TypeScript. Full exact-head verification remains with throughput after publication, main repairs and the retained order. All native, owner-phone, recovery and PIN prerequisite holds remain. One scoped maintenance review and one planned normal commit; no new design rounds. Final results and independent review are recorded below after completion.

Final focused results: 45 unit checks, one full HTTP flood check and three production lifecycle checks passed (49 total), followed by TypeScript with exit zero. The flood check still bounds strangers while the remembered browser and this computer retain access. The sequential runner stopped between steps only to record actual results and used normal admission throughout.

Independent reviewer /root/review_3586_release_note concurred after reading the staged merge and artifact. The fragment is byte-identical in upgrades/next; the verifier, counters, fallback, budgets, trusted source identity, owner-open proof and refusal ordering retain their published-parent behavior, and the routes merge retains main additions. Full exact-successor verification remains required after publication and main repairs. Existing order, dependency and safety holds remain intact.
