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

**Today, Instar cannot make a paid model call.**

- Instar deliberately removes Google, OpenAI and Anthropic API keys from every program
  it starts. `gemini-cli` (`geminiSpawn.ts` `GEMINI_BILLING_ENV_VARS`), `pi-cli`
  (`PI_BILLING_ENV_VARS`), `grok-build` (`GROK_BILLING_ENV_VARS`) and confined spawns
  (`credentialEnvNames.ts`) all strip them.
- The reason is written in `gemini-cli/credentials.ts`: a stray key "silently bills the
  user's Google/Gemini API account at full per-token rates".
- So the only Gemini access Instar has is the `gemini-cli` door, under whatever Google
  account signed that CLI in.

**The operator has now asked for a paid Gemini lane.** His decision, verbatim (Justin,
2026-11-20 13:26 PST, Telegram topic 145625; the logged message is the reply to Echo's
recommendation message 146146):

> "please proceed with the path that is the most cost-effective for us that you have
> recommended and let's set a $50 cap for now and integrate Gemini with our other
> options for models, including Gemini neon and Gemini hydrogen"

The recommendation he approved comes from the report "Theo subscription subsidy
playbook", 2026-11-20:

1. Gemini through a **pay-per-use API key** with a **hard $50/month cap**.
2. Justin's personal Google AI Pro stays **out** of autonomous Instar work.
3. The Gemini Enterprise seat is being cancelled.
4. Heavy work stays on the Claude and Codex subscriptions.

A separate account lane, coordinated by session `echo-topic-145625`, creates the key
(vault name `gemini_api_key_payg`) and the Google-side spend limit. This spec never
touches Google accounts.

**The design problem.** Add one deliberate, named, metered exception and keep the
key-stripping protection everywhere else:

- No other framework or process may pick up the key.
- Spend is capped **inside Instar**, not only at Google.
- The lane fails closed at the cap.
- Spend is visible.

**What already exists (extend, do not duplicate).** Main is at `d9117905d`.

- `docs/specs/routing-control-room-spend-alerts.md` ("the parent"), approved by Justin
  2026-07-07, built Increment B:
  - `MeteredSpendGate`: an O(1) gate that fails closed, with a closed list of refusal
    reasons.
  - `MeteredSpendLedger`: append-only and fsync'd, with reserve, settle and expire rows.
  - `RoutingSpendCapsStore`: per-key `KeyCapsRecord` plus a `GoLiveRecord` per door. It
    is PIN-only and machine-local.
  - `meteredCallEntry.admitMeteredCall`, which checks freeze, then live, then the gate.
  - A server-rendered PIN plan/commit flow, the dashboard Spend tab, `/mobile/spend` and
    `/routing-spend/*`.
- `docs/specs/money-layer-operator-enable-surface.md` (approved 2026-08-16) provides the
  per-machine money-layer ON switch.
- `src/data/llmBenchCoverage.ts` declares a metered routing door `gemini-api`
  (`METERED_ROUTING_DOORS`, keyRef `metered_gemini_bench`, label `flash-lite`).
  `MeteredSpendGate.billedOutputTokens('gemini-api')` already bills thinking tokens as
  output.

**What is missing:**

1. **The paid call.** `meteredCallEntry.ts`: "no paid provider call is made anywhere
   today". `IntelligenceRouter.resolveRoute` skips every metered door.
2. **A monthly cap.** Only lifetime and UTC-day caps exist. The enable-surface ELI16
   says: "There is no calendar-month limit in the model at all".
3. **Spending on a multi-machine agent.** With the session pool on,
   `leaseConfirmedAgoMs` is stubbed to `null` (`AgentServer.ts:3487`). Every admission
   refuses `lease-liveness-unconfirmed`, so Echo cannot spend at all.
4. **Prices and ids** for Gemini 4 Neon and Gemini 4 Hydrogen.
5. **Key protection.** The vault syncs whole to every peer (`SecretProvisioner.provisionAll`),
   and `secret-get.mjs` prints any key to any session.
6. **Caller control.** Arming the door today would make it the automatic first choice for
   every FAST component (`NATURE_ROUTING_DEFAULT_CHAINS`). The operator approved a
   deliberate lane, not an ambient one.
7. **The release gate in code.** The parent's FD-11 release gate is policy only.

## Constitutional fit (checked, not assumed)

The master constitution is the Instar 2.0 rule book (`JKHeadley/instar-2`
`docs/01-the-rules.md`, read 2026-11-20). The 1.x registry wording differs on some of
these articles, and the master governs.

- **Rule 4, verbatim:** "Code may make a decision without consulting the mind only where
  the test is exact: the three irreversible-miss cases — a live secret leaving, spend
  past a cap, and the operator's emergency stop — and deterministic enforcement of
  recorded governed state…"
  - The cap refusal is the "spend past a cap" case.
  - The daily guard, per-call ceiling, caller allowlist and E2 share are "recorded
    governed state". The operator sets them in a PIN-committed record whose text he
    approves.
- **Rule 86, verbatim:** "…with exactly two ruled exceptions — secrets and money, where
  the match is unambiguous and a miss is irreversible."
  - For that reason, the prompt secret check refuses only on an exact match against live
    secret values, never on a key-shaped pattern (§4.7).
- **Rule 122 (No Feature May Require a Purchased Service)** allows a paid service "as an
  optional add-on". With the lane absent, every feature works: chains use subscription
  doors only, and the review family reports unavailable.
- **Rule 118:** a second AI provider is never required. Satisfied the same way.
- **Rule 75 (Token-Audit Completeness).** The API returns per-call `usageMetadata`, so
  the door reports usage. `gemini-cli` is on the cannot-surface exemption list, which is
  one more reason to use the API rather than a CLI.
- **1.x Framework-Agnostic floor:** "Raw API is forbidden as a **routine** path." This
  lane is not routine: it is named, opt-in, operator-approved, capped and fails closed.
  The approved parent designed metered doors under this same article.
- **Provider-portability rules.** Spec 04 Rule 2 (Anthropic) and Spec 12 Rule 1 (OpenAI)
  are untouched.

**Approval path.** Rule 82 and the repo CLAUDE.md say the operator approves only changes
to the constitution and the protected list. `.github/CODEOWNERS` names only
`STANDARDS-REGISTRY.md` and `CODEOWNERS`, and this spec touches neither, so the agent
approves this spec. The operator's **money** authorization is a separate step that the
code enforces: the PIN commit in §8. Chat approval never stands in for it.

## Proposed design

### 1. How Instar calls Gemini: a direct HTTP door, not a CLI

**Decision: an in-process HTTPS provider, `GeminiApiProvider`, runs inside the agent
server behind the existing `gemini-api` metered door.**

**Why not a CLI:**

- **`gemini-cli` with a key** would break its "no leak, ever" strip invariant and leak
  canary. It is also token-blind (Rule 75 exemption). And it rewrites unknown model ids
  to the default (`KNOWN_GEMINI_MODELS` plus gemini-capacity-policy requirement 7), so
  Neon would silently become `gemini-2.5-flash`.
