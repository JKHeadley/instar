---
title: "Gemini pay-per-use lane — a named, capped, metered Gemini API door (Neon + Hydrogen)"
slug: "gemini-payg-metered-lane"
author: "echo"
status: "approved"
approved: true
approved-by: "echo (build-decision owner session echo-topic-145625, topic 145625, 2026-11-20; agent approval under Rule 82 — not a constitution or protected-list change). Operator decision, verbatim (Justin, 2026-11-20 13:26 PST, topic 145625): 'please proceed with the path that is the most cost-effective for us that you have recommended and let's set a $50 cap for now and integrate Gemini with our other options for models, including Gemini neon and Gemini hydrogen'. Money release stays the operator's separate PIN commit (§8)."
constitution-check: "POST /spec/conformance-check, run in 6 heading-split parts (<21k chars each, 102 standards per part), 2026-11-20T22:34:52Z–22:36:31Z: 10/10/13/7/10/6 possible-violation flags, 0 judged real conflicts. Families: Rule 4/86 ruled money+secrets exceptions read as matcher authority; Judgment-Within-Floors on operator-approved governed numbers; already-stated honest limits (shared bearer, readable PIN FD-G22). Build folds: attribution pointer in plan text; FD-G27 reader inventory for openrouter/groq bench keys before the secret-get refusal."
parent-spec: "docs/specs/routing-control-room-spend-alerts.md"
parent-principle: "Token-Audit Completeness — An Unmetered LLM Call Is an Unaccountable One"
eli16-overview: "docs/specs/gemini-payg-metered-lane.eli16.md"
review-convergence: "2026-11-20T22:30:28.566Z"
review-iterations: 6
review-completed-at: "2026-11-20T22:30:28.566Z"
review-report: "docs/specs/reports/gemini-payg-metered-lane-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 26
cheap-to-change-tags: 0
contested-then-cleared: 0
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
- **HTTP timeouts are derived, not guessed.** A post-send timeout costs money (a
  provisional charge, §5), so the timeout must outlast a healthy call.
  - Formula: `timeout = 30s + reservedOutputTokens ÷ throughputFloor`.
  - `throughputFloor` defaults to 40 tokens/s until the Run 2 proof measures each model.
    After that, it is half the measured median rate, recorded on the door's policy
    record (§5).
  - Outer bound: 900s.
  - countTokens (metadata only, no money at risk): 15s.
  - The poll deadline (§6) and the restart drain (§5) are derived from the same value,
    never set separately.
- A client disconnect does **not** abort the upstream call. The call completes and
  settles at its actual cost. Aborting would make the bill uncertain for no saving.
- A response whose `finishReason` is anything other than `STOP` (for example
  `MAX_TOKENS`) is marked `incomplete`. A truncated review never folds in as a clean
  "no findings".
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
is a registry entry in `dist/core/crossModelReviewer.js`, so the script itself does not
change. It is a thin HTTP client of the **local** server:

- It calls `POST /intelligence/gemini/review` on localhost with the agent token, plus
  `{specPath, specSha256, round}`.
- That route stamps `caller: spec-review` server-side and admits through the chokepoint,
  or forwards it (§6).
- So the ledger has one writer, and the key has one reader.

