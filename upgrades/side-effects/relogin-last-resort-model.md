# Side-Effects Review — last-resort model for the sign-in repair; two-account / cross-provider pins

**Version / slug:** `relogin-last-resort-model`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Operator request (topic 33890, 2026-10-22): (1) a two-account pool must repair the dead account using the other; (2) that must hold across providers (Claude + Codex); (3) a single-subscription agent needs a lightweight last-resort path (small model over an API key) so the repair of its only login does not always wait on the operator.

Findings on (1)/(2): already built. `SubscriptionReloginRuntime.pickSeat` accepts any healthy account on the machine, Claude or Codex, never the one under repair; `buildReloginHelperSessionPorts.spawn` pins the helper to the seat's framework/configHome. This PR adds integration tests pinning both directions (Claude broken + Codex-only spare; Codex broken + Claude-only spare).

Finding on (3): a real gap. The repair's two model calls (`supervise`, `navigate`) ran on `sharedIntelligence`, a subscription CLI that on a one-subscription agent runs on the dead login itself; and the agent-session path has no other account to run the helper on, so the episode went `waiting-operator-only / no-healthy-seat` every time.

Change:
- New `src/core/ReloginLastResortProvider.ts`: an `IntelligenceProvider` whose inference rides the anthropic-headless adapter's one-shot transport (the repo's chokepoint for key-authenticated Claude calls: `claude -p`, key in the CHILD env only via `credential`, `--max-turns 1`, `--setting-sources user`), with the key read live from the vault under a repair-specific name (`relogin_last_resort_anthropic_api_key` by default), the `fast` (haiku) tier by default regardless of the caller's requested tier, caps 60 calls per drive / 300 per UTC day, status without key material. The one-shot runs in a DEDICATED EMPTY config home (`<stateDir>/relogin-last-resort-claude-home`, new optional `configDir` on `AnthropicHeadlessConfig` → `CLAUDE_CONFIG_DIR`) so the dead subscription login in the ambient home can never be what the CLI picks up. `withLastResort(primary, lastResort)` = primary first; last resort only when the primary threw (not on abort) and the last resort is available; otherwise the primary's error is rethrown unchanged. No raw LLM HTTP in core (`lint-no-direct-llm-http` passes without an allowlist change).
- `server.ts`: builds the provider from `reloginCfg.lastResort` + the relogin vault; `supervise` and `navigate` now call the wrapped evaluate (same queue lane, same attribution/provenance). Passes the port to the runtime. Boot line names the state (model / key missing / off).
- `SubscriptionReloginRuntime`: new optional dep `lastResort`. On the agent-session path, a `no-healthy-seat` pre-attempt verdict becomes `ok` when the last resort is available AND `navigate` is wired; that episode is remembered in-memory and `driveBrowser` routes it to the server-side `AnthropicReloginBrowserDriver` with `navigation: 'agent'` (bracketed by `beginDrive`/`endDrive` for the per-drive cap). Event class `last-resort-drive-started`. All other episodes unchanged. Non-agent-session paths gain only the evaluate fallback.
- `subscriptionReloginRouteContext` gains `lastResortStatus()`; `GET /subscription-relogin` (non-pool) carries `lastResort`.
- Config type `subscriptionPool.assistedRelogin.lastResort { enabled, keyName, model, maxCallsPerDrive, maxCallsPerDay }`.
- CLAUDE.md template bullet + idempotent `PostUpdateMigrator` insert after the slow-retry bullet.

## Decision-point inventory

- `SubscriptionReloginRuntime` preAttempt wrapper — modify — `no-healthy-seat` → proceed with the server-side driver when the last resort is available. Admission (`evaluateSubscriptionReloginAdmission`), `mode`, approvals, breakers, slow-retry caps: unchanged and still upstream of this point.
- `withLastResort` — new — provider selection for the repair's own calls only. Primary-first; never widens what the model may choose (the driver's floor-filtered `offered` list is unchanged).
- Success arbiter (`finishCli` → `verifyIdentity` → `verifyAuthenticatedUse`) — pass-through — untouched.

---

## 1. Over-block