- **`pi-cli` with a Google key** would break `PI_BILLING_ENV_VARS`. Pi is also excluded
  from spec review because its endpoint can be custom.
- **`agy` under a consumer plan** is the case Google's FAQ calls "not supported under
  consumer plans". The parked Antigravity spec (PR #3514) needs the Enterprise seat,
  which is being cancelled.

**Shape** (all under `src/providers/metered/gemini-api/`):

| File | Role |
|---|---|
| `GeminiApiProvider.ts` | Implements `IntelligenceProvider.evaluate(prompt, opts)`. It builds **one immutable request object** (system instruction plus contents plus generation config) used for the secret check, token counting and the call. |
| `geminiApiTransport.ts` | Holds the only network calls. **Host is a code constant**: `generativelanguage.googleapis.com`, with no config or base-URL override, so prompts can never be redirected. Two operations: `models/{m}:countTokens` (free metadata) and `models/{m}:generateContent`. A test-only constructor parameter injects a fake host for tests; it is not reachable from config or HTTP. |
| `geminiApiKeyReader.ts` | The only named reader of the key (§4). It exposes `withKey(fn)` only to the transport. |
| `geminiApiModels.ts` | The door's own model table (label to id to max-tier). It does not share `KNOWN_GEMINI_MODELS`. |

**Request rules:**

- Text only in v1.
- `generationConfig.maxOutputTokens` is **always set** (the gate refuses
  `unbounded-reservation`).
- `thinkingConfig.thinkingBudget` is always set explicitly.
- Default sizes:
  - E1 review: 16,384 output plus 8,192 thinking.
  - E2: 4,096 output plus 2,048 thinking.
  - A caller-supplied size is clamped so that the reserve fits the per-call ceiling (§5).
- HTTP timeouts:
  - E1 Neon: 300s.
  - E2: 120s.
  - countTokens: 15s.
- A client disconnect does **not** abort the upstream call. The call completes and
  settles at its actual cost. Aborting would make the bill uncertain for no saving.
- Google's response text is untrusted output. It gets the same handling as the existing
  cross-model families' output.

**Lint and funnel:**

- `scripts/lint-no-direct-llm-http.js` gets **exactly one** new allowlist entry, the
  transport file, named here as its rule requires.
- The provider goes through `wrapForFunnel`, with the circuit-breaker key `gemini-api`.
  The breaker opens after 3 consecutive post-send failures (5xx or timeout).

**A door, not a framework.** `gemini-api` is **not** added to `IntelligenceFramework`.
It is therefore structurally absent from every place a framework can be chosen
automatically:

- `componentFrameworks` and the failure-swap tails
- `INTERNAL_FRAMEWORK_PREFERENCE` and the boot fallback
- topic and session framework pins
- job routing (`job-model-routing.md`: "No metered doors in any pin")

The doorway registry's candidate name `gemini-direct-api` is renamed to the canonical
`gemini-api` and promoted to a real door entry (§3), so one door has one name.

### 2. Who may route to Gemini (deliberate opt-in only)

Arming the door (§8) gates **money**. A second, independent control gates **callers**.

**Enforced at the chokepoint.** `AdmitRequest` gains two **required** fields:

- `component`: the attribution component.
- `caller`: one of the closed set below.

`admitMeteredCall` checks them in this order:

1. freeze
2. live
3. caller membership in the door's `meteredCallers`, and component membership for E3
4. release state (§8)
5. per-call ceiling
6. the gate

A missing `caller` refuses (`not-allowlisted`). No code path reaches the gate without
passing this check, so a future caller or a refactor cannot bypass it.

**Callers:**

| Caller id | Entry point | Default model | Default (this agent) | Why |
|---|---|---|---|---|
| `spec-review` (E1) | `crossModelReviewer` family `gemini-api` | **Neon**; steps down to Hydrogen only on `cap-exceeded`/`per-call-ceiling` when Hydrogen fits | ON once armed | Neon's strongest use is as an independent third model family in review. It also needs no personal Google sign-in. |
| `second-opinion` (E2) | `POST /intelligence/gemini` (Bearer) | **Hydrogen**; Neon on request | ON once armed | The conversational path: "ask Gemini Neon what it thinks of this". |
| `nature-routing` (E3) | An explicit opt-in chain position, per allowlisted component | Hydrogen | **Empty component list** | Background classifiers already run free on subscriptions. A busy sentinel at ~$0.0045 per call on Hydrogen would spend $45 in 10,000 calls, emptying the month the review purpose was approved for. |
| `doorway-liveness` (E4) | Doorway scan `+liveness` (manual, D9/D10) | Hydrogen | **OFF** | Its own `budgetCapUsd` is Bearer-writable config (default 0). It stays off until a later spec moves that budget into the PIN record. |

**How E1 reaches the server.** The spec-converge script (`cross-model-review.mjs`) runs
in its own process. It **never constructs `GeminiApiProvider`**. Its `gemini-api` family
is a thin HTTP client of the **local** server:

- It calls `POST /intelligence/gemini/review` on localhost with the agent token.
- That route stamps `caller: spec-review` server-side and admits through the chokepoint,
  or forwards it (§6).
- So the ledger has one writer, and the key has one reader.

**Reviewer family accounting.** `gemini-api` and `gemini-cli` share the family key
`gemini`, so family diversity counts Gemini once.

- When both are available, the round runs `gemini-api` only. It needs no personal Google
  sign-in, which fits "personal AI Pro out".
- `crossModelReviewer` gets an explicit trusted-door entry `gemini-api`, justified by
  the code-constant first-party host. It is not added to the CLI framework list.

**Guarding E2 (the Bearer route).**

- **`purpose` is required.**
- **Caller session** comes from the server's own session record. The route resolves the
  authenticated origin (the `X-Instar-Session` header checked against the live session
  registry). An unverifiable name is recorded as `self-reported:<name>`.
- **Accepted only from loopback, or from a signed mesh forward.** A request arriving
  through tunnel ingress is refused 403, so a leaked token used over the tunnel cannot
  spend.
- **Concurrency:** at most 2 E2 calls in flight per agent. The third gets 429
  `e2-busy`. It is not queued.
- **E2 share:** E2 may commit at most **40% of the month ($20)** and **$4 a day**. Both
  are stored in the PIN record and shown in the plan. This keeps at least $30 a month
  for reviews, the approved purpose, however a looping session behaves.

**Changes to existing routing:**

- `gemini-api` positions are **removed from `NATURE_ROUTING_DEFAULT_CHAINS`**. Default
  chains then contain only subscription doors. That default had no effect while the door
  could not dispatch; it becomes a real-money default only now.
- `meteredKeysFromChains()` no longer drives the Spend view. The view lists keys from
  the caps store and door registry.

**Allowlist authority:**

- Adding a caller or an E3 component, or raising a share, needs the operator PIN. That
  is a money release.
- Removing a caller, or lowering a share, is Bearer and immediate. That is halting money.

**Gating components are excluded in v1 (scope choice, not an invariant).** These are
refused at plan render:

- `NATURE_ROUTING_CRITICAL_GATES`
- InputClassifier, TaskClassifier and InputGuard

