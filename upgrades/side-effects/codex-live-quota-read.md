# Side-Effects Review — Live codex quota reads via `codex app-server` (zero-spend)

**Version / slug:** `codex-live-quota-read`
**Date:** `2026-09-20`
**Author:** `Echo`
**Second-pass reviewer:** `not required` (no block/allow surface; see §4)

## Summary of the change

Codex quota readings were only as fresh as the account's last completed turn, and a WALLED account produced no reading at all (no turn completes → no rollout record — the dawn@ case). The codex CLI's app-server protocol exposes `account/rateLimits/read` — the same call its own `/status` screen makes: a metadata fetch answered by OpenAI without a model turn. Zero tokens, zero quota, measured 450–850ms per account across all five real accounts.

New module `codexLiveRateLimitReader.ts` speaks the protocol (spawn `codex app-server` → initialize handshake → one read → kill), maps into the existing `CodexUsageSnapshot` shape with `source: 'codex-app-server'`, and returns null on ANY failure. `QuotaPoller` and `GET /codex/usage` try it FIRST and fall back to the rollout-tail reader — worst case is exactly the previous behaviour. The real reader is injected only at the composition roots (`server.ts`, `AgentServer` ctx) via `buildCodexLiveUsageReader`; absent injection means rollout-only, so no test can spawn a real subprocess. Config lever: `subscriptionPool.codexLiveQuota: false` → rollout-only. Files: the new reader + tests, `QuotaPoller.ts`, `routes.ts`, `AgentServer.ts`, `server.ts`, `subscriptionEnums.ts`, `types.ts`, `templates.ts`, `PostUpdateMigrator.ts`, plus poller/route/e2e test updates.

## Decision-point inventory

No block/allow decision point is touched. The reader is a signal producer; both consumers already existed.

- `codexLiveRateLimitReader.readLiveCodexRateLimits` — **add** — a reader that reports what OpenAI answered; on any failure it reports nothing. It cannot synthesise a number.
- `QuotaPoller.pollAccount` (codex branch) — **modify** — source-selection order only (live → rollout). The window classification, snapshot shape, reset normalization, and pool write are unchanged.
- `GET /codex/usage` — **modify** — same source-selection order; response shape unchanged (plus `source` now distinguishes provenance).
- Placement / proactive swap / QuotaTracker / QuotaCollector — **pass-through, unmodified** — they read the same snapshot fields. QuotaCollector's solo-codex brake does NOT get the live path (it calls `readLatestCodexUsage` directly); loosening that fail-safe stays tracked as ACT-018, deliberately out of scope here too.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

The nearest analogue: the live mapper ignores a response whose only bucket belongs to a non-codex limit family, and treats a malformed window (missing fields) as absent rather than guessing — both withhold a number, never invent one, and both fall through to the rollout tail.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

What the change still does not solve: (a) QuotaCollector's solo-codex load-shed brake still reads the rollout tail only and still requires both windows (ACT-018 — its own review, because it is a fail-safe); (b) the live reading is a point-in-time poll on the existing 15-minute cadence, not a push — a wall hit between polls is seen at the next poll or by the existing reactive machinery; (c) if BOTH paths fail the account reads as having no snapshot, exactly as today.

---

## 3. Level-of-abstraction fit

Correct layer. The reader is a detector-tier component: a deterministic protocol exchange returning a structured observation. It reuses the existing snapshot type rather than minting a parallel one, so every downstream consumer (window classifier, dashboard, replication projection) works unchanged. The alternative — teaching each consumer about a second shape — would have been the wrong layer. The spawn is NOT routed through the fork-bomb spawn-cap funnel deliberately: that cap bounds concurrent LLM turns (`claude -p` / `codex exec`), and this is a sub-second metadata process with no model turn; the poller invokes it sequentially per account on a 15-minute cadence, so worst-case concurrency is 1 per poller tick (plus an occasional on-demand route call).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

It produces a signal (the same snapshot shape as before) consumed by the existing authorities. The behavioural delta at those authorities is fresher, more-often-present truth: two walled accounts that previously read as blank now read 100% — placement and the pre-limit swap steer work away from them EARLIER. The safe direction. Nothing gains blocking power.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Source selection (live first, rollout on failure) is not a judgment over conflicting live signals — the live answer, when present, is strictly more authoritative and more current than the log of past answers from the same authority (OpenAI). The domain is enumerable: answered → use it; failed → fall back. The 10s protocol timeout is a deadline on a subprocess exchange, not a decision boundary.

---

## 5. Interactions

- **Shadowing:** the live path shadows the rollout reader BY DESIGN when it answers (that is the fix). It cannot shadow anything else: `readLatestCodexUsage`'s other caller (QuotaCollector) is untouched, as is `RateLimitSentinel`'s rollout-growth recovery check (`findNewestRolloutSync`), which watches file growth, not the reader.
- **Double-fire:** nothing fires — the reader performs no action. The spawned child is killed on settle, on timeout, on error, and on child exit; the deadline timer is unref'd so a leaked handle can never pin the event loop.
- **Races:** none introduced. The reader is stateless per call; QuotaPoller's per-account bookkeeping is unchanged. pollAll remains sequential per account, so at most one live probe runs at a time within the poller.
- **Feedback loops:** burnRate now compares consecutive LIVE snapshots on a steady cadence instead of sporadic rollout timestamps — a strictly better-conditioned input (uniform sampling interval). `measuredAt` for a live reading is the poll time, which is what a rate-of-change calculation wants.
- **Reset normalization interplay verified:** the poller's existing "known reset has passed → show fresh 0%" normalization applies to live readings identically (same `resetsAtIso` field), covered by the existing test.

---

## 6. External surfaces