No message surface. The "over-act" analogue is unwanted spend or an unwanted drive:
- Spend requires the operator to place a key under the repair-specific vault name. `ANTHROPIC_API_KEY`, `intelligenceProvider`, and `intelligenceProviderConfirmed` are never read, so the existing subscription-by-default chokepoint (`selectIntelligenceProvider`) is not bypassed: a key present only in the environment does nothing here. Spend is capped per drive and per day; a cap refusal throws a named error that surfaces as the driver's existing `provider-transient` retry, bounded by the attempt budget.
- A last-resort drive runs only after every existing admission floor and only where the helper path would otherwise have stopped. It opens the account's own normal browser profile exactly as the pre-existing `navigation: 'agent'` path does on non-macOS agents today.
- The primary provider is always tried first, so an agent whose shared model is fine spends nothing on the key even with one present.

## 2. Under-block

- A last-resort drive uses the server-side driver, which is the floor-filtered page-class/agent-navigation path, not the person-like helper session. Pages the driver cannot classify end as `give-up` → `agent-sign-in-unfinished`-class failure → slow retry / operator. That is the same ceiling the non-macOS fleet already has; it is not lowered.
- The per-drive cap counter is in-memory and the per-day counter resets on restart. A restart mid-day lifts the day cap once. Acceptable for a 300-call haiku cap; noted.
- `lastResortDrives` is in-memory: a restart during a last-resort drive lands in `recoverUncertain` (existing: `waiting-operator-only / uncertain-external-outcome`), never a double drive.
- Only Anthropic keys are supported. An OpenAI-key variant was not built; the model only reads pages and picks from an offered list, so one provider suffices for both Claude and Codex repairs.

## 3. Level-of-abstraction fit

Right layer. Provider selection for the repair sits beside the repair (not in the shared router, which would widen API spend to every internal call). The no-healthy-seat fall-through sits in the runtime's preAttempt wrapper, where the helper/driver split already lives, so the orchestrator and store need no new states. The success arbiter is untouched.

## 4. Signal vs authority compliance

- [x] No — this change produces no blocking authority. It adds an alternative answerer for an existing bounded chooser whose options are floor-filtered by deterministic code, and a fall-through from one existing drive path to another existing drive path. Success remains with the server's own verification.

## 4b. Judgment-point check

The caps (60/300) are static floors on spend, not judgments. The fall-through condition (`no-healthy-seat` ∧ last resort available ∧ navigate wired) is a deterministic conjunction of enumerable facts.

## 5. Interactions

- **Shadowing:** none. `withLastResort` wraps only the two repair calls. `sharedLlmQueue` lane, attribution and provenance are preserved on the primary; the last-resort call is outside the queue (it is a plain HTTPS call with its own timeout) and carries the same `attribution` in options for callers that read it.
- **Double-fire:** the helper's `preAttempt` acquired and released the seat lease before the fall-through; the server-side driver acquires it again itself. One repair at a time still holds.
- **Races:** `releaseAttempt` clears the episode from `lastResortDrives` after the tick; `driveBrowser` reads membership at drive time within the same tick.
- **Slow retry:** a last-resort drive that fails on a budget class is slow-retry eligible like any other; a hard-line class is not. Unchanged predicates.
- **Boot:** `createReloginLastResort` never throws; a missing/unreadable vault means `available() === false`.

## 6. External surfaces

- A new `claude -p` one-shot with the operator's key in the child's environment (never the server's), only during a repair drive, only after the primary failed. Prompt content = the same floor-filtered page summary the primary already receives. It runs in a dedicated empty config home, so it never reads or writes the agent's subscription login files.
- That one-shot does not pass through the host spawn-cap semaphore (`buildIntelligenceProvider` funnel) — the adapter's transport is its own execFile. Bounded instead by: one repair drive at a time (seat lease), strictly sequential calls within a drive, 60 per drive / 300 per day. Noted, not hidden.
- `GET /subscription-relogin` gains `lastResort` (never the key).
- CLAUDE.md bullet for agents (migration-paired).

## 7. Multi-machine posture

Machine-local by design: the key is read from THIS machine's vault (vault contents sync via the existing secret-sync path when enabled, so the key follows the operator's push policy), the repair is per account×machine, and the status rides the existing per-machine `GET /subscription-relogin` (the pool-scope read merges episodes only; the last-resort status is intentionally local, like `helperSubmit`). No durable state strands on transfer: counters are in-memory and advisory.

## 8. Rollback cost

Config: `subscriptionPool.assistedRelogin.lastResort.enabled: false` (restart) or remove the vault key (live). Code: revert the PR; no schema, no migration beyond an additive CLAUDE.md bullet (which the migrator never removes but is harmless). No data repair.