Their safety floor is already met by subscription fallback (Rule 118). Excluding them
keeps the month for review use and keeps a gate's latency off a metered network hop. A
later spec may revisit this.

**Sessions are out of scope** (FD-G6, and stated in the go-live plan text so the
narrowing is not silent).

- A request to pin a conversation to "Gemini Neon" gets a plain notice: Neon and
  Hydrogen are available as one-shot calls (reviews and second opinions), not as a
  conversation's engine. The pin falls back the way grok's missing-binary pin does.
- It never launches `gemini-cli` with Neon.

### 3. Models and prices (UNVERIFIED until the release gate verifies them)

| Label | Model id (unverified) | Input $/M | Output $/M (incl. thinking) | Source |
|---|---|---|---|---|
| `neon` | `gemini-4-neon` | 3.00 | 15.00 | Google announcement 18 Nov 2026, cited in the approved report. Not yet checked on Google's price page. |
| `hydrogen` | `gemini-4-hydrogen` | 1.50 | 7.50 | Third-party pricing sites only (apidog, tokencost, layer3labs, Nov 2026). The id was live-probed via the API on 2026-11-15 (doorway manifest note). |

**Tiers in the manifest schema.**

- Each price point gains `maxInputTokens`: the largest request input that this point's
  rate covers.
- A request whose counted input exceeds the highest **verified** tier for that model is
  refused with `outside-verified-tier`. That refusal is a scope limit, not a guess.
- If Google publishes a long-context rate (for example, above 200k tokens), it lands as
  a second point.
- Until then, `maxInputTokens` is the lowest disclosed tier threshold, or 200,000 if
  none is disclosed. So the gate never prices a request at a rate that might not apply.

**Verification.**

- Each point carries `verified: boolean`. `routingPriceAuthority.resolve` treats
  `verified: false` exactly like stale: `priceStale = true`, so the gate books at
  `conservativeMax`. Today the code only checks staleness; this field is a new code
  carrier and gets a test.
- `conservativeMax` is `{ in: 6.00, out: 30.00 }`, twice Neon's list price.
- Because the release gate requires verified prices (§8 (d)), unverified prices are only
  ever used for the single release-proof call.

**Manifest metadata.** Points use the 45-day freshness convention (`freshnessSlaDays: 45`,
`staleMode: book-conservative-max`). Points land by reviewed git commit, the sanctioned
non-PIN price path.

**Unknown model ids** are refused (`unknown-price`), never defaulted.

**Doorway registry.**

- `gemini-api` becomes a door with `accessMethod: "direct-api"` and
  `probe: { kind: "http-model-list", metered: false, vaultKeyName: "gemini_api_key_payg" }`.
- Neon and Hydrogen are listed under it with `role: "metered-lane"`, so `GET /doorways`
  shows them beside every other model option.
- `gemini-direct-api` is removed from `candidateDoorways`. The scan treats it as an
  alias for one release.

### 4. Key handling: one named reader, never on argv, never in a child

The key is the vault secret `gemini_api_key_payg`. A new constant set,
`METERED_SECRET_NAMES = ['gemini_api_key_payg']`, in `src/core/meteredSecrets.ts`, is
the single list every protection below reads.

**Key binding.** The `gemini-api` door's keyRef **is** the vault name
`gemini_api_key_payg`. It replaces `metered_gemini_bench` in `METERED_ROUTING_DOORS`,
in `DEFAULT_METERED_CAPS` (in the monthly shape, §5) and in `knownKeyRefs`.
`metered_gemini_bench` has no reader anywhere and is removed.

1. **One named reader, enforced by lint.** `scripts/lint-metered-secret-readers.js`
   fails the build if a member of `METERED_SECRET_NAMES` appears, or is passed to
   `SecretStore.get`, outside `geminiApiKeyReader.ts`, `meteredSecrets.ts`, the sync
   filter and tests.
   - The reader exposes `withKey(fn)` only. Its sole caller is the transport, which puts
     the value in the `x-goog-api-key` header.
   - **Honest limit:** the lint matches named reads. Whole-vault consumers still
     enumerate every key: the sync payload, the `--names` listing, and the boot list of
     key names. A unit test pins that each of those emits names only, or encrypted
     payloads only.
2. **`secret-get.mjs` refuses it.** It refuses names in `METERED_SECRET_NAMES` **at the
   top of the script**, before vault resolution and before the plain-config fallback, in
   every branch including the `--run` form. It exits 3 with
   `refused: metered key — readable only by its door`.
   - The list is a hand-kept literal, pinned to the TypeScript list by a template-drift
     test. The script is always overwritten on update (`PostUpdateMigrator`).
   - **Honest limit:** any process running as the agent's OS user could decrypt the
     vault directly. This is a boundary inside Instar's code, not an OS boundary. It
     closes the realistic leak paths: a session printing or exporting the key.
3. **The reader refuses plain-config copies.** If the name appears as plain text in
   `.instar/config.json`, the reader refuses (`key-in-plain-config`) and raises one
   notice asking the agent to move it into the vault. A tracked state file must never
   hold the key.
4. **Never in a child environment.** The existing strips stay. A new **value-based**
   canary plants the literal key value under every known variable name, and under an
   arbitrary name. It asserts the value is absent from the env and argv that each of the
   five frameworks' child-env builders produces.
5. **Close a dormant hole.** `buildProviderEnvFlags('google', {kind: 'api-key'})`
   (`Config.ts`) emits `GOOGLE_API_KEY`. It has no production callers. It will now
   **refuse**, as the openai case does, and its unit test will pin the refusal.
6. **Sync reaches only the designated machine.**
   - `filterSecretsForSync` gains `{ recipientMachineId, designatedMachineId }`, and
     `SecretProvisioner.provisionAll` filters **per peer** inside its loop.
   - Metered names are dropped for every recipient except the door's current
     `designatedMachineId`. With no designation yet, they are dropped for **all**
     recipients.
   - **Receive side:** `SecretShareHandler` strips and counts any metered name arriving
     at a machine that is not designated.
   - Tests cover each branch.
7. **Prompts never carry live secrets.** Before `countTokens`, the full immutable request
   (system instruction plus contents) is compared against the **exact values** of the
   vault and the credential environment.
   - An exact match refuses with `prompt-contains-live-secret`, which is the ruled
     secrets exception.
   - Key-shaped pattern matches (an example `AIza…` in a spec) are only a recorded
     signal. They do not block, because a shape is not an unambiguous match.
8. **Never in logs.** The transport strips the header from any rethrown error. A unit
   test asserts an error's message, cause and stack never contain the key.

**Pre-ship sequencing.** The key is being created **now**, before these protections
exist. Two steps cover this:

- A brief was sent to `echo-topic-145625` (2026-11-20 13:46 PST). It asks for the key to
  be stored in the vault **on the Studio only**, or left in Secret Drop. It must never go
  in an env, shell or config file.