**Guarding the E1 route** (so it cannot be used to get around E2's limits):

- **Ingress:** the same rule as E2 (below).
- **Session:** server-resolved, as for E2.
- **The spec must be real:**
  - `specPath` must resolve inside a `docs/specs/` directory of a git checkout.
  - `specSha256` must match the file's current contents.
  - **One pass per `(specSha256, round)`** (`e1PassesPerRound`, default 1, a door
    policy field shown in the plan). A legitimate new round has a new round number; a
    runaway loop repeats the same key. The money caps remain the floor.
  - **The slot is reserved under the reservation lock**, alongside the dollars:
    - released on a confirmed no-charge rejection;
    - kept on an uncertain (provisional) outcome;
    - a resubmitted `callId` reuses its slot.
  - **Exceeded:** refuse `e1-pass-limit` (429, `resetsAt` = never for that key). The
    round records the Gemini family as `unavailable: e1-pass-limit`, with no step-down
    and no `gemini-cli` fallback.
  - **Payload assembled at the origin.** The originating server reads the validated spec
    file and its listed context docs, builds the review payload once, and puts its
    digest in the forwarded request. The holder sends exactly that payload, so divergent
    checkouts cannot change what is reviewed.
  - `realpath(specPath)` must lie under the agent home, or under
    `CartographerRootRegistry.resolve(topicId).root.report.canonicalPath` when that
    returns `ok:true`. With `ok:false`, or when the registry is not built because
    `cartographer.enabled` is off, only the agent home qualifies.
    - The agent's `.dev/wt-*` worktrees qualify because they are under the agent home.
      A test uses that path shape.
    - The context docs must be ones the spec lists, under the same root. Their digest is
      part of the bound payload.
  - The script sends an idempotency key `(specSha256, round, run)`. The server saves the
    `callId` nonce under that key before forwarding, so a restart or timeout never mints
    a second call.
- **Run id:** each row records `run: <specPath>@<sha8>#<round>`, so the per-caller
  breakdown shows any misuse.
- **Honest limit:** every session on this agent holds the same token and could
  impersonate a review run. This route bounds a runaway; it is not a defence against a
  malicious session, which could equally read the vault (§4.2).

**Reviewer family accounting.** Registry entries gain a new field, `familyKey`.
`gemini-api` and `gemini-cli` share `familyKey: gemini`, so family diversity counts
Gemini once.

- On this agent, the review policy **excludes `gemini-cli` entirely** (its sign-in may be
  a personal Google account, and personal AI Pro stays out).
- So Gemini review means `gemini-api` only. If the API is unavailable, the round records
  Gemini `unavailable`, never a CLI fallback. A test covers an API outage with a CLI
  signed in.
- `crossModelReviewer` gets an explicit trusted-door entry `gemini-api`, justified by
  the code-constant first-party host. It is not added to the CLI framework list.

**Guarding E2 (the Bearer route).**

- **`purpose` is required.**
- **Caller session** comes from the server's own session record. The route resolves the
  authenticated origin (the `X-Instar-Session` header checked against the live session
  registry). An unverifiable name is recorded as `self-reported:<name>`.
- **Accepted only from loopback, or from a signed mesh forward.**
  - Cloudflared and funnel connect from loopback too, so the check uses the existing
    forwarded-header helpers: `hasForwardingHeaders` + `isLoopbackPeer` (as in
    `mobileBrowserDevices.ts` and `documentLinkRoutes.ts`).
  - A request carrying forwarding headers is refused 403.
- **No concurrency cap.** Reservations already bound the money: the shares, the per-call
  ceiling and the gate. A third fully reserved call costs nothing extra in risk, so a
  count limit would be a cap with no consequence behind it.
- **E2 share, proposed default:** E2 may commit at most **40% of the month ($20)** and
  **$4 a day**. These are fields on the door policy (§5), counted on the holder,
  presented in the plan text as a suggestion the operator can change.
  - Basis: the approved report says Neon "would then be reserved … for the jobs where it
    earns its place, such as the third voice in a cross-model review". Keeping $30 for
    reviews follows that recommendation.

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

**Smoke test, 2026-11-20 14:16 PST** (account lane; record at
`.instar/state/gemini-payg-setup-2026-11-20.json` on the Mama PC):

- **Ids confirmed:** `models/gemini-4-neon` and `models/gemini-4-hydrogen` both answered.
- **Prices read on Google's AI Studio pricing page** (undated): Neon $3/$15 and Hydrogen
  $1.50/$7.50 per million tokens, thinking billed as output, Batch/Flex at half price.
- **Usage sample:** Neon 34 in / 5 out / 57 thinking; Hydrogen 34 in / 5 out / 23
  thinking. Thinking is a large share of short calls, which the reserve formula
  already covers.
- **Long-context tier: not reported.** Release check (d) therefore still has to read the
  tier on the page. Until it does, nothing above the verified range is admitted.

**Tiers in the manifest schema.**

- Each price point gains `maxInputTokens`: the largest request input that this point's
  rate covers.
- A request whose counted input exceeds the highest **verified** tier for that model is
  refused with `outside-verified-tier`. That refusal is a scope limit, not a guess.
- If Google publishes a long-context rate (for example, above 200k tokens), it lands as
  a second point.
- **No assumed coverage.** A model with no verified point and range is refused
  (`outside-verified-tier` or `unknown-price`). There is no assumed 200,000-token
  coverage. The single release-proof call, which uses a fixed tiny input, is the only
  call ever priced from an unverified point, at `conservativeMax`.

**Verification.**

- Each point carries `verified: boolean`. `routingPriceAuthority.resolve` treats
  `verified: false` exactly like stale: `priceStale = true`, so the gate books at
  `conservativeMax`. Today the code only checks staleness; this field is a new code
  carrier and gets a test.
- `conservativeMax` is `{ in: 6.00, out: 30.00 }`, twice Neon's list price.
- Because the release gate requires verified prices (§8 (d)), unverified prices are only
  ever used for the single release-proof call.

**Stale points.** For this door, once a point is past its 45-day freshness window it
refuses (`stale-price-fail-closed`) rather than booking at a multiple. A multiple of an
unverified price is not a provider ceiling. Run 2's price read, repeated by the monthly
reconciliation job, refreshes the points.

**Manifest metadata.** Points use the 45-day freshness convention (`freshnessSlaDays: 45`,
`staleMode: fail-closed` for this door). Points land by reviewed git commit, the sanctioned
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
`METERED_SECRET_NAMES`, in `src/core/meteredSecrets.ts`, is the single list every
protection below reads. It holds `gemini_api_key_payg` plus **every existing `metered_*`
vault name**.

**Existing keys.** A names-only read on 2026-11-20 found `metered_gemini_bench`,
`metered_openrouter_bench` and `metered_groq_bench` already in the Mama PC vault, synced
there and printable by any session today. They are probably the paid key behind the
15 November Hydrogen probe.

- They get the same protections: no `secret-get`, and no sync except to a designated
  machine. With no designation, they sync nowhere.
- The account lane was asked (2026-11-20) which Google project owns
  `metered_gemini_bench`. If it is the new key's project, it is revoked once the new key
  works. If it belongs to a personal account, it is revoked regardless (personal Google
  stays out).

**Key binding.** The `gemini-api` door's keyRef **is** the vault name
`gemini_api_key_payg`. It replaces `metered_gemini_bench` in `METERED_ROUTING_DOORS`,
in `DEFAULT_METERED_CAPS` (in the monthly shape, §5) and in `knownKeyRefs`.
`metered_gemini_bench` has no **code** reader, so it is removed as a keyRef. Its vault
entry is handled as described above.

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
     `designatedMachineId`.
   - With no designation yet, or while a transfer proposal exists (until its commit
     changes the designation), they are dropped for **all** recipients.
   - **Receive side:** `SecretShareHandler` strips and counts any metered name arriving
     at a machine that is not designated. The source of truth is the designation it last
     received by `designation-echo` (§6). Unknown means strip.
   - Tests cover each branch.
7. **Prompts never carry live secrets.** The full immutable request (system instruction
   plus contents) is compared against the **exact values** of the vault and the
   credential environment:
   - **at the origin**, before forwarding; the digest binds those exact bytes;
   - **again at the holder**, against its own values, before either Google request.
   - An exact match refuses with `prompt-contains-live-secret`, which is the ruled
     secrets exception.
   - Key-shaped pattern matches (an example `AIza…` in a spec) are only a recorded
     signal. They do not block, because a shape is not an unambiguous match.
8. **Never in logs.** The transport strips the header from any rethrown error. A unit
   test asserts an error's message, cause and stack never contain the key.

**The production key is minted at go-live, never before.** Pre-ship holding places do
not work. Secret Drop entries expire in about 15 minutes and live only in memory, and
today's vault sync copies the whole vault to every online peer.

- **A key created before ship is for the smoke test only.** It runs through the no-echo
  pipe straight from the drop, and it is never stored in any vault.
- **The production key is minted in Run 1's mint phase, after the build is running on
  every machine and before the card is rendered.** "Running" means the per-recipient
  sync filter and the `secret-get` refusal are in place.
  - **A dedicated Google project.** The account lane creates a project used only for
    this lane. That makes "revoke any other key" safe, and makes Google's project-level
    spend limit meaningful.
  - **Console to drop, without echo.** A script inside the AI Studio page copies the new
    key from the creation dialog into the Secret Drop form. It also computes the key's
    SHA-256 fingerprint in the page. The browser tool returns only ok or failed, plus
    the fingerprint, never the value.
    - **If the script fails** (for example a page security policy blocks it): the
      dialog is **never** read or screenshotted instead. The key is treated as in doubt
      and revoked at once, and minting is retried, up to 3 times. After that, Run 1
      ends at `awaiting-key` with the blocker named.
  - **Where it runs.** The Secret Drop, the retrieve and the handoff POST all happen on
    the designated machine (the Studio, or the new machine in a transfer). Drops live in
    one server's memory, and the vault write and the POST are local. A browser on
    another machine may only fill that machine's drop form, through its tunnel.
  - The account lane then stores the key on the designated machine by the no-echo
    transfer:
    `secret-drop-retrieve.mjs <token> <field> --run -- secret-set.mjs gemini_api_key_payg`.
    The value goes into the vault write on stdin and is never printed to a session.
  - **The handoff contract.** The account lane writes one file on the designated
    machine, `state/gemini-payg-key-handoff.json`, through
    `POST /routing-spend/key-handoff` (Bearer, loopback only):

    ```
    { noEchoTransfer: {attestedBy, at, method, sourceMessageRef},
      oneKeyArtifact: {providerKeyId, keyFingerprint, readAt, screenshotPath,
                       screenshotSha256},
      googleSpendLimit: {kind: "hard-cap" | "budget-alert-only", amountUsd, readAt,
                         screenshotPath, screenshotSha256},
      boundTo: {designationEpoch} }
    ```

    Render reads only this file. The route works while money is off, because the mint
    happens before go-live.
    - **Google's own limit, evidenced.** `googleSpendLimit` records which control
      Google actually applies to the dedicated project and its amount (at most $50).
      Instar's booked-spend cap is the authority. Google's control is the second wall,
      and the plan text names which kind it is. If Google offers only budget alerts, the
      text says so plainly: "Google will warn but not stop at $50; Instar's own cap is
      what stops spending." A missing record means `awaiting-key`.
    - **Validation.** A malformed body is refused with 400. At render:
      - the stored screenshot's hash must match;
      - `readAt` must be later than the mint start the **server** recorded when the
        mint phase began (never a value from the file itself);
      - `boundTo.designationEpoch` must be current;
      - `keyFingerprint` must equal the SHA-256 of the stored key, computed inside
        `withKey`.

      A malformed, stale or mismatched file means `awaiting-key`.
    - **Lifecycle.** The file is archived when the commit succeeds, and whenever a
      freeze or revoke happens, so an old attestation can never vouch for a new key.
    - **Waiting.** The agent arms a watcher on the file and holds an open commitment. It
      re-briefs the account lane by session-to-session message, never a Telegram post,
      with backoff: 2h, then 4h, then 8h, during waking hours only.
  - **At 24 hours with nothing**, Run 1 reports `awaiting-key` with the blocker named,
    and no card is sent. 24 hours is a report checkpoint, not a stop: the watcher and
    commitment stay open, and a late handoff resumes at render automatically.
  - **A holder-side check.** At render, the stored key's exact value is checked against
    **every** transcript the account-lane run produced: its sessions, subagents, and the
    browser tool's output directory. This is an exact-value scan, the ruled secrets
    exception.
    - A hit means re-mint.
    - A transcript that is missing, partial or unreachable **refuses render** as a named
      blocker. It never counts as "no hit".
  - Briefs went to `echo-topic-145625` on 2026-11-20 (13:46, 13:55, 14:05, 14:16 PST).
    The last states this rule.
- **One key per project: the go-live fence.** Google projects can hold many live API
  keys. So go-live (and any transfer) requires a browser-read artifact of the project's
  key list showing **exactly one** key with Generative Language API access. It must be
  the new key, identified by its `providerKeyId` and fingerprint (`keyGeneration`, below).
  - **`keyGeneration` is checked against the real key.** `keyGeneration` is the key's
    SHA-256 fingerprint, recorded at mint, alongside Google's `providerKeyId`. The key
    reader computes the stored value's fingerprint inside `withKey` (never logged) and
    compares it. A fingerprint names one exact key, so it cannot collide the way a
    suffix can.
  - Transfers are ordered by `designationEpoch`. The fingerprint identifies the key; it
    does not order generations.
  - A mismatch makes the provider refuse (`key-generation-mismatch`, fail closed). So a
    wrong key in the vault can never spend under the fence.
  - Any other key, including an old smoke-test key or `metered_gemini_bench` if it is in
    the same project, is revoked first.
  - Revoking it is a precondition, not a follow-up.

**Go-live precondition (render time, §8).**

- The key was minted **after** the per-recipient filter went live on the designated
  machine, so it was never sendable to any peer. An offline peer is therefore cleared by
  construction. No send record is needed, and none exists (`provisionAll` logs only a
  count).
- `secret-names` on every **online** peer confirms the key is absent there (names only).
- The one-key artifact above is present.
- **If the key turns up anywhere else** (a copy outside the vault, a value in doubt): the
  agent revokes it and mints a fresh key (FD-G23). There is no purge path.
- **Honest limit:** a names-only check cannot see a copy outside the vault. Minting after
  the filter, the no-echo transfer, and the one-key read together are the protection.

### 5. The in-Instar $50/month cap (extends the money layer)

**Where the governed values live.** Every limit below is a field in the PIN-only caps
store, so Rule 4's "recorded governed state" is backed by a real record.
`RoutingSpendCapsStore` gains a per-door record:

```
MeteredDoorPolicy {
  perCallCeilingUsd, provisionalCeilingUsd, e2MonthSharePct, e2DayCapUsd,
  e1PassesPerRound, keyGeneration,
  meteredCallers: { callers: CallerId[], e3Components: string[] },
  throughputFloorTps: { [modelId]: number }, releaseState, designationEpoch
}
```

- These fields travel in the go-live intent struct, the apply step, the plan text and
  the lower route.
- `throughputFloorTps` is the only field the agent writes without the PIN, and only from
  a measured Run 2 proof. Raising it shortens timeouts; it releases no money.

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
- **Charged period on every row.** Each reserve row stores its charged `dayEpoch` and
  `monthEpoch` at admission. Settle and expiry rows inherit them. A later zone change
  applies only to new reservations, so it can never move an existing commitment out of a
  period.
- **Period zone.** For `gemini_api_key_payg`, the day and month are both in
  `America/Los_Angeles`, because Google's billing month and the operator's day are
  Pacific. The zone is a per-key value in the PIN record, defaulting to UTC for every
  other key so existing behaviour is unchanged.
  - **The zone is fixed once the door goes live.** Changing it would let a reservation
    near midnight on a month's last day land in a fresh month. It can change only
    through a new go-live, and only applied at a boundary where both calendars have
    closed the charged period.
  - Each row stores its charged period, which is never recomputed.

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
   - If countTokens fails, the call is refused with `token-count-unavailable` before
     dispatch. There is no estimated fallback: an under-estimate near a tier boundary
     could pick the cheaper rate for the whole request.
4. **Select the price point** by input range first:
   - Choose the point whose `maxInputTokens` range contains the counted input, then
     resolve corrections within that tier.
   - The selected price-point id is stored on the reservation, and settle uses that same
     point. The reporting rollup uses it too.
   - No covering verified tier: refuse `outside-verified-tier`.
5. **Reserve, revalidating under the lock.** Inside the per-key critical section:
   - Policy is **re-read**: caller membership, E3 components, freeze, release state and
     shares. A caller disabled during the token count is refused here.
   - Then the `callId` dedupe, the per-call ceiling, the shares and the gate.
   - Then the reserve row is appended:
     `input × inRate + (maxOutputTokens + thinkingBudget) × outRate`. Cached tokens are
     booked as full input (parent FD-19).
6. **Order of steps.** The dedupe lookup is **step 0**, before preflight and before the
   policy re-read in step 5:
   - An authenticated `callId` resubmission, with a matching `resultToken` and digest,
     returns the existing call's state. It is never refused by a cap, a freeze or a
     disabled caller, because the call was already admitted and paid for.
   - Otherwise, preflight refuses at once when committed spend already meets the month,
     day or share limit. Exhausted callers never pay for a token count. On a forwarded
     call, the body is already sent; the refusal saves the holder's work only.

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

- **Provisional ceiling:** checked under the reservation lock as
  `provisional + outstanding reserves + this reserve ≤ $10`, so a burst of concurrent
  calls cannot all turn provisional past the limit. Otherwise admission refuses
  `provisional-ceiling`. It means something is wrong upstream, and
  stopping is cheaper than continuing.
  - **Recovery is the operator's**, because provisional amounts are sunk and reopening
    releases money. The trip raises one Work Board card with a prefilled
    `caps-adjust` plan to reset or raise the ceiling, committed by PIN.
  - If the reconciliation read (§7) shows Google billed less, the card says so with the
    figure. The read itself never moves the gate.
  - Otherwise the lane reopens at the next month boundary.
- **Restart drain:** the agent's own restart path:
  1. stops admitting new metered calls and forwarded submits;
  2. waits for in-flight calls (`settlingCount`) up to the largest remaining derived
     timeout (outer bound 900s);
  3. then restarts.
- **`AdmitRequest.maxOutputTokens`** carries output plus thinking, because the gate
  prices that field alone.
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
- `e1-pass-limit`
- `key-generation-mismatch`
- `request-too-large`: a request body over 1.5 MB, refused before forwarding. That
  stays under the peer route's 2 MB parse limit (`PEER_BODY_LIMIT_BYTES`), so envelope
  overhead can never turn it into a raw 413.
- `callid-conflict`
- `e2-share-exceeded`
- `reserves-outstanding`: returned when committed spend plus reserve breaches the cap
  but settled spend plus this reserve would not, so the caller should retry shortly.

Caller-side postures (not gate reasons) are `holder-unreachable`, `peer-version` and
`lease-liveness-unconfirmed` (passed through).

**Every reason maps to its own HTTP status and plain message, and survives forwarding
unchanged.**

| Reasons | Status |
|---|---|
| `cap-exceeded`, `e2-share-exceeded`, `per-call-ceiling`, `provisional-ceiling` | 402, with `period: day\|month\|call\|provisional`, `settledUsd`, `outstandingUsd`, `capUsd`, `resetsAt` |
| `outside-verified-tier`, `unknown-price`, `request-too-large` | 422 |
| `reserves-outstanding` | 409 with `retryAfterSec` |
| `frozen`, `not-live`, `armed-pending-proof` | 423 |
| `not-allowlisted` | 403 |
| `callid-conflict` | 409 |
| `peer-version`, `key-generation-mismatch` | 503 |
| `e1-pass-limit` | 429 |
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
  state. The plan names it.
- Every other machine refuses locally with `no-cap-slice`.

**New signed mesh verbs.** They are added to the `MeshRpc` registry with a version
floor, alongside the existing mutating peer verbs (`commitment-mutate`,
`email-send-forward`). RBAC means a registered peer plus `verifyEnvelope`, and the
following verb-specific rules:

| Verb | Direction | Rule |
|---|---|---|
| `metered-gemini-call` | any peer to the holder | The `op` field is one of `spec-review`, `second-opinion` or `release-proof-forward`, set by the originating server route, never by the request body. The verb carries the originating machine, the server-resolved session, `callId` and `requestSha256`. |
| `metered-gemini-result` | the originating machine to the holder | Poll by `callId` **plus `resultToken`**: an unguessable 256-bit capability **generated at the origin before sending**. The origin persists it with the idempotency record and hands it only to its caller. The submit carries only its hash, which the holder binds to the reservation. A lost acknowledgment or an origin restart therefore still recovers the paid result with one charge. Without the token, the result is `not-yours`. This holds between two sessions sharing the same bearer token, because session names are not proof of ownership. |
| `metered-stop-action` | any peer to the holder | Freeze, lower, disable or share-lower. Only ever reduces money. |
| `designation-echo` | the holder to any peer | Lease confirmation (below). Read-class. |
| `secret-names` | the holder to any peer | Returns vault key **names** only, never values. Read-class. |

**Transport.** Each verb tries the mesh rope first. If that fails, it uses the holder's
authenticated tunnel, carrying the **same signed envelope** to the mesh-command endpoint.
That endpoint is separate from the E2 route, so the E2 route's forwarded-header refusal
does not apply to it. The route that last worked is kept for the next call.

Agent memory records the Mama PC→Studio rope at "machine unreachable" while the tunnel
worked, which is why the fallback exists.

**Forwarding E1 and E2 from other machines.**

- **Independent of local money state.** On a non-designated machine, E1 and E2 forward
  whether or not that machine's money layer is on. Forwarding needs only the published
  designation. `GET /routing-spend/caps` proxies the same way.
- **Submit, then poll, durable and idempotent.**
  1. The caller computes `callId = sha256(originMachine, session, requestSha256, nonce)`.
     A retry of the **same** request reuses the same `callId`. The local route returns
     the `callId` on any timeout, so the script resumes polling instead of resubmitting.
  2. The holder writes `callId` and `requestSha256` onto the ledger **reserve row**, so
     deduplication survives a holder restart, since it is folded from the ledger.
     - A resubmitted `callId` returns the existing call's state. It never makes a second
       reservation.
     - The same `callId` with a different `requestSha256` refuses `callid-conflict`, so
       one session can never receive another's result.
  3. The holder keeps results for 30 minutes, under a 64 MB in-memory cap with the
     oldest evicted first. After eviction, or across a holder restart, a poll returns the
     terminal state `settled-result-lost`, with the booked cost. It **never re-dispatches**.
  4. Polling backs off from 2s to 10s. The poll deadline is the call's derived timeout
     (§1) plus 60s. Past the deadline, the caller records `holder-timeout` with the
     `callId`, and a later poll can still collect the result.
- **Request limit:** 1.5 MB (`request-too-large`, refused before forwarding).
- **Failure states:**
  - **Old peers.** MeshRpc has no version floor today. An old peer answers an unknown
    verb with 403 `claim-unauthorized`, and for these verbs the caller maps that to
    `peer-version`.
  - **Unreachable holder:** `holder-unreachable`.
  - Nothing ever falls back to a local spend.
- **E3 is never forwarded.** Off the holder its positions are skipped (`no-cap-slice`,
  so the chain advances).

**Stop actions reach the spender.**

- Freeze, `caps/lower`, `callers/disable` and share-lowering issued on any machine go to
  the holder by `metered-stop-action`. The agent says "stopped" only after the holder
  confirms the write.
- **If the holder is unreachable:**
  - The issuing machine publishes
    `freezeRequested: { requestId, keyRef, designationEpoch }` on its `session-status`
    advert.
  - Freeze wins. The holder applies any freeze request it has not seen, acknowledges it
    in its advert, and the issuer clears its flag.
  - A PIN unfreeze consumes every request outstanding at that moment, so a lingering
    flag cannot undo it.
  - Repeated new requests from one issuer within an hour are coalesced into one notice.
  - The agent tells the operator plainly: "stop requested; the spending machine has not
    confirmed yet".

**Lease liveness** (replacing the `poolOn ? null` stub, and inheriting parent N-2).

- **Active, fresh echo.**
  - Every 10s, the holder sends `designation-echo { keyRef, designationEpoch, nonce }` to
    each peer. The nonce is fresh each time.
  - A peer answers with a signed echo of that nonce, plus any designation it has seen for
    the keyRef.
  - A confirmation counts only when an echo of a nonce issued **in the current window**
    arrives back, timed by the holder's own clock on receipt. Peer timestamps and
    git-synced registry copies never count.
  - `leaseConfirmedAgoMs` is the age of the last such confirmation.
- **The window.** The gate keeps `LEASE_LIVENESS_WINDOW_MS = 60s`, which is six echo
  rounds.
  - Backoff while failing is capped at 20s, a third of the window. At most one echo is
    in flight per peer, with an RPC timeout of 8s.
  - `failoverThresholdMs` is configurable (`failoverTimeoutMinutes`, default 15). The
    isolated holder's worst-case fence time is about 88s: the 60s window, plus the 20s
    backoff, plus the 8s RPC timeout.
    - A boot check (re-run when that config changes) refuses to arm when the threshold
      is under twice that, 176s, and raises one notice.
    - The margin covers clock jitter. Key rotation remains the real fence.
- **Either direction.** The echo is offered both ways, so a rope that is down in one
  direction does not fence a healthy holder. The holder pushes nonces to peers, and each
  peer also pulls a fresh nonce from the holder over the holder's tunnel and posts back
  its signed echo. Either way, the holder issues the nonce and times the receipt on its
  own clock.
- **One responsive peer is enough**, by design. Confirmation means "this machine is not
  isolated"; a dual spender is prevented by key rotation, not by a quorum.
  - An isolated holder fences itself to $0 within 60s, long before any lane transfer can be
    offered.
- **What does not reset confirmation.** `caps/lower` bumps the gate's `leaseEpoch` (slice
  fencing). It does **not** bump `designationEpoch`, so lowering never interrupts
  confirmation.