## Tests

- `tests/unit/relogin-last-resort-provider.test.ts` (13): config defaults/validation, live availability, request shape (key only in header, never in body/status/errors), HTTP/network/empty-body failures, disabled/no-key refusals, per-drive and per-day caps with day rollover, wrapper primary-first / fallback / rethrow / abort / cap surfacing.
- `tests/integration/subscription-relogin-agent-session.test.ts` (+6): no-seat + last resort ⇒ server-side drive to verified success with `last-resort-drive-started` and no helper; no-seat + no key ⇒ unchanged `no-healthy-seat`; healthy seat ⇒ helper, last resort untouched; route context status never carries a key; Claude repair on a Codex-only spare; Codex repair on a Claude-only spare.
- `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts` (+assertions): bullet inserted once, after the slow-retry bullet, idempotent.

## Second-pass review

Independent reviewer subagent (2026-10-22), on the first draft (raw Messages-API call): **Concern raised**, six items, none a key leak. Verified sound: key never leaves the provider; primary-first; caps; deterministic fall-through; no new authority; LlmQueue lane/attribution preserved on the primary; `sharedIntelligence!` guarded at the bootstrap condition; helper releases the seat lease on no-healthy-seat and the server-side driver takes its own; `driveEventClass` runs after `preAttempt` in the same tick; migration anchored, content-sniffed, idempotent; AbortSignal composition correct; aborted primary never retried; cap refusals surface as `provider-transient`; `keyName` regex-clamped before the vault read.

Author response, all fixed in this PR before commit:

1. **Dead primary re-tried on every step could eat the drive deadline (medium).** Fixed two ways: the primary call gets `primaryTimeoutMs: 15_000` from the server wrapper, and the last resort is **sticky within a drive** — once it answered a call of the current drive (`preferred()`, reset by `beginDrive`/`endDrive`), `withLastResort` skips the primary for the rest of that drive (`primarySkipped` counted; one fallback warning per drive, not per step). Tests: wrapper sticky + timeout; provider `preferred()` lifecycle incl. key removed live and a failed answer not marking preferred.
2. **Unmetered call (medium).** The inference now rides the anthropic-headless adapter's one-shot (`claude -p`, key in the child env, dedicated empty config home) and every call is recorded on the feature-metrics ledger via `getFeatureMetricsRecorder().record(...)` under the caller's `attribution.component` (fallback `subscription-relogin-last-resort`), `framework: 'anthropic-api-key'`, `model` = the tier, `outcome` unclassified/error, latency, and usage tokens when the transport reports them (the CLI one-shot reports `usage: null` today — the call COUNT and latency are attributed; token volume for this path is a known gap shared with every `claude -p` one-shot). Test: two records, never the key or the prompt.
3. **"Collect through Secret Drop under that name" does not create the vault key (low-medium).** Both copies (template + migrator) now say: collect through Secret Drop, then store with `credential-store.mjs` under that exact vault name; a Secret Drop submission alone does not create the key.
4. **Agent navigation on the fall-through untested (low).** The integration fixture's fallback browser now starts on an `unknown` page with `observeControls`/`clickControl`; the test asserts the navigator was asked (offered `click:1`/`click:2`) and the driver clicked, before the success page.
5. **Crash-resume skips the fall-through (low, speculative).** `driveBrowser` now also falls through when the helper path returns `operator-only / no-healthy-seat` and the last resort is available (a restart after `cli-starting` reaches the helper with no seat). The transition event for that case reads `agent-session-drive-started` (written before the helper ran); the fall-through is visible as the server-side driver's own subsequent events. Documented here rather than adding a second transition.
6. **Artifact omissions.** (a) The fall-through also triggers when the LlmQueue *sheds* the primary (daily spend cap / interactive reserve): one subscription cost control then routes to the capped key spend — bounded by 60/300 and by the key's presence, and consistent with the operator's stated intent ("as a last resort"). (b) `GET /subscription-relogin?scope=pool` (what the dashboard grid reads) does not carry `lastResort`; the state is per machine on the plain route — a UX limit, noted. (c) A key pushed by secret-sync enables the path on every machine where `enabled` defaults true: consent is pool-wide once pushed, same as every synced secret.

Second pass on the revised draft: the reviewer's numbered concerns are each addressed by a code change plus a test (1, 2, 4, 5) or a wording change (3) or a documented limit (6). Concur with the review as amended.