- **Go-live precondition:** the composite plan (§8) queries every registered peer for its
  vault key **names** (never values). Go-live refuses unless `gemini_api_key_payg` is
  present on the designated machine and absent everywhere else.
  - An unreachable peer counts as unknown, and unknown refuses.
  - When the key has spread, the plan offers two fixes: **purge** (a signed mesh command
    `secret-purge-metered`, which deletes metered names on non-designated peers), or
    **rotation** (the account lane issues a new key to the Studio and revokes the old
    one).

### 5. The in-Instar $50/month cap (extends the money layer)

**Period model.**

- `KeyCapsRecord` gains `monthlyCapUsd?` and `periodTimeZone?`.
- `lifetimeCapUsd` becomes optional when `monthlyCapUsd` is set.
- **Code changes named:**
  - Gate step 3 (`invalid-cap`) accepts a monthly-only record.
  - `validateCapsFile` requires one of lifetime or monthly, plus a daily cap.
  - The `caps-adjust` plan and its renderer gain the monthly field. They no longer call
    `lifetimeCapUsd.toFixed` on null.
- **Ledger totals** gain `committedMonthUsd` and `monthEpoch`. The month total is a
  running O(1) value. `admitOnlyUnderCaps` checks month, then day, then lifetime inside
  the existing per-key critical section, with the same strict `committed + reserve > cap`.
- **Period zone.** For `gemini_api_key_payg`, the day and month are both in
  `America/Los_Angeles`, because Google's billing month and the operator's day are
  Pacific. The zone is a per-key value in the PIN record, defaulting to UTC for every
  other key so existing behaviour is unchanged. Epochs are recomputed from row
  timestamps during the fold, so a zone change cannot reopen headroom.

**Limits for `gemini_api_key_payg`** (all operator-approved governed state, shown in the
PIN plan):

| Limit | Value | Basis |
|---|---|---|
| Monthly cap | $50 | The operator's figure. Basis: external constraint (the operator's money grant). |
| Daily guard | $10 | An operator-approved pacing default. A runaway day cannot drain the month, so reviews stay possible later in it. It is a default above the $50 floor, not an invariant. A refusal names the period and the reset time, and the operator can change it like any cap. |
| Per-call ceiling | $2.50 | An operator-approved default. One malformed or oversized call cannot take more than 5% of the month. With verified prices, a 250k-token Neon review reserves about $1.11 (0.75 + 0.36), comfortably under it. |
| E2 share | 40% of the month ($20), $4/day | Keeps at least $30 for reviews (§2). |
| Lifetime | none | The monthly cap is the operator's bound. |

**Reserve.** The ordered steps:

1. **Preflight.** Run checks 1–4 of §2's order (freeze, live, caller, release state)
   **before the key is used at all**.
2. **Secret check** (§4.7).
3. **Count input tokens** with `countTokens` on the exact request.
   - If countTokens fails, the bound is the request's total UTF-8 bytes plus 512. That
     is a strict bound for text: a text token is at least one byte, and 512 covers role
     framing.
   - If that bound pushes the reserve over the per-call ceiling, refuse with
     `token-count-unavailable` (not `per-call-ceiling`), so an outage reads as an
     outage.
4. **Reserve** `input × inRate + (maxOutputTokens + thinkingBudget) × outRate`. Cached
   tokens are booked as full input (parent FD-19). The tier is checked here
   (`outside-verified-tier`).
5. **Gate.** Per-call ceiling, then the gate.

**Settle.** One commitment per `reserveId`:

| Outcome | Booking |
|---|---|
| 200 with `usageMetadata` | `settleActual`: prompt tokens at the input rate, plus `billedOutputTokens` (candidates plus thoughts) at the output rate. |
| 200 with no `usageMetadata` | Settle at the full reserve. |
| 400 / 401 / 403 / 404 / 429 before generation, no usage returned | `settleNoCharge`. These are request-rejection codes, issued before any generation. |
| 5xx, timeout, abort or connection drop **after the request was sent** | **Provisional charge at the full reserve.** We cannot prove Google did not bill. |
| Reserve TTL expiry with no settle (crash) | **Provisional charge at the full reserve.** A per-door fold change: for `gemini-api` an expire row contributes its reserve amount, where today's fold contributes $0. |
| A late settle after a provisional charge | The fold keeps **max(provisional, actual)**. It books only the excess above the provisional amount, never a fresh full row. A lower actual never returns headroom (parent FD-21: "provider-LOWER never lowers the committed counter"). The spec says this plainly: provisional amounts are sunk until the month resets. |

**Bounding provisional drain.**

- **Provisional ceiling:** once provisional charges in a month exceed $10, new
  admissions refuse `provisional-ceiling` and one notice is sent. This is
  `class: recoverable`, with self-heal being the breaker plus the next month boundary.
  It means something is wrong upstream, and stopping is cheaper than continuing.
- **Restart drain:** the agent's own restart path waits up to 300s for in-flight metered
  calls (`settlingCount`) before restarting.
- **No retries:** the provider never retries automatically. A caller retry is a new
  reservation, except forwarded calls, which are idempotent by `callId` (§6).

**Refusal reasons.** The closed `MoneyGateRefusalReason` union is extended with:

- `not-allowlisted`
- `armed-pending-proof`
- `per-call-ceiling`
- `outside-verified-tier`
- `token-count-unavailable`
- `prompt-contains-live-secret`
- `provisional-ceiling`
- `e2-share-exceeded`
- `reserves-outstanding`: returned when committed spend plus reserve breaches the cap
  but settled spend plus this reserve would not, so the caller should retry shortly.

Caller-side postures (not gate reasons) are `holder-unreachable`, `peer-version` and
`lease-liveness-unconfirmed` (passed through).

**Every reason maps to its own HTTP status and plain message, and survives forwarding
unchanged.**

| Reasons | Status |
|---|---|
| `cap-exceeded`, `e2-share-exceeded` | 402, with `period: day\|month`, `settledUsd`, `outstandingUsd`, `capUsd`, `resetsAt` |
| `reserves-outstanding` | 409 with `retryAfterSec` |
| `frozen`, `not-live`, `armed-pending-proof` | 423 |
| `not-allowlisted` | 403 |
| `prompt-contains-live-secret` | 422 |
| `token-count-unavailable`, `holder-unreachable`, `lease-liveness-unconfirmed` | 503 |

E1 records the exact reason in the round's posture. It steps down to Hydrogen **only**
on `cap-exceeded` or `per-call-ceiling`.

**Notices.** One voice, from the holder, to the parent's approved "💰 Routing & Spend
Alerts" topic:

- **Pushed:**
  - 100% of the month reached (once per month).
  - `provisional-ceiling`.
  - A conflicting-designation self-fence (§6).
  - Invoice drift (§7).
- **Not pushed:** 50% and 80%. They show on the Spend tab and in the `/routing-spend/caps`
  answer, per Near-Silent (Rule 87): spending within the authorization needs no action.
- **Quiet hours (23:00–07:30 Pacific):** the 100% notice waits until 07:30. Nothing is
  lost, because the gate has already stopped spending. The conflicting-designation
  notice is security-class and goes immediately.

### 6. Multi-machine: one spender, one shared cap

**Single-writer money on one designated machine (parent FD-13/FD-20), working on a pool
agent.**

**Who spends.**