- **Unknown fences.** If no peer can be reached, or the echo cannot be evaluated, the
  result is `unknown`, and unknown fences.
- **Single-machine agent.** No peers are registered, so it trivially self-confirms.
- **Designation conflicts** count only claims naming a **different** machine whose key
  is backed by a recorded one-key artifact.
  - A backed claim with a newer `designationEpoch` means the holder **freezes itself**
    and notifies (security class). The fingerprint identifies the key; the epoch orders
    the claims.
  - An older or unbacked claim is only a quiet "stale entry" signal.
  - Every healthy peer echoes the holder's own designation, and that is never a
    conflict.
- **Transfer figures.** The committed figures for a lane transfer ride the existing
  `session-status` capacity advert (`PeerPresencePuller`, 30s, receive-clamped):

  ```
  { monthEpoch, committedMonthUsd, committedDayUsd, outstandingReserveUsd,
    provisionalMonthUsd, e2MonthUsd }
  ```

  They are observability inputs to a lane transfer only, never a live gate input.

**Holder death and moving the lane.** In v1, spending is pinned to the designated
machine. If it dies, the lane is unavailable (`holder-unreachable`). Moving the lane is
a **fresh go-live** on the new machine, using the same `gemini-payg-setup` plan with a
`transfer` block:

- **Eligibility.** Only after the old holder's mesh death, and refused while the
  alive-but-partitioned signal is present (parent N-2).