- **Other agents on the same machine:** each probe spawns one short-lived `codex app-server` process against the target account's own config home. Sub-second, sequential, every 15 minutes — negligible beside the existing per-turn codex traffic. It writes nothing to the account home beyond what the codex CLI itself does on startup.
- **External systems:** one HTTPS metadata request to OpenAI's backend per account per poll — the same request the codex TUI's own /status makes on demand. ~96 requests/account/day at the default cadence; no token spend, no quota consumption (verified live: walled accounts answered while at 100%).
- **Install base:** dashboards show fresher numbers and (via PR #2030's age label) live readings will rarely carry an age line. `GET /codex/usage` gains `source: 'codex-app-server'` values; `available:false` semantics unchanged.
- **Persistent state:** `lastQuota.source` can now hold `'codex-app-server'`. Added to the shared `SUBSCRIPTION_QUOTA_SOURCES` enum, which the WS5.2 replicated store imports — a projection carrying the new value replicates. **Mixed-version window:** a peer on an older release rejects such a projection until it updates (stale replicated view, never a wrong value; converges with the rolling update).
- **Timing/runtime conditions:** the codex binary's availability and the app-server protocol's stability. Protocol drift degrades to null → rollout fallback → exactly the pre-change behaviour, plus the pinned method name is exercised by unit tests against the recorded response shape.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added — the change is read-path only. The rollback lever is a config field, documented in the awareness text; no approval flow, no PIN surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. (No dashboard renderer/markup, approval page, or grant/revoke/secret form is touched; the dashboard changes shipped in PR #2030 and this change only makes their data fresher.)

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, same reason as the rollout reader it front-runs: a codex login lives on one machine's disk (logins are never copied between machines), so the only machine that can ask OpenAI about an account is the machine holding that account's config home. The live probe runs there, on that machine's poller.

The pool-wide view rides the existing **proxied-on-read** paths unchanged: `GET /subscription-pool?scope=pool` merges each machine's own readings, and the WS5.2 account-meta replication carries the projection (with the enum addition above, plus the mixed-version note). No user-facing notices are emitted (nothing to one-voice-gate); no durable state strands on topic transfer (snapshots are per-account, per-machine); no URLs are generated.

---

## 8. Rollback cost

- **Config lever (no release):** `subscriptionPool.codexLiveQuota: false` per agent → rollout-only, live path never invoked.
- **Hot-fix release:** revert the commit. Code-only.
- **Data migration:** none. Stored snapshots carrying `source: 'codex-app-server'` remain valid records of what was measured; the reverted code reads them like any snapshot (the field is informational).
- **User visibility during rollback:** readings degrade back to last-turn freshness — the original limitation, not an error.

---

## Conclusion

The review shaped the change materially in one place: the first draft defaulted the REAL live reader inside QuotaPoller and imported it directly in the route, which would have made every existing poller unit test and the route integration/e2e tests spawn a real `codex` subprocess (non-hermetic, network-touching, flaky on CI where the binary is absent). The composition was inverted — `buildCodexLiveUsageReader` is injected at the two composition roots only, everything else defaults to rollout-only — and the e2e now proves the live-first plumbing through the production `AgentServer` option seam with a controllable fake. The QuotaCollector brake was again checked and deliberately left alone (ACT-018). Verified live post-build: 5 of 5 accounts answer with current authoritative numbers (three of them walled — the case the old path structurally could not see). Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required.

Phase 5 triggers (messaging/dispatch block-allow, session lifecycle, compaction, coherence gates/trust, sentinel/guard/gate/watchdog surfaces): none touched. The one lifecycle-adjacent consumer (RateLimitSentinel's recovery check) reads rollout file growth directly and is not routed through this reader.

---

## Evidence pointers

- Live, through the BUILT dist module against all five real config homes (2026-09-20 12:1x PDT): justin@sagemindai.io 100% (walled, resets 4:21 PM), dawn@sagemindai.io 100% (walled — previously NO reading possible), headley.justin@gmail.com 100% (walled), amrch 86%, adriana 96%; 450–850ms each; all `source=codex-app-server`.
- Protocol ground truth: `codex app-server generate-json-schema` (codex-cli 0.153.4) — `account/rateLimits/read` / `GetAccountRateLimitsResponse` with `rateLimitsByLimitId` keyed by `limit_id` (e.g. `codex`).
- Unit: `tests/unit/codexLiveRateLimitReader.test.ts` (13) — mapping, walled marker, foreign-family refusal, windowless, malformed windows, handshake order, and every failure shape → null (init refused, read error, silent child + deadline, early exit, spawn throw), plus the factory's both sides.
- Unit: `tests/unit/quota-poller.test.ts` (29) — live wins with provenance recorded and zero rollout calls; fallback on null AND on throw; `null` disables (rollback lever).
- Integration + E2E: `tests/integration/codex-usage-route.test.ts`, `tests/e2e/codex-usage-lifecycle.test.ts` (8) — live-first through the production AgentServer wiring with an injected fake (wiring integrity: the reader receives the query's codexHome), fallback, auth, read-only.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (this fixes no defect in an LLM prompt, hook, config, skill, or standards text; it adds a read path in hand-written TypeScript).

Self-action check — negative declaration, mirroring the trace's machine-readable block:

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `n/a` (negative declaration)
- **`reason`**: not a new self-triggered loop — `codexLiveRateLimitReader` performs ONE bounded, deadline-killed (10s; child killed on settle/timeout/error/exit) subprocess exchange per invocation, and is invoked only by the EXISTING QuotaPoller cadence (the already-governing controller: 15-minute interval, sequential per account) and the existing on-demand `GET /codex/usage` route. It adds no loop, no monitor, no retry, no respawn, no notify — a failure returns null once and the caller falls back to the rollout reader within the same call.