- Only the machine named as `designatedMachineId` in the door's `GoLiveRecord`. For
  Echo, that is the Studio, which holds the Telegram lease and the feedback-factory
  state. It is shown in the plan.
- Every other machine refuses locally with `no-cap-slice`.

**Forwarding E1 and E2 from other machines.**

- **The check order on a non-designated machine:** E1 and E2 forward **whether or not
  that machine's own money layer is on**. Forwarding needs only the published
  designation (below), never local money state. The same holds for
  `GET /routing-spend/caps`, which proxies to the holder.
- **Transport:** a new **signed mesh command**, `metered-gemini-call`, with a version
  floor.
  - The caller id is fixed by the command's `op` field (`spec-review` or
    `second-opinion`), set by the originating server route, never by the request body.
  - It carries the originating machine and the server-resolved session.
  - **Submit then poll:**
    - The holder returns a `callId` at once, and the caller polls
      `metered-gemini-result` until a final state or 360s.
    - `callId` is the caller-generated idempotency key, so the holder deduplicates on
      it. A retried submit returns the existing call; it never makes a second
      reservation.
  - Body limit: 2 MB.
- **Route fallback.** Agent memory records the Mama PC→Studio mesh relay at "machine
  unreachable" while the Studio tunnel worked. The command therefore tries the mesh
  rope first, then the holder's authenticated tunnel, carrying the **same signed
  envelope**.
- **Failure states:**
  - A peer below the version floor gets `peer-version`.
  - An unreachable holder gets `holder-unreachable`.
  - Nothing ever falls back to a local spend.
- **E3 is never forwarded.** Its positions off the holder are skipped (`no-cap-slice`,
  so the chain advances). Background classification gets no cross-machine latency.

**Stop actions reach the spender.**

- Freeze, `caps/lower`, `callers/disable` and share-lowering issued on any machine are
  **forwarded to the holder** by the same signed command (`op: stop-action`). The agent
  reports "stopped" only after the holder confirms the write.
- **If the holder is unreachable,** the issuing machine publishes a `freezeRequested`
  flag for the keyRef on its heartbeat (freeze-wins, parent S-F5). The holder honours
  any peer's flag the moment it sees it. The agent tells the operator plainly: "stop
  requested; the spending machine has not confirmed yet".

**Designation and lease liveness** (replacing the `poolOn ? null` stub, and inheriting
parent N-2 unchanged).

- **Published designation.** The holder publishes on the pool machine-registry
  heartbeat:

  ```
  { keyRef, designatedMachineId, epoch, monthEpoch, committedMonthUsd, committedDayUsd,
    outstandingReserveUsd, provisionalMonthUsd, frozen }
  ```

  The reserved `PROBE_DOOR` is **never** published and never counted in conflict
  checks.
- **Positive re-confirmation.**
  - `leaseConfirmedAgoMs` is the age of the holder's last **positive** confirmation. A
    confirmation counts only when at least one peer's heartbeat **echoes** the holder's
    current `{keyRef, epoch}` (each machine mirrors the designations it has seen) and no
    peer publishes a conflicting designation.
  - The check runs every 20s, with exponential backoff to at most 60s while failing.
  - The gate's `LEASE_LIVENESS_WINDOW_MS` (60s) is pinned **strictly shorter** than the
    mesh-death threshold that makes a reclaim eligible.
  - An isolated holder therefore fences itself to $0 before any reclaim can be offered.
    The cost is a pause during a network blip, which is acceptable for a non-critical
    lane.
- **If the registry cannot be read:** the result is `unknown`, and unknown fences.
- **Single-machine agent:** no peers are registered, so it trivially self-confirms (it
  is the pool).
- **Conflicting designation:** a holder seeing a conflicting designation (another
  machine claiming the same keyRef at any epoch) **freezes** at once and notifies
  (security class).

**Holder death and reclaim.** This uses the parent's PIN-gated reclaim, extended:

- **Eligibility:** only after the mesh-death threshold, and **refused while the
  alive-but-partitioned signal is present** (parent N-2: the old holder's git-synced
  heartbeat still advancing while its ropes are down).
- **Month rebase:** the new holder's month starts at
  `max(the last heartbeat-carried committedMonthUsd + outstandingReserveUsd, an
  operator-attested figure)`. The plan shows both with their ages. This extends the
  parent's rebase `max()` to the month dimension.
- **Key rotation is a required reclaim step.** The account lane revokes the old key at
  Google and issues a new key, provisioned on the new holder only. Until rotation is
  recorded, the new holder's door stays `armed-pending-proof`. Rotation is the physical
  fence: a stale vault copy on a revived old holder is dead at Google.
- **No auto-grab.** "Every registered machine answered" does not apply to reclaim, by
  design: the old holder is the one not answering. Its exclusion is safe only because of
  the fence and the rotation above.

### 7. Visibility

`GET /routing-spend/caps` (proxied to the holder from any machine; cached at most 30s,
with its age shown; `holderUnreachable` with last-known values) shows, for
`gemini_api_key_payg`:

- month settled and committed against the cap, day against the guard, and `resetsAt`
- outstanding reserves and the provisional total
- the per-call ceiling and the E2 share used
- the callers and E3 components
- the designated machine and the release state

**Per-caller breakdown comes from the money ledger, not the reporting table.**

- Booking rows gain `component` and `caller` fields.
- The ledger is retained, not pruned, so the month breakdown by caller is exact.
- The 30-day pruning of `feature_metrics` and its UTC-day rollup cannot distort it.
- `feature_metrics` still gets `attribution.door = 'gemini-api'` and
  `callId = meteredCallId = reserveId` (parent FD-11/FD-21), for the usage views.

**Spend tab and `/mobile/spend`.** Both renderers (`dashboard/spend-arming.js`,
`mobileCapacityRoutes.ts`) gain the monthly row. No new page.

**Conversational answer.** "How much have we spent on Gemini?" reads
`GET /routing-spend/caps` (a Registry First row, §10). The answer is in dollars, never
from memory.

**Invoice-drift reporting (parent FD-11c).**

- A job, `gemini-payg-reconcile`, runs on the holder on the 2nd of each month at 09:00
  Pacific. It reads last month's spend for the key's project from the AI Studio / Cloud
  billing page, read-only, through the account lane's signed-in browser profile (the
  normal-chrome-browser skill).
- It posts the figure to `POST /routing-spend/reconciliation`. Each record carries the
  posting machine and session and `source: browser-read`. Reporting only; never a gate
  input.
- **Drift over 10% and over $2:**
  - Re-read once after 6 hours.
  - If still drifted, send one notice.
- **If the page cannot be read,** the record is `unmeasurable`, never a guessed figure.
- The job is quiet unless drift is found (quiet-by-default). Its manifest ships disabled
  fleet-wide and enabled on this agent by the go-live plan.

### 8. Shipping state, the one operator action, and the release gate

**Maturation rungs (Rule 72).**

1. **Test agent.** A fake Google endpoint, plus a throwaway two-home pair on the Mama PC
   with the local mesh fixture. All tiers green, plus the holder-death drill.