- **Where it renders.** On the proposed new machine, named in the block. It never
  renders on the dead holder.
- **What it requires.** A newly minted key on the new machine, plus the one-key artifact
  (§4). The old key is revoked, and its `keyGeneration` is superseded.
- **What serializes transfers.** One account lane mints keys, and each transfer needs its
  own operator PIN commit. With the one-key read, at most one machine can hold a working
  key.
- **The month restarts as exhausted.** The new machine's month, day and E2 share start
  exhausted, because the old holder's spend after its last published figures is
  unknown.
  - The new holder records this as an idempotent `transfer-adjustment` row in its own
    ledger. Its cost equals the remaining monthly headroom, so the month reads full. It is
    bound to the intent hash and the charged day and month.
  - A full rebuild from rows therefore keeps the month closed. It never relies on a
    totals file. The plan shows the last advert, its age, and outstanding reserves as
  information only. Headroom reopens only at the month reset or by a PIN restore.
- **Fresh governed state.** The full setup struct is applied, and the proof call is
  repeated, bound to the new intent hash.
- **No proof allowance.** The transfer month stays exhausted, the proof call included.
  An advert's age has no proven bound, so no computed figure safely reopens headroom.
  - The transfer completes at the month reset, or when the operator restores headroom
    by PIN. The plan shows the last advert, its age, and outstanding reserves as
    information only.
  - Nothing is ever admitted past the cap.
