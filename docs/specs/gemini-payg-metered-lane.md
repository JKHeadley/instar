---
title: "Gemini pay-per-use lane — a named, capped, metered Gemini API door (Neon + Hydrogen)"
slug: "gemini-payg-metered-lane"
author: "echo"
status: "draft"
parent-spec: "docs/specs/routing-control-room-spend-alerts.md"
parent-principle: "Token-Audit Completeness — An Unmetered LLM Call Is an Unaccountable One"
eli16-overview: "docs/specs/gemini-payg-metered-lane.eli16.md"
---

# Gemini pay-per-use lane — a named, capped, metered Gemini API door

## Problem statement

**Operator decision (verbatim, Justin, 2026-11-20 13:26 PST, Telegram topic 145625):**
"please proceed with the path that is the most cost-effective for us that you have
recommended and let's set a $50 cap for now and integrate Gemini with our other options
for models, including Gemini neon and Gemini hydrogen".

The recommendation he approved (topic message 146146; report "Theo subscription
subsidy playbook", 2026-11-20) was:

1. Gemini through a **pay-per-use API key** with a **hard $50/month cap**.
2. Justin's personal Google AI Pro stays **out** of autonomous Instar work.
3. The Gemini Enterprise seat is being cancelled.
4. Heavy work stays on the Claude and Codex subscriptions.

A separate account lane is creating the key (vault name `gemini_api_key_payg`) and the
Google-side spend limit. This spec does not touch Google accounts.

**The tension.** Instar deliberately strips `GEMINI_API_KEY` / `GOOGLE_API_KEY` (and the
Vertex/ADC variables) from every CLI child: `gemini-cli` (`geminiSpawn.ts`
`GEMINI_BILLING_ENV_VARS`), `pi-cli` (`piSpawn.ts` `PI_BILLING_ENV_VARS`), `grok-build`
(`GROK_BILLING_ENV_VARS`), and confined spawns (`credentialEnvNames.ts`). The reason is
written into `gemini-cli/credentials.ts`: a leaked key "silently bills the user's
Google/Gemini API account at full per-token rates". The approved metered lane must keep
that protection everywhere else. No other framework may pick up the key. Spend is capped
inside Instar, not only at Google. The lane fails closed at the cap, and spend is visible.

**What already exists (extend, do not duplicate).** Instar already has an approved,
partly built design for exactly this kind of door. Main is at `d9117905d`.

- `docs/specs/routing-control-room-spend-alerts.md` was approved by Justin on 2026-07-07
  and built as Increment B. It provides:
  - `MeteredSpendGate`, which fails closed with a closed list of refusal reasons.
  - `MeteredSpendLedger`, an append-only, fsync'd reserve/settle/expire ledger.
  - `RoutingSpendCapsStore` (per-key `KeyCapsRecord`, PIN-only), with a `GoLiveRecord`
    per door.
  - `meteredCallEntry.admitMeteredCall`, which runs the freeze check, then the
    live-enable check, then the gate.
  - A PIN plan/commit flow, the dashboard Spend tab, and `/routing-spend/*`.
- `docs/specs/money-layer-operator-enable-surface.md` (approved 2026-08-16) provides the
  money-layer ON switch.
- `src/data/llmBenchCoverage.ts` already declares a metered routing door `gemini-api`
  (`METERED_ROUTING_DOORS`, keyRef `metered_gemini_bench`, model label `flash-lite`).
  `MeteredSpendGate.billedOutputTokens('gemini-api')` already bills Gemini thinking tokens
  as output.

**What is missing, and is this spec's build:**

1. **The paid call itself.** No metered provider dispatch exists anywhere in Instar.
   `meteredCallEntry.ts` says "no paid provider call is made anywhere today", and
   `IntelligenceRouter.resolveRoute` skips every metered door unconditionally.
2. **A monthly cap.** The caps model has only lifetime and UTC-day caps. The enable
   surface says plainly: "There is no calendar-month limit in the model at all".
3. **Spending on a multi-machine agent.** With the session pool on,
   `leaseConfirmedAgoMs` is stubbed to `null` (`AgentServer.ts`). Every admission
   therefore refuses `lease-liveness-unconfirmed`, and Echo, a multi-machine agent,
   cannot spend at all. The code comment says the real re-confirmation "lands with the
   metered dispatch seam". This spec is that seam.
4. **Prices and model ids** for Gemini 4 Neon and Gemini 4 Hydrogen in the canonical
   price manifest.
5. **A scoped key reader**, and protection of the key from sync, from `secret-get`, and
   from any child environment.
6. **Who may use the door.** Today, arming a door would make it the automatic first
   choice for every FAST component (`NATURE_ROUTING_DEFAULT_CHAINS`). The approval
   covered a deliberate lane, not an ambient one.

## Constitutional fit (checked, not assumed)

The master constitution is the Instar 2.0 purpose and rule book (`docs/STANDARDS-REGISTRY.md`
header), read 2026-11-20 from `JKHeadley/instar-2` `docs/01-the-rules.md`.

- **Rule 4 (Structure Decides Alone Only on an Exact Match)** names "spend past a cap" as
  one of the three irreversible-miss cases where code may decide alone. **Rule 86
  (Signal vs. Authority)** names money as one of the two ruled exceptions where a
  deterministic check may block. The fail-closed cap in this spec is therefore a
  sanctioned deterministic authority.
- **Rule 122 (No Feature May Require a Purchased Service)** allows a paid service "as an
  optional add-on". In this design, every feature works with the lane absent: chains
  advance to subscription doors, and the reviewer family is simply unavailable.
- **Rule 118 (a second AI provider is never required)** is satisfied the same way.
- **Rule 75 (Token-Audit Completeness).** The direct API returns per-call
  `usageMetadata`, so this door reports usage. That is a reason to prefer the API over
  driving a CLI, since `gemini-cli` sits on the cannot-surface exemption list.
- **1.x registry, Framework-Agnostic floor:** "Raw API is forbidden as a **routine**
  path." This lane is not routine. It is named, opt-in, operator-approved, capped and
  fails closed. The 2026-07-07 approved money-layer spec already designed metered doors
  under this same article, so this spec extends a design that has passed the floor.
  `provider-portability` Rule 2 (Anthropic) and Spec 12 Rule 1 (OpenAI) are
  provider-specific. They are untouched: no Anthropic or OpenAI key path is opened.

**Conclusion:** this is a spec-level exception scoped to one named door. It is not a
constitution amendment and needs no operator spec approval. The operator's money
authorization is the one PIN tap described in §8.

## Proposed design

### 1. How Instar calls Gemini: a direct HTTP door, not a CLI

**Decision: an in-process HTTPS provider, `GeminiApiProvider`, behind the existing
`gemini-api` metered door.** The CLI options were considered and rejected:

- Driving `gemini-cli` with a key would break its strip invariant ("no leak, ever"), and
  its leak canary rightly fails. The CLI is also token-blind (Rule 75 exemption list).
  It also rewrites unknown model ids to the default (`KNOWN_GEMINI_MODELS` plus
  gemini-capacity-policy requirement 7), so Neon and Hydrogen would silently become
  `gemini-2.5-flash`.
- Driving `pi-cli` with a Google provider key would break `PI_BILLING_ENV_VARS`. Pi is
  also deliberately excluded from spec review because its endpoint may be custom.
- The Antigravity CLI (`agy`) under a consumer plan is the case Google's FAQ names as
  "not supported under consumer plans". Its parked spec (PR #3514) targets the
  Enterprise seat, which is being cancelled.

**Shape.** The provider lives at `src/providers/metered/gemini-api/`:

- `GeminiApiProvider.ts` implements `IntelligenceProvider.evaluate(prompt, opts)`.
- `geminiApiTransport.ts` holds the only network call:
  - Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
  - The host is a code constant. It is not configurable, and no base-URL override
    exists, so the spec text and prompts can never be redirected.
  - The key travels only in the `x-goog-api-key` request header, sent by in-process
    `fetch`. It never appears in argv, a URL query string, an environment variable or a
    log.
- `geminiApiKeyReader.ts` is the only vault reader for the key (§4).
- `geminiApiModels.ts` holds the door's own model table. It is not shared with the CLI's
  `KNOWN_GEMINI_MODELS`.
- Request body:
  - `contents` holds the prompt (text only in v1).
  - `systemInstruction` is set when given.
  - `generationConfig.maxOutputTokens` is **always set**. The gate refuses
    `unbounded-reservation` without it.
  - `generationConfig.thinkingConfig` sets an explicit thinking budget.
  - `safetySettings` uses the defaults.
- `scripts/lint-no-direct-llm-http.js` gets **exactly one** new allowlist entry, the
  transport file, named in this spec as its rule requires ("Adding entries requires a
  spec change").
- **Funnel wrapping.** The provider goes through the factory's `wrapForFunnel` path,
  which provides the per-framework circuit breaker and token attribution. The circuit
  breaker key is the door id `gemini-api`, so a Google outage opens this door's breaker
  only.

**It is a door, not a framework.** `gemini-api` is **not** added to
`IntelligenceFramework`. That keeps it structurally out of the places a framework can be
auto-selected:

- `componentFrameworks.default/categories/overrides`
- the `failureSwap` tail and the non-gating failure swap
- `INTERNAL_FRAMEWORK_PREFERENCE` and the boot fallback
- topic and session framework pins
- job model routing (`job-model-routing.md`: "No metered doors in any pin")

This mirrors why grok-build is "not eligible for internal background routing". The only
ways in are listed in §2. The doorway registry's candidate name `gemini-direct-api` is
**renamed to the canonical `gemini-api`** and promoted from `candidateDoorways` to a real
door entry. One door has one name; today the doorway registry and the money code use two.

### 2. Who may route to Gemini (deliberate opt-in only)

Arming the door (§8) gates **money**. It does not choose **callers**. This spec adds a
second, independent restriction: a **component allowlist**. A component that is not on
the allowlist never reaches `admitMeteredCall`, even when the door is armed.

**Changes to existing routing:**

- `gemini-api` positions are **removed from `NATURE_ROUTING_DEFAULT_CHAINS`**.
  Previously it was first in FAST (flash-lite) and third in SORT. Default chains then
  contain only subscription doors, so arming can never silently move background
  classifiers onto metered billing.
  - Historical note: with the door never dispatchable, that default had no effect. It
    becomes a real-money default only once dispatch exists, which is why removing it
    belongs to this spec.
- The `flash-lite` label stays in `ROUTING_LABEL_TO_MODEL_ID['gemini-api']` for
  back-compat, but it is not routed by default. Its price point is past its freshness
  window, so the gate would book it at conservative-max anyway.

**The four entry points, all through the one chokepoint `admitMeteredCall`:**

| # | Caller | Default model | Default state (this agent) | Why |
|---|---|---|---|---|
| E1 | **Cross-model spec review**: a new reviewer family `gemini-api` in `crossModelReviewer.ts` | **Neon** | ON once the door is armed | This is Neon's best use: the third independent family in review, as Theo's council uses it. The API family needs no personal Google sign-in, which fits "personal AI Pro out". |
| E2 | **Second-opinion route** `POST /intelligence/gemini` `{model: "hydrogen"\|"neon", prompt, purpose, maxOutputTokens?}` (Bearer) | **Hydrogen**; Neon on request | ON once armed | The conversational path: "ask Gemini Neon what it thinks of this design". Lets any session use Gemini deliberately, one call at a time. |
| E3 | **Allowlisted nature-routing components**, through an explicit opt-in chain position | Hydrogen | **Empty allowlist** | Background classifiers already run free on subscriptions. A busy sentinel on Hydrogen could spend the whole month (see the cost note below). Opt-in per component only. |
| E4 | **Doorway scan `+liveness` paid probe** (existing D9/D10 manual-run path) | Hydrogen | Unchanged: manual only, own `budgetCapUsd` | It is already designed. It now books through the same ledger, so its spend counts against the $50. |

**Cost note behind E3's empty default.** A typical classifier call (~2k tokens in, ~200
out) costs about $0.0045 on Hydrogen at the unverified $1.50/$7.50 prices. 10,000 calls
would cost ~$45, which is the whole month. The cap would stop it, but the lane would then
be empty for the review use it was approved for. Keeping the allowlist empty by default
protects the approved purpose.

**Allowlist storage and authority.**

- Storage: the allowlist is the `meteredCallers` field of the PIN-store record for the
  door (`RoutingSpendCapsStore`, §5). It is not config, and `PATCH /config` cannot reach
  it.
- **Adding a component needs the operator PIN**, through the same plan/commit flow as a
  cap change. Widening who may spend is a money release, and "releasing money is always
  the operator's".
- **Removing a component is Bearer and immediate**: "halting money is always cheap".
- E1, E2 and E4 are named, built-in callers. They are on by default once armed because
  the operator approved them in substance ("integrate Gemini with our other options").
  Each can be individually disabled with Bearer (`POST /routing-spend/callers/disable`),
  and re-enabled only with the PIN.

**Gating components never use this door.** `NATURE_ROUTING_CRITICAL_GATES` (MessagingToneGate,
CompletionEvaluator, ExternalOperationGate, LLMSanitizer, CoherenceReviewer,
UnjustifiedStopGate, SessionWatchdog, StallTriageNurse, ProjectDriftChecker,
MessageSentinel), plus InputClassifier, TaskClassifier and InputGuard, are
**structurally refused** from the allowlist. The plan renderer rejects them. A gate that
might go dark when the month runs out is a safety regression, and no budget saving is
worth it. Injection-exposed components (`LLM_ROUTING_INJECTION_EXPOSURE`) may be
allowlisted only for positions marked `injectionSafe` (existing rule, unchanged).

**Sessions.** Interactive or agentic sessions on the metered door are **out of scope**
(Frontloaded decision FD-G6). If someone asks to pin a topic to "Gemini Neon",
`topicProfileValidation` answers with a plain notice: Neon and Hydrogen are available as
one-shot metered calls (reviews and second opinions), not as a conversation's engine.
The pin falls back the way grok's missing-binary pin does today. It never launches
`gemini-cli` with Neon, because that would rewrite the model or use a personal sign-in.

### 3. Models and prices (UNVERIFIED until the account lane's smoke test)

| Label | Model id (unverified) | Input $/M | Output $/M (incl. thinking) | Cached input | Source |
|---|---|---|---|---|---|
| `neon` | `gemini-4-neon` | 3.00 | 15.00 | 0.15 (not used by the gate: FD-19 books cached tokens as full input) | Google announcement, 18 Nov 2026 (cited in the approved report); not yet checked on Google's price page |
| `hydrogen` | `gemini-4-hydrogen` | 1.50 | 7.50 | 0.075 (same note) | Third-party pricing sites only (apidog, tokencost, layer3labs, 2026-11); **not** Google's page. Id `gemini-4-hydrogen` was live-probed 2026-11-15 via the API (doorway manifest note) |

- **Where the prices live.** The points go into the canonical, git-tracked
  `scripts/routing-prices.manifest.json` under door `gemini-api` as effective-dated,
  UTC-day-aligned points (FD-18). They land by a reviewed commit, which is the sanctioned
  non-PIN price path.
- **Point metadata:**
  - `freshnessSlaDays: 30`
  - `staleMode: "book-conservative-max"`
  - `conservativeMax: { inPerMtok: 6.00, outPerMtok: 30.00 }`, twice Neon's list price.
    This covers an undisclosed long-context tier above 200k input tokens.
- **Unverified flag.** Each point carries `verified: false` until the smoke test runs.
  The gate treats a `verified: false` point exactly like a stale one: it books at
  `conservativeMax`. So an unverified price can only over-book, never under-book. The
  account lane's smoke test reports the exact ids and the AI Studio price shown. A
  reviewed commit then flips `verified: true`, or corrects the price.
- **Unknown ids.** A model id not in the door's model table is refused (`unknown-price`).
  There is no silent default.
- **Doorway registry.** The `gemini-api` door entry is
  `accessMethod: "direct-api"`, `probe: { kind: "http-model-list", metered: false,
  vaultKeyName: "gemini_api_key_payg" }`. The models-list GET is free. `topModels` lists
  neon and hydrogen with their pricing, so `GET /doorways` shows them alongside every
  other model option. Neon and Hydrogen are `role: "metered-lane"`, not `frontier`;
  frontier stays the operator's judgment.

### 4. Key handling: one reader, never on argv, never in a child

The key is the vault secret `gemini_api_key_payg`. The account lane stores it through
Secret Drop and the recommended-services recipe. This spec adds a new constant set,
`METERED_SECRET_NAMES = ['gemini_api_key_payg']`, in `src/core/meteredSecrets.ts`. It is
the single list that every protection below reads.

1. **One reader, enforced by lint.** A new lint rule, `scripts/lint-metered-secret-readers.js`,
   fails the build if any file other than `geminiApiKeyReader.ts` (plus
   `meteredSecrets.ts` and tests) contains a member of `METERED_SECRET_NAMES` or calls
   `SecretStore.get` with it.
   - The reader exposes no `getKey()`. It exposes only
     `withKey(fn: (headerValue) => Promise<T>)`, used solely by the transport, so the key
     value never escapes the call.
2. **`secret-get.mjs` refuses it.** The template script refuses names in
   `METERED_SECRET_NAMES` (also the `--run` form) with exit 3:
   `refused: metered key — readable only by its door`.
   - The list is embedded as JSON at template build time, and a template-drift test pins
     that it matches the TypeScript list.
   - Honest limit: any process running as the agent's OS user can, in principle, decrypt
     the vault directly. This scoping is a structural boundary inside Instar code, not an
     OS boundary. It stops accidental and convenient reads, which are the realistic leak
     paths (a session running `secret-get` and exporting the value).
3. **Never in a child environment.** Unchanged and re-pinned. `GEMINI_BILLING_ENV_VARS`,
   `PI_BILLING_ENV_VARS`, `GROK_BILLING_ENV_VARS` and `CREDENTIAL_ENV_EXACT` keep
   stripping. A new canary test spawns each framework's child-env builder with the
   metered key exported under every known variable name, and with the literal value
   planted in an arbitrary variable. It asserts the value is absent from every child
   environment and argv. (Value-based: the literal is scanned for.)
4. **Close the dormant inconsistency.** `buildProviderEnvFlags('google', {kind:'api-key'})`
   (`Config.ts`) emits `GOOGLE_API_KEY` into a tmux env. It has no production callers.
   It is changed to **refuse**, exactly like the openai case does. The existing unit test
   that pins the emission is updated to pin the refusal.
5. **Not synced, except to the designated machine.** `filterSecretsForSync` drops
   `METERED_SECRET_NAMES` for every recipient except the door's current
   `designatedMachineId` (§6). So the key exists only where it may be spent.
6. **Never in logs, transcripts or prompts.** The transport redacts the header in any
   error it rethrows. The credential-exposure guard already covers the `AIza…` Google
   key shape. A unit test asserts that a transport error's message, cause and stack
   never contain the key.
7. **Prompts are scrubbed before they leave.** Every outbound prompt passes the existing
   credential scanner (the outbound credential-exposure guard's pattern set). A prompt
   containing a live credential is refused (`prompt-contains-credential`) before
   admission. This keeps vault material out of Google's logs.

### 5. The in-Instar $50/month cap (extends the money layer)

**Monthly period, added to the existing model.**

- `KeyCapsRecord` gains `monthlyCapUsd?: number`.
- `lifetimeCapUsd` becomes optional when `monthlyCapUsd` is set.
- `validateCapsFile` requires at least one of lifetime or monthly, plus a daily cap.
- `MeteredSpendLedger` totals gain `committedMonthUsd` and `monthEpoch`.
- `admitOnlyUnderCaps` checks month, then day, then lifetime, all inside the existing
  per-key critical section, using the same strict `committed + reserve > cap` test.

**Month boundary.**

- The boundary is the calendar month in `America/Los_Angeles`. This matches the Google
  billing month and the operator's frame of reference.
- The zone is a **code constant** (`METERED_MONTH_TIMEZONE`). Money-affecting values
  never live in Bearer-writable config.
- `monthEpoch` is the zoned `YYYY-MM`. The fold recomputes it from row timestamps, so a
  clock-zone change cannot reopen headroom (a fold is deterministic over rows).

**Caps for `gemini_api_key_payg`, set at go-live (§8):**

- `monthlyCapUsd: 50`. The operator's number.
- `dailyCapUsd: 10`. A runaway-pacing guard: one bad day cannot drain the month, and
  review work stays possible for the rest of the month.
  - Why $10: it is the largest figure that still leaves four more days of budget after
    a worst-case day.
  - The operator can change it like any cap. It is shown in the plan text, so the PIN
    tap approves it knowingly.
- No lifetime cap (null). The monthly cap is the operator's chosen bound.

**Per-call ceiling.**

- A single admission whose reserve exceeds `perCallCeilingUsd` is refused
  (`per-call-ceiling`).
- Default: $2.50, which is 5% of the month. Its consequence: one malformed or oversized
  call can never take more than a twentieth of the budget.
- Stored in the PIN record. Lowering it is Bearer; raising it needs the PIN.
- A normal Neon spec-review pass is well under it: about 60k tokens in plus 8k out is
  roughly $0.30, and a 250k-token context about $0.90.

**Reserve.** Before every call, the provider computes and reserves the worst case:

- **Input tokens:** the free `models/{model}:countTokens` endpoint.
  - countTokens is a metadata call that spends no tokens. It is still subject to the
    breaker and the key reader.
  - If countTokens fails, input tokens are taken as the prompt's UTF-8 byte length. That
    is a strict upper bound for text, and an over-booking.
  - Cached tokens are reserved as full input (FD-19).
- **Output tokens:** `maxOutputTokens + thinkingBudget`, priced at the output rate.
  - Gemini bills thinking as output, and whether `maxOutputTokens` caps thinking differs
    by model. Reserving their sum is correct either way.
  - The smoke test records the observed relationship for Neon and Hydrogen.
- **Price:** the canonical point, or `conservativeMax` if the point is stale or
  unverified.

The reserve goes through `admitMeteredCall`, so freeze, live-enable, allowlist (§2),
per-call ceiling and the gate are all checked in one ordered chokepoint.

**Settle.** After the call:

- `settleActual(reserveId, usd)`, with usd computed from the response's
  `usageMetadata`:
  - `promptTokenCount` at the input rate (cached tokens are included at the full input
    rate per FD-19).
  - `billedOutputTokens('gemini-api')`, which is candidates plus thoughts, at the output
    rate.
- If the response carries no `usageMetadata` but did return content, settle at the full
  reserve.

**Failure outcomes.**

| Outcome | Booking |
|---|---|
| HTTP 4xx before generation (400 invalid, 401/403 key, 404 model, 429 quota) **with no usage returned** | `settleNoCharge` |
| 5xx with no usage | `settleNoCharge` |
| **Timeout, abort or connection drop after the request body was sent** | **Settle at the full reserve, marked `provisional: true`.** We cannot prove Google did not bill. A provisional row can later be lowered only by a reconciliation record proving a lower figure (reporting side). Committed headroom is never reopened (FD-21: "provider-LOWER never lowers the committed counter"). |
| Reserve TTL expiry with no settle (process crash) | The existing expire path is **changed for this door**: expiry books the reserve as a provisional charge instead of releasing it. This adopts the parked Antigravity design's rule that an expired reservation "is never dropped". |

**Retries.** The provider performs **no automatic retries**. A caller that retries makes
a new reservation each time. One reservation per attempt keeps the books exact.

**Fail-closed at the cap.** `cap-exceeded` (and every other refusal) returns a typed
`MoneyGateRefusal` to the caller:

- **E1 (review):** the family records `unavailable: budget-reserved` in the round's
  cross-model posture. It does not pass silently, and the spec-converge report states
  it. Before giving up, it tries a Hydrogen step-down if Hydrogen fits the remaining
  budget. The step-down is recorded as `gemini-api:gemini-4-hydrogen (step-down)`.
- **E2 (second opinion):** the route returns 402 with
  `{ refused: "cap-exceeded", monthSpentUsd, monthlyCapUsd, resetsAt }`. The session
  tells the user in plain words.
- **E3 (nature routing):** the chain advances to the next subscription door (existing
  swap-tail semantics, "a refusal is a SWAP-TAIL ADVANCE, not a chain kill").

**Thresholds and notices.** These reuse Increment C's alert path and its single
"💰 Routing & Spend Alerts" topic, with one voice from the holder:

- Notices at 50%, 80% and 100% of the monthly cap, once per month per threshold.
  Dedupe key: `spend-cap:gemini_api_key_payg:month:<threshold>:<monthEpoch>`.
- For this agent, alert `dryRun` is false for these monthly thresholds only. The
  operator asked to be protected by a cap, so reaching it is information he needs.
- Quiet hours (23:00–07:30 Pacific) defer the 50% and 80% notices to 07:30. The 100%
  notice also waits for 07:30. Nothing is lost by the delay, because the gate has
  already stopped spending.

### 6. Multi-machine: one spender, one shared cap

**Posture: single-writer money on one designated machine (FD-13/FD-20 of the parent
spec), made to work on a pool agent.**

- **Who may spend.** Only the machine named as `designatedMachineId` in the door's
  `GoLiveRecord`. For Echo, that is the Studio, which holds the Telegram lease and the
  feedback-factory state. It is set in the go-live plan and shown in the plan text.
  - Every other machine refuses `no-cap-slice` (existing gate reason). The refusal is
    local and instant.
  - E1 and E2 on a non-designated machine **forward** to the designated machine:
    - The call goes to `POST /intelligence/gemini` on the holder over the existing
      authenticated mesh relay.
    - The holder admits, calls and books. The cap is therefore shared pool-wide by
      construction: there is one ledger.
    - Forwarding uses the mesh's existing authenticated machine-to-machine channel.
      There is no new transport.
    - If the holder is unreachable, the caller gets
      `unavailable: holder-unreachable`. Spec review records that honestly. Nothing
      falls back to a local spend.
  - E3 nature-routing positions on non-designated machines are skipped (`no-cap-slice`,
    so the chain advances). They are not forwarded: background classification must not
    add cross-machine latency.
- **One shared cap.** With a single writer, there is nothing to slice. The parent spec's
  Increment D (multi-machine slicing) stays unbuilt and unneeded for this lane.
- **Lease liveness: replacing the `poolOn ? null` stub.** On a pool agent, the
  designated machine computes `leaseConfirmedAgoMs` as the age of its last successful
  **self-confirmation**. A self-confirmation succeeds when all of these hold:
  1. This machine's identity equals `designatedMachineId`.
  2. Its local go-live `epoch` equals the epoch it last published on the pool
     machine-registry heartbeat surface. The designation is published there as
     `{keyRef, designatedMachineId, epoch}`.
  3. No pool-visible peer publishes an armed designation for the same keyRef with an
     equal or higher epoch.

  The check runs every 20s. The gate's existing `LEASE_LIVENESS_WINDOW_MS` (60s)
  applies. A designated machine that sees a conflicting peer designation **self-fences
  and freezes the key** (freeze-wins).

**Why an isolated holder may keep spending** (and does not self-fence on silence alone):

- The key is present only on the designated machine (§4.5). A second spender would need
  the key plus its own PIN go-live.
- A PIN go-live **refuses unless every registered machine answered** the conflict read.
  A peer that did not answer counts as a failure (adopted from the Antigravity design's
  enrolment rule).
- So two spenders would require the operator to PIN-arm a second machine while the first
  was unreachable, which the arm refuses. Spending is never split, and the holder's cap
  is the whole cap.
- That is why condition 3 checks peers it can see, not a quorum: self-fencing on peer
  silence would stop the lane for a Wi-Fi blip with no money benefit.

**Holder death.** The lane becomes unavailable pool-wide, because no other machine has
the key. Reviews record `holder-unreachable`. A surviving machine raises one notice, the
existing surviving-voice alert, after the parent spec's self-heal rules. **Reclaim** is
the parent spec's PIN-gated operator reclaim:

- The new designated machine is named in the plan.
- The key moves by targeted sync to that machine only. If the dead machine's vault
  cannot sync, the account lane re-provisions the key on the new holder.
- Never an auto-grab.

**Reads from any machine.** `GET /routing-spend/caps` on a non-holder is
**proxied-to-holder**, as the parent spec requires (IL2-1). Today the route only
composes local state; this spec builds the proxy. It returns the holder's numbers, or
`holderUnreachable` with last-known values and their age. It never shows a non-holder's
empty ledger as "$0 spent".

### 7. Visibility

**Where spend is shown:**

- `GET /routing-spend/caps` shows, for `gemini_api_key_payg`:
  - month spent / monthly cap, and day spent / daily cap
  - provisional amount, outstanding reserves, `resetsAt`, and the per-call ceiling
  - the caller allowlist and the designated machine
- The dashboard Spend tab and `/mobile/spend` render the monthly row. This extends the
  existing renderer; no new page is built.
- `feature_metrics` rows for metered calls carry `attribution.component` (E1
  `spec-review:gemini-api`, E2 `second-opinion:<caller session>`, E3 the component
  name, E4 `doorway-scan`), `attribution.door = 'gemini-api'` and
  `callId = meteredCallId = reserveId` (FD-11/FD-21 single-sourcing).
  `GET /routing-spend/summary?grain=month` therefore breaks the month down by caller.
- The unified usage ledger (`/usage/*`) shows the rows with `reported_basis: internal`,
  reporting only.

**Conversational answer.** When asked "how much have we spent on Gemini this month?",
the agent reads `GET /routing-spend/caps` (Registry First row added, §10) and answers in
dollars, never from memory.

**Invoice-drift reporting (FD-11c).** A monthly reconciliation compares the ledger's
month total with the figure Google shows. Google offers no cheap per-call USD API.

- **Producer:** on the 2nd of each month, the agent reads the AI Studio / Cloud billing
  spend for the project. It uses the account lane's signed-in browser profile, read-only
  (normal-chrome-browser skill), and posts the figure to `POST /routing-spend/reconciliation`.
- **Use:** reporting only. It never moves the gate.
- **Drift over 10%, or more than $2:** one notice to the spend topic.
- **If the page cannot be read:** the reconciliation records `unmeasurable`. It is never
  a guessed figure.
- This job reports to the user only when drift is found. It runs quietly otherwise,
  per the quiet-by-default rule.

### 8. Shipping state and the one operator action

**Fleet: dark.**

- `routingSpend.money.enabled` stays off fleet-wide. It is a documented
  `DARK_GATE_EXCLUSIONS` action-bearing case and never dev-gated.
- With money off, the `gemini-api` door is inert, the E1 family reports
  `unavailable: money-layer-off`, and E2 returns 503.
- No config default is added. Absence means unchanged.
- **Dated owner** (dark by default needs one): Echo reviews fleet enablement on
  **2026-12-21**, after one month of soak on this agent. Tracked as a commitment, opened
  at merge.

**This agent: on, after one PIN tap.** Justin approved the lane and the $50 figure in
chat. Chat approval is not PIN authorization (memory note), and money release is
PIN-only by the parent spec's invariant. So the build ships one **composite go-live
plan**, `gemini-payg-setup`. It is rendered by the agent and committed by one PIN entry.
In one atomic store write it sets:

1. the money-layer store flag on (if off);
2. `KeyCapsRecord(gemini_api_key_payg) = { provider: google, monthlyCapUsd: 50,
   dailyCapUsd: 10, perCallCeilingUsd: 2.50, frozen: false }`;
3. `GoLiveRecord(gemini-api) = { enabled: true, keyRef: gemini_api_key_payg,
   designatedMachineId: <Studio>, epoch: n+1 }`;
4. `meteredCallers = [E1, E2, E4]` (E3 empty).

**The plan text** states, in plain words:

- the cap and the daily guard
- the designated machine
- the two models with **"prices unverified until the first test call"**
- that Justin's personal Google account is not used
- that the agent can stop spending at any time without asking, but cannot raise the cap
  or add callers without him

**Delivery.** Justin gets one Work Board card with a prefilled Approve control. It links
to the Spend tab's plan view, where he enters the PIN. That is the operator-handoff
standard's phone-completable surface. After the commit:

- The agent restarts the server through its ordinary restart path, because the money
  layer is built at boot.
- It verifies `enforcementReady` and runs the release gate below.

**Release gate before the first real call (FD-11).** Go-live stays in `armed-pending-proof`
until all three hold:

- **(a) Wiring proof.** One live Hydrogen call (≤ 50 output tokens) shows
  `door === ledger door === priced door` and a settled ledger row.
- **(b) Holder-death drill.** Run on a throwaway two-machine agent: kill the holder,
  observe the surviving-voice notice and lane unavailability, PIN-reclaim.
- **(c) Reconciliation wired.** The reconciliation route has accepted one record, which
  may be `unmeasurable`.

The gate is **enforced in code**: `setGoLive` writes `armed-pending-proof`, and only the
proof recorder flips it to `live`. Today FD-11 is policy only. This spec makes it code
for this door, and every metered door inherits it. Before `live`, only the proof call
itself (tagged `release-proof`) is admitted.

**Rollback.**

- Freeze (Bearer, instant) stops all spend.
- Disarm (Bearer) clears go-live.
- Reverting the build removes dispatch. Ledger rows stay, because they are append-only
  history.

### 9. Changing the cap conversationally

Justin may say "raise the Gemini cap to $80" or "stop Gemini for now".

- **Lowering, pausing or stopping** is the agent's to do immediately, with no PIN:
  - Freeze is Bearer.
  - Lowering a cap goes through a Bearer route, `POST /routing-spend/caps/lower`. It is
    a new route that only accepts values ≤ current and bumps `leaseEpoch`.
  - The agent confirms in chat what it did.
- **Raising, unfreezing or adding a caller:** the agent renders the plan
  (`POST /routing-spend/plan`, `caps-adjust`). It sends one Work Board card with an
  Approve control linking to the plan, and states the new figure. The PIN commit applies
  it.
- The agent **never** treats a chat "yes" as the PIN. It never enters the PIN itself,
  even though the PIN is readable on disk (memory note "chat approval is not PIN
  authorization").

### 10. Agent Awareness and Migration Parity

**Awareness.** A new entry file, `src/data/awareness/gemini-payg-lane.md` (no
`generateClaudeMd` edit), tells every agent:

- that the door exists, its four entry points, and that it is off unless the operator
  armed it
- how to ask for a second opinion (`POST /intelligence/gemini`)
- how to read spend (`GET /routing-spend/caps`)
- that stopping spend is the agent's call and raising it is the operator's
- that the key is never readable by sessions

**Core-heading row.** One row is added to the Registry First table:
"How much have we spent on Gemini / metered models?" → `GET /routing-spend/caps`. This
needs a `migrateClaudeMd` step with a content-sniffing guard.

**Migration Parity:**

- **Config:** nothing is added (absence means unchanged).
- **Price manifest and model table:** they ship in the package and need no migration.
- **`secret-get.mjs`:** the template changes. Scripts are refreshed on update, so a
  template-drift test is enough.
- **Caps store and ledger schemas** gain optional fields only. The fold handles absent
  `monthlyCapUsd`/`monthEpoch`, which keeps existing stores valid. A migration test
  loads a pre-change store.
- **Doorway manifest:** the rename from `gemini-direct-api` to `gemini-api` happens in
  the git-tracked manifest. The doorway scan's candidate detection treats the old name
  as an alias for one release.

### 11. Tests (Testing Integrity Standard — all three tiers)

**Unit (`tests/unit/`):**

- Transport:
  - builds the exact URL with no key in the URL
  - sends the key header only through `withKey`
  - redacts errors
  - leaves no key in a thrown stack
- Provider:
  - reserve math: countTokens path, byte-fallback path, thinking plus max output
  - settle math, including thoughts
  - every failure-table row
  - no retry
- Caps:
  - the month dimension in the fold
  - `monthEpoch` across a DST change and a month boundary in Los Angeles
  - strict `>` boundary on both sides
  - `validateCapsFile` with a monthly-only record
- Per-call ceiling: both sides.
- Allowlist:
  - a non-listed component never reaches admit
  - critical gates are refused at plan render
  - removal needs only Bearer, adding needs the PIN
- Unverified or stale price books at `conservativeMax`.
- Expiry books a provisional charge (never a release) for `gemini-api`.
- Lint fixtures: `lint-metered-secret-readers` and `lint-no-direct-llm-http`, a violating
  fixture and a clean fixture each.
- `secret-get.mjs`: refusal, plus a template-drift pin.
- **Child-env canary, value-based, across all five frameworks.**
- `buildProviderEnvFlags('google', api-key)` refuses.
- `filterSecretsForSync`: the metered name reaches only the designated machine.
- Lease self-confirmation:
  - confirmed, a conflicting peer leads to self-fence plus freeze, and a silent peer
    still confirms
  - go-live refuses when any registered machine did not answer
- Release gate: `armed-pending-proof` admits only `release-proof`.
- Default chains contain no metered door (regression pin).
- Wiring-integrity: the factory returns a real `GeminiApiProvider`, wrapped by the
  funnel, with the breaker key `gemini-api`.

**Integration (`tests/integration/`):**

- Full HTTP `POST /intelligence/gemini` against a local fake Google endpoint. The host is
  injected only through a test-only constructor parameter, never config.
- Paths covered: 200 with usage, 402 at cap, 503 money-off, 403 for a non-allowlisted
  caller, and the forward from a non-holder over a two-server mesh fixture.
- `GET /routing-spend/caps` proxied-to-holder, plus `holderUnreachable`.
- The composite `gemini-payg-setup` plan/commit with PIN, plus refusal on store-version
  drift.
- `caps/lower` refuses an increase.

**E2E (`tests/e2e/`):** the production init path, mirroring `server.ts`, with money on,
the door armed and a fake endpoint.

- `POST /intelligence/gemini` returns 200, not 503.
- A ledger row is settled.
- The cap reached mid-month refuses, and the next month boundary reopens.
- The spec-converge `gemini-api` family runs through `cross-model-review.mjs --family
  gemini-api` and folds a result.

**Live proof (before telling the operator it works):**

- The release-gate wiring call against the real API on this agent.
- One real `--family gemini-api` review pass on a small spec.
- A real E2 second-opinion request from a Telegram session (the user-facing surface)
  that returns a plain-words answer. A second request with the cap temporarily lowered
  (Bearer) returns the plain cap message.

## Decision points touched

| # | Decision point | Class | Floor / justification |
|---|---|---|---|
| D1 | Admit or refuse a metered call at the cap, per-call ceiling, freeze, stale/unverified price, or unbounded reservation | **invariant** | Money is a ruled exception (Rules 4 and 86): exact deterministic test, irreversible miss. Existing gate semantics, extended with a month dimension and a ceiling. |
| D2 | Is this caller allowed to use the metered door (allowlist) | **invariant** | Exact membership in an operator-PIN-set list: recorded governed state (Rule 4's "deterministic enforcement of recorded governed state"). |
| D3 | Refuse critical gates from the allowlist | **invariant** | Exact list membership. Safety floor: a gate must not depend on a monthly budget. |
| D4 | Key reader scope (lint) and `secret-get` refusal | **invariant** | Secrets are a ruled exception, and the membership test is exact. |
| D5 | Strip metered keys from every child env | **invariant** | Secrets ruled exception; unchanged existing floor. |
| D6 | Lease self-confirmation and self-fence on a conflicting peer designation | **invariant** | Exact epoch comparison on recorded state. Freeze is the conservative action. |
| D7 | Booking a timeout or expiry as a provisional full charge | **invariant** | Money: the over-booking direction is the safe default. A deterministic rule. |
| D8 | Spec-review step-down from Neon to Hydrogen when Neon does not fit the budget | **judgment-candidate** | Floor: the bounded action space {Neon, Hydrogen, unavailable}. Conservative default: `unavailable: budget-reserved`, recorded. Arbiter: deterministic fit test (reserve ≤ remaining month and ≤ ceiling). The fallback ends at the deterministic `unavailable` rung. Exemption argued: with only two models, the "judgment" is a fit computation, not competing signals, so no LLM arbiter adds value. |
| D9 | Invoice-drift notice when reconciliation differs by more than 10% or $2 | **judgment-candidate** | Signal only (it never moves the gate). Floor: one notice per month per drift episode. Unmeasurable is recorded as `unknown`, never a figure. Arbiter: the threshold is a notice trigger, and the agent investigates. |
| D10 | Forward E1/E2 from a non-holder to the holder vs. refuse locally | **invariant** | Routing by exact designation match. Never a local spend. |

## Frontloaded Decisions

- **FD-G1 — Direct HTTP door, not a CLI.** Reasons in §1. *Not cheap* (money and egress
  surface).
- **FD-G2 — Reuse the existing `gemini-api` door id; rename the doorway candidate
  `gemini-direct-api` to it.** *Not cheap* (published interface name), frontloaded.
- **FD-G3 — Not an `IntelligenceFramework`.** It is structurally excluded from every
  auto-selection path. *Not cheap.*
- **FD-G4 — Remove the metered positions from the default nature chains.** E3 is
  allowlist-only with an empty default. *Not cheap* (money).
- **FD-G5 — Built-in callers E1 (review, Neon), E2 (second opinion, Hydrogen by
  default), E4 (doorway liveness) are ON once armed. E3 is empty. Critical gates are
  never eligible.** *Not cheap* (money).
- **FD-G6 — No interactive or agentic sessions on the metered door in this spec.** At
  $3/$15 an agentic session can burn the month in hours, and the approval centred on
  integrating the models, not running conversations on them. A later spec can add it
  with its own budget slice. *Not cheap* (scope boundary, money).
- **FD-G7 — $50 monthly cap (operator's figure), $10 daily guard, $2.50 per-call
  ceiling, no lifetime cap. Month = Los Angeles calendar month.** All shown in the
  go-live plan text, so the PIN tap approves them knowingly. *Not cheap* (money).
- **FD-G8 — Single designated spender (the Studio for Echo). Other machines forward E1
  and E2 and skip E3.** *Not cheap* (multi-machine money).
- **FD-G9 — Key stays unsynced except to the designated machine.** One reader, and
  `secret-get` refuses it. *Not cheap* (secrets).
- **FD-G10 — Timeout and expiry book a provisional full charge.** *Not cheap* (money).
- **FD-G11 — The FD-11 release gate is enforced in code (`armed-pending-proof`)** for
  every metered door. *Not cheap.*
- **FD-G12 — Prices are recorded unverified and booked at conservative-max until the
  smoke test.** A reviewed commit flips them. *Not cheap* (gate-consumed price).
- **FD-G13 — One composite PIN plan for go-live.** It replaces three separate PIN
  entries (enable, caps, go-live); the restart is agent-owned. *Not cheap* (money
  authority surface).
- **FD-G14 — Fleet dark. Fleet-enable review 2026-12-21, owner Echo.** *Not cheap.*
- **FD-G15 — Thresholds at 50%, 80% and 100% of the month, live (not dry-run) on this
  agent, deferred through quiet hours.** *Not cheap* (operator-facing notices).

## Multi-machine posture

- **Money authority (caps record, go-live, ledger, totals): single-writer on the
  designated machine.**
  `machine-local-justification: physical-credential-locality` — the metered key lives
  only in the designated machine's vault (§4.5). The ledger is bound to where the key
  can be spent, and the cap is one pool-wide bound because exactly one machine can
  spend.
- **Money reads (`/routing-spend/caps`, Spend tab): proxied-to-holder**, with an honest
  `holderUnreachable` state.
- **E1/E2 calls: proxied** to the holder over the existing authenticated mesh relay.
- **E3 positions: skipped off-holder** (`no-cap-slice`, so the chain advances). No state
  is involved.
- **Designation record: unified**, published on the pool machine-registry heartbeat
  surface. Freeze-wins on conflict.
- **Metered key: machine-local to the designated machine.**
  `machine-local-justification: physical-credential-locality` — a credential on one
  disk. Sync is filtered so it reaches only the designated machine.
- **Prices, model table, doorway entry: unified** (git-tracked).
- **`feature_metrics` attribution rows:** recorded on the holder, because that is where
  the call runs. The pool summary uses the existing proxied-on-read fan-out.
- **Reconciliation record: holder-local**, with the same justification as money
  authority. It is read proxied-to-holder.
- **Single-machine agent:** trivially its own designated machine. Lease
  self-confirmation always succeeds when there are no peers.

## Self-Heal Before Notify — watcher declaration

This spec adds notice sources:

- **(a) Monthly threshold notices (50/80/100%).** These are information the operator
  asked for, not degradations. No self-heal applies. One notice per threshold per month.
- **(b) Invoice-drift notice.**
  - `class: recoverable`.
  - Self-heal: re-read the billing page once after 6h (`max-attempts: 1`). If still
    drifted, notify.
  - `max-notification-latency: 24h` (reporting only; no money at risk because the gate
    is independent).
  - `dedupe-key: drift:gemini-api:<monthEpoch>`.
  - `audit-location`: the reconciliation records.
- **(c) Holder-unreachable or conflicting-designation self-fence.**
  - A conflicting designation is `class: security` (dual money authority). It
    **notifies immediately** on the same tick, and the freeze has already happened. That
    is notify-and-heal.
  - Holder-unreachable reuses the parent spec's surviving-voice alert and its declared
    brakes, unchanged.

## Alternatives considered

- **A new `gemini-payg` framework value.** Rejected: frameworks are auto-selectable
  through roughly a dozen paths, and every one would need a "not this one" exception.
- **Rely on Google's spend limit alone.** Rejected: the subscriber-credits pilot spent
  $2.77 against a $1 provider limit with three parallel calls, so a provider limit is a
  soft backstop. It stays as the second wall.
- **Build the parent spec's Increment D (slicing).** Rejected: it is unnecessary with a
  single spender, and much larger.
- **The CLI with a scoped env exception.** Rejected: it breaks a pinned invariant, is
  token-blind, and rewrites model ids.
- **Bearer-writable caps "for convenience".** Rejected by the parent spec's invariant:
  raising money must not be possible with a token a session holds.

## Open questions

*(none — all resolved into Frontloaded Decisions)*

## Left behind

*(filled by convergence)*