2. **Development agent: Echo.** Live after the PIN and the release gate. Soak until
   2026-12-21.
3. **Fleet: dark.** Echo reviews fleet enablement on **2026-12-21**, with evidence:
   month booked against invoice drift, refusal-reason counts, and forward success rate.
   This is tracked as a commitment opened at merge.

**Fleet defaults.**

- `routingSpend.money.enabled` stays off fleet-wide (`DARK_GATE_EXCLUSIONS`,
  action-bearing).
- No config default is added; absence means unchanged.
- With money off and no designation published, E1 reports
  `unavailable: money-layer-off`, and E2 returns 503.

**The composite go-live plan (one PIN entry).** Today the money layer is built only at
boot, so there is no caps store to commit against before the restart (integration
review). The plan is therefore a **pending-intent** commit:

1. **Render.** The agent asks for `POST /routing-spend/plan-money-layer` with
   `kind: gemini-payg-setup`.
   - This route works with money off (the enable surface's routes all do).
   - Rendering is **forwarded to the designated machine** and performed by its server.
     The text is generated from the exact struct to be committed, with one line per
     field, and the PIN commit binds to the struct's hash.
   - The precondition checks run at render time: the key on the designated machine
     only, every peer answered, and no conflicting designation.
2. **Commit.** `POST /routing-spend/money-layer/commit` with the PIN, on the Studio.
   Using the parent's write discipline, it writes:
   - the enable-store flag
   - a **pending-setup intent** file, `state/money-pending-setup.json`, holding the
     struct and its hash
3. **Apply at boot.** On the next boot, the money-layer constructor applies the intent
   into the caps store in one locked write before serving: caps, go-live as
   `armed-pending-proof`, callers, shares and zone.
   - It deletes the intent only after the caps write has been fsync'd.
   - Applying is idempotent by intent hash.
   - A crash between the two steps re-applies on the next boot.
4. **Restart.** The agent restarts through the enable surface's own PIN-free path for an
   already-committed enable. It does not create a second PIN step: the PIN in step 2
   already authorized the money change, and a restart releases no money.
   - If that route still requires the restart nonce plus PIN, the commit response
     returns the nonce, and the restart is called within the nonce's lifetime.
   - The build verifies which applies, and tests it.

**The plan text lists every committed field in plain words:**

- the money layer on for this machine
- $50 per month, $10 per day (Pacific), and $2.50 per call
- the designated machine (the Studio)
- callers: reviews by Neon; second opinions by Hydrogen, or Neon on request, from **any
  of my sessions**, at most $20 a month and $4 a day; background checks none;
  model-checking tool off
- step-down from Neon to Hydrogen when Neon would not fit
- the two models, with "prices unverified until the first test call"
- that Justin's personal Google account is not used
- that conversations cannot run on Gemini in this version
- that the agent can stop or reduce spending at any time without asking, but cannot
  raise any limit or add a caller without him

**Delivery.** One Work Board card with an Approve control. It links to the **Studio's**
Spend-tab plan view, where the plan was rendered (plans are bound to their machine).

**The run boundary.**

- **Run 1** ends when the plan is rendered and the card is sent. A watcher is armed on
  the commit.
- **Run 2** starts when the commit is recorded. It covers restart, `enforcementReady`,
  the release gate, live proof and the completion report. The report states the session
  exclusion and how to ask for it later.

**Release gate (parent FD-11, now in code).**

- `setGoLive` writes `armed-pending-proof`. Only the proof recorder, an internal code
  path, sets `live`.
- The `release-proof` marker is set **only** by that internal path. It is refused as
  request input, exactly like `PROBE_DOOR` is today.
- **`PROBE_DOOR` is exempt** from the release state, so `enforcementReady` keeps
  working.
- `live` requires all of the following:

| Check | Requirement |
|---|---|
| (a) Wiring proof | One live call on the door's cheapest priced model (Hydrogen, ≤ 64 output tokens; empty text is fine for a thinking model) shows `door === ledger door === priced door` and a settled row. |
| (b) Holder-death drill | Required only when the agent has more than one machine. It runs on the test-agent pair: kill the holder, observe the fence, the surviving-voice notice and lane unavailability, then PIN-reclaim. The recorder checks the live-test harness's **signed** PASS artifact (path plus hash). **Honest limit:** that artifact is produced by an agent-run harness, so this check binds the agent to a recorded, signed run. It does not prove an independent witness. |
| (c) Reconciliation | One **real** `browser-read` record. An `unmeasurable` record does not satisfy it. |
| (d) Prices verified | A reviewed commit sets `verified: true` on both points, citing the price and tier read on Google's page (browser read, Run 2). |
| (e) Forward proof | On a multi-machine agent, one E1 forward from a non-designated machine (the Mama PC) completes. |

**If a release check cannot be met,** the door stays `armed-pending-proof`, and the
completion report names the exact blocker. The agent never relaxes a check.

**Every metered door inherits the general rule** ("the smallest bounded call on the
door's cheapest priced model", with (b) and (e) only on multi-machine agents). There are
no other armed doors today.

**Backups and rollback.**

- Money state (caps, ledger, intent, reconciliation) stays deliberately **excluded from
  backups**: restoring an older ledger would reopen spent headroom.
- Rollback order: **freeze** (Bearer, instant), then disarm (Bearer), then revert.
  Reverting leaves optional fields that the older validator ignores. If it rejects them,
  the door stays frozen, which is the safe direction. A test pins the older-validator
  behaviour.

### 9. Changing limits conversationally

- **Lowering, pausing or stopping** ("stop Gemini for now") is the agent's to do at
  once, with no PIN.
  - These use freeze, `POST /routing-spend/caps/lower` (a new Bearer route that accepts
    only values ≤ current and bumps `leaseEpoch`), `callers/disable` and share-lowering.
  - From any machine, these are forwarded to the holder (§6).
  - Each is audited with the server-resolved session.
  - One notice names who did it and links to the restore plan, so a confused session
    cannot quietly leave the lane down.
- **Raising, unfreezing or adding a caller** ("raise the Gemini cap to $80"): the agent
  renders a `caps-adjust` plan on the Studio and sends one Work Board card that links to
  it and names the new figure. The PIN commit applies it.
- The agent never treats a chat "yes" as the PIN, and never enters the PIN itself, even
  though it is readable on disk (memory note "chat approval is not PIN authorization";
  the PIN routes also record the human-presence surface, as the parent built).

### 10. Agent Awareness and Migration Parity

**Awareness.** A new entry file, `src/data/awareness/gemini-payg-lane.md` (no
`generateClaudeMd` section), covers:

- that the door exists, its callers, and that it is off until armed
- asking for a second opinion (`POST /intelligence/gemini`, with `purpose`)
- reading spend (`GET /routing-spend/caps`)
- that stopping is the agent's call and raising is the operator's
- that sessions cannot read the key, and conversations cannot run on Gemini in v1

**Registry First row.** "How much have we spent on Gemini / metered models?" →
`GET /routing-spend/caps`. This needs a `generateClaudeMd()` edit for new agents plus a
`migrateClaudeMd()` step with a content-sniffing guard, and it must fit the CLAUDE.md
core budget ratchet.

**Migration Parity:**

- No config field is added.
- The price manifest, model table and doorway manifest ship in the package.
- `secret-get.mjs` is always overwritten on update, and the drift test pins it.
- The caps and ledger schemas gain optional fields only. The fold handles their absence.
  A test loads a pre-change store and ledger.
- The bench keyRef rename is a code constant. An existing caps file holding
  `metered_gemini_bench` (only possible on a hand-armed agent; none is known) is left in
  place, and the key's view shows it as retired.

### 11. Tests (Testing Integrity Standard — all three tiers)

**Unit:**

- **Transport:**
  - fixed host, key only in the header, never in the URL
  - errors redacted
  - no key in a stack
- **Provider:**
  - one immutable request used three times
  - the countTokens path, and the byte fallback including the system instruction
  - `token-count-unavailable`
  - the tier refusal
  - every settle-table row
  - no retry
  - a client disconnect does not abort upstream
- **Caps and ledger:**
  - monthly-only validation, and the gate's `invalid-cap` step accepting it
  - LA-zoned day and month across DST and a month boundary
  - strict `>` on both sides of the month, day and E2-share limits
  - expiry booked as provisional for `gemini-api` and $0 for other doors
  - late settle uses max(provisional, actual), with no fresh row
  - the provisional ceiling
  - `reserves-outstanding` against `cap-exceeded`
- **Admission order:**
  - the key is never touched when preflight refuses
  - a missing caller refuses
  - E3 components are checked
  - the critical-gate refusal at plan render
  - add needs the PIN, remove needs only Bearer
- **Price authority:** `verified: false` is treated as stale.
- **Refusals:** each new reason maps to its status and message, and survives forwarding.
- **Key handling:**
  - both lint rules, with violating and clean fixtures
  - the `secret-get` top-of-script refusal in every branch, plus the drift pin
  - the reader refuses a plain-config copy
  - the value-based child-env canary across five frameworks
  - the `buildProviderEnvFlags` google refusal
  - per-recipient sync filtering, the receive-side strip, and the no-designation drop-all
  - whole-vault consumers emit names only
- **Lease:**
  - positive confirmation needs a peer echo
  - an isolated holder fences at the window
  - unreadable is unknown and fences
  - a conflicting peer causes freeze plus notify
  - the probe door is never published
  - backoff on failure
- **Reclaim:**
  - refused while partitioned-alive
  - month rebase max()
  - `armed-pending-proof` until rotation is recorded
- **Release gate:**
  - `release-proof` is refused from request input
  - `live` needs (a)–(e) as applicable
  - the probe door is exempt
- **Pending-intent apply:** idempotent, survives a crash between write and delete,
  hash-bound.
- **Plan render:** every committed field appears in the text (a property test over the
  struct).
- **Default chains** contain no metered door (regression pin).
- **Wiring:** the factory returns a real funnel-wrapped `GeminiApiProvider` with the
  breaker key `gemini-api`, and the spec-converge family calls the local route, never
  the provider.

**Integration:**

- `POST /intelligence/gemini` and `/review` against a fake endpoint:
  - 200 with usage
  - 402 at the month cap, then the day cap (with `period`)
  - 423 money-off
  - 403 from tunnel ingress
  - 429 for a third concurrent E2 call
  - `e2-share-exceeded`
- **Two-server mesh fixture:**
  - a forward from a non-holder **with its money layer off**
  - submit-then-poll, and an idempotent retry that makes no second reservation
  - mesh-rope failure falling back to the tunnel path
  - stop-action forwarding, and `freezeRequested` honoured when the holder was
    unreachable
  - the caps read proxied, plus `holderUnreachable`
- The composite plan: render on the designated machine, PIN commit, restart, intent
  applied, state `armed-pending-proof`. Store-version drift refuses.
- `caps/lower` refuses an increase.

**E2E (production init path, mirroring `server.ts`):**

- Money on, intent applied, the release gate satisfied with fakes, then
  `POST /intelligence/gemini` returns 200, not 503.
- A row is settled.
- A mid-month cap refuses, and the next LA month boundary reopens.
- `cross-model-review.mjs --family gemini-api` reaches the route and folds a result.

**Live proof** (Run 2, before telling the operator the lane works):

- Release-gate checks (a)–(e) on the real API.
- One real `--family gemini-api` review pass on a small spec, run from the Mama PC.
- One real E2 second-opinion request from a Telegram session, through the user-facing
  surface, with a plain-words answer.
- One E2 request with the day guard temporarily lowered (Bearer), which returns the
  plain cap message.
- The guard is then restored by PIN plan, or left lowered with a note to the operator.

## Decision points touched

| # | Decision point | Class | Floor / justification |
|---|---|---|---|
| D1 | Admit or refuse at the month cap, freeze, live, stale/unverified price, unbounded reservation | **invariant** | Rule 4 "spend past a cap": an exact test with an irreversible miss. This is the existing gate plus the month dimension. |
| D2 | Admit or refuse at the daily guard, per-call ceiling, E2 share, provisional ceiling | **invariant** (governed state) | Rule 4 "deterministic enforcement of recorded governed state". The values are set by the operator's PIN-committed plan, whose text lists them. They are defaults above the $50 floor that the operator approved and can change. |
| D3 | Caller and E3 component allowlist membership | **invariant** (governed state) | Exact membership in a PIN-set list, checked at the chokepoint. |
| D4 | Exclude gating components from E3 in v1 | **judgment-candidate**, argued exemption | A v1 scope choice. The floor (subscription fallback, Rule 118) already protects gates. The exemption from an LLM arbiter is argued: an operator-reviewable scope line, not a runtime competing-signals decision. Revisitable by a later spec. |
| D5 | The key's named-reader lint, `secret-get` refusal, child-env strip, per-recipient sync filter | **invariant** | Secrets ruled exception (Rule 86); exact name membership. |
| D6 | Refuse a prompt containing a **live secret value** | **invariant** | Secrets ruled exception, with an exact value match only. Shape matches are signal only. |
| D7 | Lease positive confirmation; fence on isolation or unknown; freeze on a conflicting designation | **invariant** | Inherited parent N-2: exact epoch comparison on recorded state, with the conservative action. |
| D8 | Book a post-send failure, or an expiry, as a provisional full charge; late settle max() | **invariant** | Money: over-booking is the safe direction, and a deterministic rule. |
| D9 | Spec-review step-down from Neon to Hydrogen | **judgment-candidate** | Bounded actions {Neon, Hydrogen, unavailable}. Triggers only on `cap-exceeded` or `per-call-ceiling`. Arbiter: a deterministic fit test. Conservative default: `unavailable` with the exact reason. Exemption from an LLM arbiter argued: with two models it is a fit computation, not competing signals. |
| D10 | Invoice-drift notice (>10% and >$2, after one re-read) | **judgment-candidate** | Signal only, never moves the gate. Unmeasurable is recorded as `unmeasurable`. The agent investigates. |
| D11 | Forward E1/E2 and stop actions to the holder vs. refuse locally | **invariant** | Exact designation match. Never a local spend. |
| D12 | Release state: `armed-pending-proof` until (a)–(e) | **invariant** | Recorded proof artifacts; deterministic checks. |

## Frontloaded Decisions

All are *not cheap* (money, secrets, published interface, or multi-machine authority),
and all are frontloaded.

- **FD-G1:** a direct HTTP door in the server, not a CLI (§1).
- **FD-G2:** reuse door id `gemini-api`. Rename the doorway candidate to it. The keyRef
  is the vault name `gemini_api_key_payg`, and `metered_gemini_bench` is removed.
- **FD-G3:** not an `IntelligenceFramework`.
- **FD-G4:** remove metered positions from the default nature chains. E3 is
  allowlist-only, with an empty default.
- **FD-G5:** callers at go-live are E1 (Neon review) and E2 (Hydrogen second opinion,
  Neon on request). E3 is empty and E4 is off. Gating components are excluded in v1.
- **FD-G6:** no conversations or agentic sessions on the door in v1. This is stated in
  the plan text and the completion report, with the opt-in route being a later spec with
  its own budget.
- **FD-G7:** $50 per month, $10 per day, $2.50 per call, E2 at 40% ($20) of the month
  and $4 a day, a $10 provisional ceiling, no lifetime cap, and the Pacific zone for day
  and month. All are listed in the PIN plan text.
- **FD-G8:** the Studio is the single spender. E1, E2 and stop actions forward by signed
  mesh command, submit then poll, idempotent, with a tunnel fallback. E3 is skipped off
  the holder.
- **FD-G9:** the key reaches only the designated machine (per-recipient sync, a
  receive-side strip, drop-all with no designation). There is one named reader, and
  `secret-get` refuses it. Go-live requires the key on the Studio only.
- **FD-G10:** post-send failure and expiry are provisional full charges. Late settle uses
  max(). There is a provisional ceiling.
- **FD-G11:** the release gate is enforced in code (`armed-pending-proof`, checks
  (a)–(e)). The probe door is exempt.
- **FD-G12:** priced tiers with `maxInputTokens`, and `outside-verified-tier` refuses.
  `verified: false` is treated as stale, and verification is release check (d).
- **FD-G13:** go-live is one PIN commit of a pending-setup intent, applied at boot. The
  restart is agent-owned.
- **FD-G14:** fleet dark. Rungs: test agent, then Echo, then a fleet review on
  2026-12-21, owner Echo.
- **FD-G15:** only 100%, provisional-ceiling, conflicting-designation and drift notices
  are pushed. 50% and 80% show on the Spend tab.
- **FD-G16:** reclaim requires key rotation at Google and a month rebase max(). It is
  refused while the old holder is partitioned but alive.
- **FD-G17:** account-lane work is routed to `echo-topic-145625` (brief sent 2026-11-20).
  Rotation at reclaim and the price-page read are steps owned by Run 2 or the reclaim
  plan, done through the account lane's browser profile. The run's precondition is the
  key present on the Studio only.

## Multi-machine posture

- **Money authority (caps record, go-live, ledger, totals, pending intent):
  single-writer on the designated machine.**
  `machine-local-justification: physical-credential-locality` — the metered key lives
  only in the designated machine's vault (per-recipient sync filter, receive-side strip,
  go-live precondition). Money authority is bound to where the key can be spent, so
  exactly one machine can spend and the cap is one pool-wide bound.
- **Money reads (`/routing-spend/caps`, Spend tab, mobile): proxied-to-holder**, cached
  for at most 30s with the age shown, and `holderUnreachable` when the holder is
  unreachable.
- **E1, E2 and stop actions: proxied** to the holder by signed mesh command, with a
  tunnel fallback, independent of the caller machine's local money state.
- **`freezeRequested` flag and designation echo: unified** on the heartbeat surface.
  Freeze wins.
- **Designation record and committed figures: unified** (published on the heartbeat),
  used for conflict detection, positive confirmation and reclaim rebase. They are never
  a live gate input on the holder.
- **E3 positions: skipped off-holder.** No state.
- **Metered key: machine-local to the designated machine.**
  `machine-local-justification: physical-credential-locality` — a credential on one
  disk, deliberately not replicated.
- **Prices, model table, doorway entry, awareness: unified** (git-tracked or packaged).
- **`feature_metrics` rows: recorded on the holder,** where the call runs, and read
  through the existing proxied-on-read fan-out.
- **Reconciliation records: holder-local**, with the same justification as money
  authority, and read proxied-to-holder.
- **Single-machine agent:** trivially its own designated machine and trivially
  self-confirming. Drill (b) and forward proof (e) do not apply.

## Self-Heal Before Notify — watcher declaration

**(a) 100% of the month.** Information the operator asked for, not a degradation. One
notice per month (dedupe `spend-cap:gemini_api_key_payg:month:100:<monthEpoch>`).

**(b) Provisional ceiling.**

- `class: recoverable`.
- Self-heal: the breaker is already open, and the agent probes once with a countTokens
  call (free) after 30 minutes. Remediation is to let the breaker half-open. There are
  no money actions.
- `max-attempts: 1`, `backoff: 30m`.
- Dedupe `provisional:gemini-api:<monthEpoch>`.
- `max-notification-latency: 60m`.
- Flapping: a second ceiling crossing in the same month escalates as critical.
- `audit-location`: the money ledger plus `state/routing-spend-caps.log`, metadata only.

**(c) Invoice drift.**

- `class: recoverable`. Self-heal is one re-read after 6 hours (`max-attempts: 1`).
- `max-notification-latency: 24h`. Reporting only; the gate is independent.
- Dedupe `drift:gemini-api:<monthEpoch>`.
- `audit-location`: reconciliation records.

**(d) Conflicting designation.**

- `class: security`. Notify-and-heal on the same tick: the freeze has already happened.
- Dedupe `designation-conflict:<keyRef>:<epoch>`.

**(e) Holder unreachable.** Reuses the parent's surviving-voice alert and its declared
brakes, unchanged.

**(f) A session lowered a limit or disabled a caller.**

- Information with an audit link. One notice per action, coalesced per hour.
- No self-heal: the action was deliberate. The notice carries the restore plan.

## Alternatives considered

- **A new `gemini-payg` framework value.** Rejected. Frameworks are auto-selected through
  about a dozen paths, and each would need a "not this one" exception.
- **Google's spend limit alone.** Rejected. The subscriber-credits pilot spent $2.77
  against a $1 provider limit with three parallel calls. Google's limit stays as the
  second wall.
- **The parent's Increment D (multi-machine slicing).** Rejected. It is unnecessary with
  one spender, and much larger.
- **Letting an isolated holder keep spending** (round-1 draft). Rejected by review. It
  broke parent N-2 and made reclaim either impossible or a second spender.
- **Pattern-based prompt refusal.** Rejected under Rule 86. A key shape is not an
  unambiguous match.
- **Bearer-writable caps.** Rejected by the parent's invariant: raising money must not
  be possible with a token every session holds.

## Open questions

*(none — all resolved into Frontloaded Decisions)*

## Left behind

*(filled by convergence)*