- **No auto-grab.** "Every registered machine answered" excludes the dead holder, by
  design.

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

- Booking rows gain `component`, `caller`, `run` (E1), `callId`, `requestSha256` and
  `tier` fields.
- The parent's daily reporting rollup gains a `tier` dimension, so two days with equal
  token totals but different request sizes keep their different costs after raw rows
  are pruned.
- The ledger is retained, not pruned, so the month breakdown by caller is exact.
- The 30-day pruning of `feature_metrics` and its UTC-day rollup cannot distort it.
- **Provider usage capture (parent FD-21).** After the settle row is durable, the
  holder appends Gemini's `usageMetadata` as a `provider_cost_report` record under the
  same `reserveId`. If that reporting write fails, the booking stays intact, and the
  failure is logged and counted.
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
   with the local mesh fixture. All tiers green, plus the holder-death drill, plus the
   user-role setup-flow PASS.
2. **Development agent: Echo.** Live after the PIN and the release gate.
3. **Fleet: dark.** Echo reviews on **2026-12-21**, a commitment opened at merge. The
   evidence to graduate:
   - one month booked, with invoice drift under 10%;
   - zero conflicting-designation events;
   - forward success rate at least 95%;
   - no `settled-result-lost` that was billed twice.

   Missing evidence means it stays dark, and the review records why.

**Fleet defaults.**

- `routingSpend.money.enabled` stays off fleet-wide (`DARK_GATE_EXCLUSIONS`,
  action-bearing).
- No config default is added.
- With money off and no designation published, E1 reports
  `unavailable: money-layer-off`, and E2 returns 503.

**Go-live: one PIN entry, by a new pre-gate action.** Today the money layer is built
only at boot. The enable surface's closed pre-gate list (`MONEY_LAYER_PREGATE_ACTIONS`)
lets a PIN commit flip only the enable flag while money is off, and its restart is
separately PIN-gated (`acceptRestart` → `checkPin`). So the build changes three things:

1. **A new pre-gate action, `gemini-payg-setup`, added to `MONEY_LAYER_PREGATE_ACTIONS`.**
   - **What it writes:** the enable flag plus one **pending-setup intent** file,
     `state/money-pending-setup.json`, holding the setup struct and its hash.
   - **What it never writes:** the caps store, while money is off.
   - This keeps the enable surface's invariant: no caps write while money is off. The
     caps are written by the money-layer constructor, under money on. The amendment to
     that spec's action list is made explicitly in the same PR.
2. **Render.** `renderPlan('gemini-payg-setup')` runs on the designated machine. A
   request from another machine is forwarded there.
   - The proposed setup struct is **persisted** with its hash, at
     `state/money-proposed-setup.json`.
   - Because rendered plans live in memory for only 10 minutes, the card's page renders
     a **fresh** plan from the persisted struct each time it is opened, re-running the
     preconditions.
   - The commit binds to the struct's hash, so a late tap, or a tap after a Studio
     restart, still works.
   - The card stores the hash it was created with. If the persisted file's hash
     differs, render and commit refuse with "the proposal changed; a new card is
     needed". A tap never commits a struct the operator did not see.
   - The plan text is generated from the exact struct, one line per field.
   **Render-time preconditions:**
   - **(i) The key is only on the designated machine.** It was minted after the filter
     went live, `secret-names` is clean on every online peer, and the one-key artifact
     is present (§4).
   - **(ii) No conflicting designation.**
   - **(iii) The no-echo transfer was attested** (the `noEchoTransfer` field). If not,
     the agent mints again.
3. **Commit, then restart, under that one PIN.** `POST /routing-spend/money-layer/commit`
   with the PIN writes the flag and the intent through the parent's write discipline.
   - **Restart required:** on success, the commit route itself schedules the supervised
     restart through the **same safeguards** as the existing restart route:
     - the three-state eligibility check;
     - the cooldown;
     - the audit row flushed before the supervisor handoff.

     If a safeguard refuses, nothing restarts, and the server says why and when it will
     retry.
   - The plan text carries the restart disclosure the existing route shows ("this
     restarts the whole agent server; sessions on this machine are interrupted"). The PIN
     therefore approves the restart knowingly, and the dashboard asks for no second PIN
     for this action.
   - The amendment to the enable-surface spec covers this restart binding as well as the
     action list.
   - **No restart needed:** if money is already `enforcing` on the Studio, the intent is
     applied immediately by the running caps store.
4. **Apply.** At boot (or immediately, if money is on), the constructor applies the
   intent in one locked write before serving:
   - caps
   - `GoLiveRecord` with `releaseState: armed-pending-proof`
   - the `MeteredDoorPolicy`
   - the zone

   It deletes the intent only after that write has been fsync'd. Applying is idempotent
   by intent hash, and it also checks the hash against the commit's audit row. **If
   applying fails** (validation or disk), the server boots with this door frozen, raises
   one notice, and never crash-loops.

**The plan text lists every committed field in plain words:**

- the money layer on for this machine
- $50 per month (Justin's figure); and, **proposed by the agent** and changeable before
  approving: $10 per day (Pacific calendar), $2.50 per call, and a $10 limit on
  uncertain charges
- the designated machine (the Studio)
- callers:
  - reviews by Neon;
  - second opinions by Hydrogen, or Neon on request, from **any of my sessions**,
    limited to $20 a month and $4 a day (proposed: change it before approving if you
    want);
  - background checks: none;
  - model-checking tool: off
- step-down from Neon to Hydrogen when Neon would not fit
- the two models, with "prices unverified until checked on Google's page"
- that Justin's personal Google account is not used
- that conversations cannot run on Gemini in this version. This line goes on the
  card's **first screen**, in plain words: "Gemini joins as a reviewer and a second
  opinion. Choosing it as a conversation's engine is not in this version." 
- that the agent can stop or reduce spending at any time without asking, but cannot
  raise any limit or add a caller without him

**Delivery.**

- One Work Board card with an Approve control, linking to the **Studio's** Spend-tab
  plan view.
- Before sending, the agent loads that page at 390x844 and 1280x728 and reads the first
  screen.

**The run boundary.**

- **Run 1**, in order:
  1. build, then ship to every machine;
  2. the user-role live test of the whole setup flow on the throwaway pair: card, plan
     page, PIN commit, automatic restart, intent applied, `armed-pending-proof`. A
     signed PASS is needed before Justin is asked;
  3. the mint phase and the handoff file;
  4. render, load the page at both viewport sizes, send the card.

  Run 1 ends at the card, or at `awaiting-key`. A watcher is armed on the commit.
- **Run 2** starts at the commit. It covers apply, `enforcementReady`, the release gate,
  live proof and the completion report.
  - The report says what "integrated with our other options" means in v1: listed with
    the other models and callable for reviews and second opinions, not usable as a
    conversation's engine.
  - It also says how to ask for that.

**Release gate (parent FD-11, now in code).**

- `releaseState` in the door policy is `armed-pending-proof` until the internal proof
  recorder sets `live`.
- **One proof reservation at a time.** It is one durable proof reservation bound to the applied
  intent hash, with a fixed short input.
  - A repeat submission returns the recorded outcome and never makes a second paid call.
  - A confirmed no-charge refusal releases the slot for a retry.
  - An uncertain outcome keeps its booked charge. The agent may make up to 2 further
    proof attempts. Each is a new booked reservation that must pass the full gate,
    including every cap. After that, the
    door stays `armed-pending-proof` with the blocker named.
  - Its thinking budget is the model's minimum.
- The recorder is the **only** code path that can set the proof marker:
  - The marker is refused as request input.
  - On a forwarded call, the holder stamps it **itself**, only for
    `op: release-proof-forward`, only while `armed-pending-proof`, only on the cheapest
    verified model, at no more than 64 output tokens, and only bound to the applied
    intent hash.
- **`PROBE_DOOR` is unaffected.** `runCapGateProbe` calls `gate.admit` directly and never
  passes through the caller or release checks, so `enforcementReady` keeps working. The
  claim is therefore precise: no **caller-facing** path reaches the gate without these
  checks. The probe's admit request gains the new required fields with the probe's
  reserved values.

**Release checks, in order:**

| # | Check | How it is met |
|---|---|---|
| 1 | (d) Prices verified | Run 2 reads Google's price page for both models (the account lane's browser profile, read-only). A reviewed commit sets `verified: true` and `maxInputTokens`, citing what was read. |
| 2 | (a)+(e) One proof call | Through the real path: on a multi-machine agent, Run 2 calls `POST /routing-spend/release-proof` **on the Mama PC**, which sends `release-proof-forward`. On a single-machine agent it is local. The holder admits it, Hydrogen answers, and the settled row shows `door === ledger door === priced door`. That one row satisfies both the wiring check and the forward check. |
| 3 | (c) Reconciliation | One real `browser-read` record. The current month's figure is enough, even $0.00; `unmeasurable` does not count. |
| 4 | (b) Holder-death drill | Multi-machine agents only, run on the test-agent pair. The recorder checks the live-test harness's **signed** PASS artifact (path plus hash). **Honest limit:** that binds the agent to a recorded, signed run. It is not an independent witness. |

- If a check cannot be met, the door stays `armed-pending-proof`, and the completion
  report names the exact blocker. The agent never relaxes a check.
- Every metered door inherits the general rule (the smallest bounded proof on its
  cheapest verified model; (b) and (e) only on multi-machine agents). No other door is
  armed today.

**Backups and rollback.**

- Money state (caps, door policy, ledger, intent, reconciliation) stays deliberately
  **excluded from backups**: restoring an older ledger would reopen spent headroom.
- Rollback order: **freeze** (Bearer, instant), then disarm, then revert.
- After a revert, an older `validateCapsFile` meeting the new monthly-only record may
  reject the **whole** caps file. That is acceptable only because no other door is armed
  on any agent today: money simply stays closed, the safe direction. A test pins this.

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
- The agent never treats a chat "yes" as the PIN, and never enters the PIN itself.
- **A foundation weakness, stated rather than built over silently.** The dashboard PIN
  is a plain config value that the agent's own sessions can read. So "only the operator
  can release money" rests on agent discipline plus the audit row, not on a credential
  the agent cannot hold.
  - This weakness belongs to the parent money layer and affects every money release, not
    just this lane.
  - It is registered as a tracked foundation item: owner Echo, review 2026-12-21,
    alongside the fleet review. The candidate fix is to bind money commits to a
    person-only surface, such as the Work Board's person tap or a hashed PIN the agent
    cannot read.
  - This spec does not claim a human-presence record. None exists today.

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
  - the countTokens path, including the system instruction
  - `token-count-unavailable` on any countTokens failure
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
  - confirmation needs a fresh nonce echo, timed on the holder's receipt
  - a frozen or git-synced peer copy with a matching epoch does **not** confirm
  - an isolated holder fences at the 60s window
  - unknown fences
  - only a one-key-backed claim with a newer `designationEpoch`, naming a different
    machine, freezes;
    anything else only signals
  - `caps/lower` does not interrupt confirmation
  - backoff capped at 20s
  - the window constant is below `failoverThresholdMs`
  - a healthy three-machine pool stays confirmed for 10 minutes (integration)
- **`freezeRequested`:**
  - applied, then acknowledged, then cleared
  - an unseen request id at any epoch applies
  - a consumed id replayed after a PIN unfreeze is ignored
- **Submit and poll:**
  - `callId` dedupe folded from the ledger after a holder restart
  - `callid-conflict`
  - `settled-result-lost` never re-dispatches
  - retention eviction
  - the caller resumes polling by `callId`
- **E1 route:**
  - the spec path and sha must match
  - one pass per (spec hash, round), reserved under the lock: 3 concurrent same-key
    calls give 1 admitted
  - `e1-pass-limit` posture, with no step-down and no `gemini-cli` fallback
  - the forwarded payload digest is bound; divergent checkouts deliver the origin's
    payload to the fake provider
  - forwarded-header ingress refused
- **Lane transfer:**
  - refused while partitioned-alive
  - renders on the new machine
  - needs a freshly minted key plus the one-key artifact
  - only a one-key-backed newer generation wins a conflict; an unbacked claim never
    freezes the incumbent
  - an echo naming the holder itself is never a conflict
  - the month starts exhausted, with the upper bound shown
  - a tier-2 test: a transfer renders with the old holder offline
- **Release gate:**
  - the proof marker is refused from request input
  - the holder stamps it only for `release-proof-forward` while armed-pending-proof
  - one proof row satisfies (a)+(e)
  - the check order
  - the probe path unaffected
- **Admission race:** a caller disabled while the token count is paused is refused under
  the lock.
- **Tier:** both sides of a tier boundary, with the manifest insertion order reversed;
  settle uses the reserved price-point id.
- **Proof:** concurrent proof submissions and a restart after settlement still give one
  paid call.
- **Poll:** a poll without the `resultToken` gets `not-yours`. Two sessions share a
  bearer token, and the second cannot read the first's result. Dropping the whole submit
  acknowledgment and restarting the origin still recovers the result with one charge.
- **Token count:** a countTokens failure refuses `token-count-unavailable` before
  dispatch.
- **Provisional:** four concurrent reserves that would together pass $10 admit only up
  to the limit.
- **Transfer:** stays pending with the month exhausted, proof call included.
- **Key confinement:** go-live refuses without the one-key artifact, or when a second
  key exists in the project; a key minted after the filter clears offline peers.
- **Calendar:** a zone change with a reservation outstanding across midnight keeps its
  charged period.
- **Provider report:** settle, `feature_metrics` and `provider_cost_report` join on
  `reserveId`; a reporting-write failure leaves the booking.
- **Proposal binding:** a changed proposal file refuses render and commit with a
  new-card message.
- **Key generation:** a vault key whose SHA-256 fingerprint differs from the committed
  `keyGeneration` refuses.
- **Secret check:** a credential unique to the origin is caught at the origin; one
  unique to the holder is caught at the holder.
- **Dedupe first:** a lost acknowledgment on the last affordable call returns the
  existing call, not a cap refusal.
- **Transfer:** the sync filter drops metered names for all recipients while a proposal
  exists; the transfer stays pending, with the month exhausted, until the month resets
  or a PIN restores headroom.
- **Review policy:** an API outage with `gemini-cli` signed in reports Gemini
  unavailable.
- **Truncation:** a `MAX_TOKENS` finish is marked incomplete.
- **Setup flow:** the user-role live test is a Run 1 precondition.
- **Boot check:** a failover threshold under 176s refuses to arm, and it is re-checked
  on config change.
- **Pre-gate action:**
  - `gemini-payg-setup` writes only the flag plus the intent, never caps, while money is
    off
  - the commit schedules the restart
  - money already enforcing means the intent applies hot
  - a failed apply means a frozen door, a notice and no crash loop
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
  - `e2-share-exceeded`
- **Two-server mesh fixture:**
  - a forward from a non-holder **with its money layer off**
  - submit-then-poll, and an idempotent retry that makes no second reservation
  - mesh-rope failure falling back to the tunnel path
  - stop-action forwarding, and `freezeRequested` honoured when the holder was
    unreachable
  - the caps read proxied, plus `holderUnreachable`
- The composite plan:
  - rendered on the designated machine, including a render requested from the other
    server
  - the `secret-names` precondition, with an offline peer cleared by mint-after-filter
  - one PIN commit, then an automatic restart
  - intent applied, state `armed-pending-proof`
  - store-version drift refuses
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
- One E2 request deliberately over the verified tier, which returns the plain refusal
  message through the same Telegram surface. Only the free countTokens call runs.
- Operator money settings are **never** lowered for a test. The `cap-exceeded` message
  is proven in E2E against the fake endpoint.

## Decision points touched

| Decision point | Class | Floor / justification |
|---|---|---|
| D1: Admit or refuse at the month cap, freeze, live, stale/unverified price, unbounded reservation | invariant | Rule 4 "spend past a cap": an exact test with an irreversible miss. This is the existing gate plus the month dimension. basis: irreversible-consequence; evidence: spend past the cap is real money already billed by Google (master Rule 4 names it). |
| D2: Admit or refuse at the daily guard, per-call ceiling, E2 share, provisional ceiling | invariant (governed state) | Rule 4 "deterministic enforcement of recorded governed state". The values are set by the operator's PIN-committed plan, whose text lists them. They are defaults above the $50 floor that the operator approved and can change. basis: external-constraint; evidence: the operator PIN-commits these values in plan text that lists each one (Rule 4, recorded governed state). |
| D3: Caller and E3 component allowlist membership | invariant (governed state) | Exact membership in a PIN-set list, checked at the chokepoint. basis: external-constraint; evidence: the caller list is set by the operator PIN commit; widening it releases money. |
| D4: Exclude gating components from E3 in v1 | judgment-candidate, argued exemption | A v1 scope choice. The floor (subscription fallback, Rule 118) already protects gates. The exemption from an LLM arbiter is argued: an operator-reviewable scope line, not a runtime competing-signals decision. Revisitable by a later spec. |
| D5: The key's named-reader lint, `secret-get` refusal, child-env strip, per-recipient sync filter | invariant | Secrets ruled exception (Rule 86); exact name membership. basis: irreversible-consequence; evidence: a leaked metered key bills at full per-token rates (gemini-cli/credentials.ts), and a leak cannot be recalled. |
| D6: Refuse a prompt containing a **live secret value** | invariant | Secrets ruled exception, with an exact value match only. Shape matches are signal only. basis: irreversible-consequence; evidence: a live secret sent to Google is in a third party's logs and cannot be recalled (Rule 4). |
| D7: Lease positive confirmation; fence on isolation or unknown; freeze on a conflicting designation | invariant | Inherited parent N-2: exact epoch comparison on recorded state, with the conservative action. basis: irreversible-consequence; evidence: two spenders could double the $50 cap before anyone notices. |
| D8: Book a post-send failure, or an expiry, as a provisional full charge; late settle max() | invariant | Money: over-booking is the safe direction, and a deterministic rule. basis: irreversible-consequence; evidence: under-booking an uncertain charge lets real billed spend pass the cap. |
| D9: Spec-review step-down from Neon to Hydrogen | judgment-candidate | Bounded actions {Neon, Hydrogen, unavailable}. Triggers only on `cap-exceeded` or `per-call-ceiling`. Arbiter: a deterministic fit test. Conservative default: `unavailable` with the exact reason. Exemption from an LLM arbiter argued: with two models it is a fit computation, not competing signals. |
| D10: Invoice-drift notice (>10% and >$2, after one re-read) | judgment-candidate | Signal only, never moves the gate. Unmeasurable is recorded as `unmeasurable`. The agent investigates. |
| D11: Forward E1/E2 and stop actions to the holder vs. refuse locally | invariant | Exact designation match. Never a local spend. basis: irreversible-consequence; evidence: a local spend on a non-holder creates a second ledger and a second cap. |
| D12: Release state: `armed-pending-proof` until (a)–(e) | invariant | Recorded proof artifacts; deterministic checks. basis: irreversible-consequence; evidence: an unproven wiring could spend money the ledger does not record. |
| D13: Lane transfer: the month stays exhausted, the proof included; only a one-key-backed claim with a newer `designationEpoch` wins a conflict | invariant | Money: unknown spend is treated as spent (the safe direction). The operator can raise it by PIN. basis: irreversible-consequence; evidence: reopening headroom over unknown spend could let billed spend pass the cap. |
| D14: E1 route: spec-hash match, one pass per (spec hash, round) | invariant (governed runaway bound) | An exact test on recorded state. Its consequence: a runaway loop cannot repeat a paid review of the same round. The money caps are the floor. basis: irreversible-consequence; evidence: each repeated paid review is real money spent for no new information. |

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
- **FD-G16:** a lane transfer requires a fresh key and the one-key read. The month
  restarts exhausted (FD-G24). It is refused while the old holder is partitioned but
  alive.
- **FD-G18:** go-live is a new pre-gate action, `gemini-payg-setup` (flag plus intent
  only). The commit schedules its own restart: one PIN.
- **FD-G19:** the lease confirmation is an active signed `designation-echo` every 10s,
  with a 60s window. It is never read from git-synced or heartbeat copies.
- **FD-G20:** a lane transfer starts exhausted (superseded in mechanism by FD-G24).
- **FD-G21:** no E2 concurrency count. The E2 split is a proposed default, citing the
  report.
- **FD-G22:** the readable dashboard PIN is a registered foundation item (owner Echo,
  2026-12-21). It is not fixed in this spec, and no presence record is claimed.
- **FD-G23:** if a key's confinement is in doubt (spread, passed through a session, or
  not attested), the agent freezes the door and has the key revoked at once, with no
  operator step, because halting money is the agent's. The replacement key goes live
  through a fresh `gemini-payg-setup` commit with a new `keyGeneration`: one PIN.
  There is no purge path. Authority: the operator's 2026-11-20 approval, under which the
  account lane creates and manages the key, covers re-minting a replacement inside the
  same $50 grant.
- **FD-G24:** moving the lane is a fresh go-live with a `transfer` block. It is fenced by
  the one-key read, plus one account lane and one PIN per transfer. The month restarts
  exhausted, with the upper bound shown.
- **FD-G26:** the production key is minted at go-live, after the filter ships. A
  pre-ship key is for the smoke test only.
- **FD-G25:** plans are persisted and re-rendered when opened. The commit-triggered
  restart keeps every existing restart safeguard and disclosure.
- **FD-G27: existing metered spend outside the gate.** The bench key
  (`metered_gemini_bench`, project "instar echo") spent about $48 in the 28 days to
  2026-11-20, against a displayed $40 lifetime cap.
  - That cap cannot have been enforced, because no Instar code calls the gate. So a
    paid-call path exists outside the money layer. Its reader is not in the instar
    repo or the Mama PC agent home; it is probably a job or script on the Studio.
  - **Before the release** that makes `secret-get` refuse `metered_*` names, the build
    finds that reader. It moves it onto `admitMeteredCall` under the bench key's own
    caps (made monthly), or stops it. Exempting it is never an option.
  - The same release ships both changes, so the bench does not break silently, and its
    spend becomes visible and capped.
  - The bench stays in its own project, under its own cap, separate from this lane's
    $50. Google's experimental $50 project cap on "instar echo" stays as its second
    wall.
- **FD-G17:** account-lane work is routed to `echo-topic-145625` (brief sent 2026-11-20).
  Rotation at a transfer and the price-page read are steps owned by Run 2 or the transfer
  plan, done through the account lane's browser profile. The run's precondition is the
  key present on the Studio only.

## Maturation plan

- **ladder:** routingSpend.geminiPaygLane

  This is a new `src/data/feature-ladders.json` entry the build adds. Its flag is
  `routingSpend.money.enabled` plus the door's `releaseState`; disposition `ladder`,
  final `operator-armed-per-agent`, risk `money`.
- **test-agent-live:** On a throwaway two-home pair on the Mama PC with a fake Google
  endpoint, everything has passed:
  - all three test tiers;
  - the holder-death drill;
  - a forwarded E1 review from the non-holder;
  - the user-role setup flow (card, plan page, PIN commit, automatic restart, intent
    applied, `armed-pending-proof`), with a signed PASS artifact.
- **dev-agent-live:** Echo, after Justin's single PIN commit and release checks (a)–(e)
  on the real API: live for reviews and second opinions until 2026-12-21, read from
  `GET /routing-spend/caps` and the reconciliation records.
- **fleet:** dark. `routingSpend.money.enabled` stays off fleet-wide, an action-bearing
  `DARK_GATE_EXCLUSIONS` case. Each agent's operator would arm their own door by their
  own PIN. It never auto-enables.
- **graduation criterion:** offering the lane beyond Echo needs all of these on Echo:
  - one full Pacific month booked, with invoice drift under 10% against Google's
    billing page;
  - zero conflicting-designation events;
  - forward success at least 95%, not counting `holder-unreachable` during known
    machine sleep;
  - zero double-billed `callId`s.

  A month with no booked calls is not a pass.
- **dark-window:** the fleet review is on 2026-12-21, owner Echo, tracked as a
  commitment opened at merge. If the criterion is not met by then, the reason and a new
  date are recorded on that commitment. It is never left dark silently.

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
- **Designation echo: unified by active signed RPC** (`designation-echo`, every 10s).
  It is used for positive confirmation and conflict detection.
- **`freezeRequested` / `appliedFreezeRequestIds` and committed figures: unified** on
  the `session-status` capacity advert (30s pull, receive-clamped). Freeze wins. The
  figures feed a lane transfer only, never a live gate input.
- **E3 positions: skipped off-holder.** No state.
- **Key-handoff file (`state/gemini-payg-key-handoff.json`) and proposed-setup file:
  machine-local to the designated machine.**
  `machine-local-justification: physical-credential-locality` — they attest the key in
  that machine's vault, and are meaningless anywhere else. Excluded from backups,
  archived on commit or revoke, and cleaned up on rollback.
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

- This is a money stop, not a recoverable degradation the agent can heal. Reopening
  releases money, which is the operator's call. So no self-heal is claimed.
- The notice is a Work Board card carrying the reset plan (§5). It is sent on the trip
  tick, deferred through quiet hours.
- Dedupe `provisional:gemini-api:<monthEpoch>`.
- `audit-location`: the money ledger plus `state/routing-spend-caps.log`, metadata only.

**(c) Invoice drift.**

- `class: recoverable`. Self-heal is one re-read after 6 hours (`max-attempts: 1`).
- `max-notification-latency: 24h`. Reporting only; the gate is independent.
- Dedupe `drift:gemini-api:<monthEpoch>`.
- `audit-location`: reconciliation records.

**(d) Conflicting designation** (an equal or higher epoch only).

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

*(none)*

## Left behind

Precision and long-tail items from the six convergence rounds, deliberately not iterated
on. They are fixes for the build to pick up in passing, or accepted limits.

- **E4 (doorway-scan liveness) stays off.** Moving its `budgetCapUsd` into the PIN
  record is folded into the 2026-12-21 fleet review (owner Echo).
- **`claim-unauthorized` to `peer-version`.** Reuse the version-aware rule in
  `poolSignedReads.ts`, so a current peer's real denial is not labelled as an old peer.
- **`SESSION_STATUS_ADVERT_FIELDS` and the `pullOnce` spread.** Name the new fields,
  each with a receive clamp, and add a wiring test that each crosses the wire.
- **Secret checks off the event loop.** The exact-value secret check takes one vault
  snapshot per call and either yields or uses a single multi-pattern pass.
- **`secret-get.mjs` list.** Generate its literal list from `METERED_SECRET_NAMES` at
  build time, instead of keeping a hand copy pinned by a drift test.
- **Index for used review slots.** Keep the used `(specSha256, round)` keys and the
  idempotency-key store in an indexed cache beside the ledger totals. A cache miss
  consults the retained ledger, so a consumed slot never resets after eviction or a
  restart.
- **Retention.** `provider_cost_report` rows follow the parent table's retention (400
  days). Holder-local history stays on an old holder after a transfer; this is accepted.
- **Repeated freeze requests.** A peer that keeps minting new freeze-request ids can
  keep re-freezing the lane. This costs only liveness, and the requests are coalesced
  into one notice per hour.
- **Slack parity for E2.** E2 is a server route that sessions call, not a channel
  feature. The live proof runs through Telegram. A Slack leg is optional.
- **Signed designation reports.** If designation reports are ever signed, the signature
  proves which machine sent them, not that a PIN was entered. The one-key artifact is
  the real fence.
- **Measuring ask burden.** The 2026-12-21 review should count Justin's PIN asks and
  check whether the "integrate with other options" goal was met. That is evidence to
  gather then, not a target set now.
- **A looping round counter.** The review round number comes from the caller. A loop
  that keeps incrementing it is bounded only by the money caps, and this is stated.
- **Context-doc size on oversize refusals.** When an E1 review is refused for size,
  name which context docs pushed it over the limit.
- **The readable dashboard PIN** (FD-G22) is a foundation item of the parent money
  layer, tracked separately.
