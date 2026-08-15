# Grok Build Framework Integration (`grok-build`)

**Status:** draft — not yet review-converged
**Author:** echo
**Date:** 2026-08-14
**Motivation:** operator directive (Justin, 2026-08-14) — add a Grok-primary agent so the
fleet has a third genuinely independent model family for spec review and general work,
running on subscription billing rather than per-token API billing.

---

## 0. Evidence base (what is VERIFIED vs ASSUMED)

Everything in this section was established by direct probe on 2026-08-14, not from
vendor marketing. The distinction matters because the whole integration rests on it.

### 0.0 CORRECTION (external review pass 1, finding 1) — the billing sink is NOT established

An earlier draft of this spec listed "headless runs bill against the subscription" as
VERIFIED. **That was wrong, and the error was mine.** The probe established that a `-p`
run succeeds when `XAI_API_KEY` and `GROK_DEPLOYMENT_KEY` are absent from the
environment. That proves *some* credential worked. It does **not** establish which
billing sink was charged, because:

- a credential may live in `~/.grok/config.toml`, the OS keychain, or an env var under a
  name I did not check;
- the session JWT itself may be a metered credential rather than a draw on the weekly
  subscription pool;
- the unexplained cost figure (§ 0.1) is evidence that the sink is *unknown*, not
  evidence that it is the subscription.

**Until the sink is confirmed, every run is classified `billing-sink-unknown` and MUST be
budgeted as if it were API-metered.** This is the safe direction: if it turns out to be
subscription-billed we have merely been conservative, whereas the reverse error spends
real money silently.

**The decisive test** is not another local probe — it is a billing-side observation:
run a known workload, then read the account's weekly-pool usage percentage before and
after. If the pool moves, the sink is the subscription. That check requires the account
usage screen and is the next verification step.

### VERIFIED by direct observation

| Claim | How it was established |
|---|---|
| The CLI exists, is first-party, and is actively maintained | `xai-org/grok-build`, Apache-2.0, Rust, pushed 2026-08-13 |
| Installs without sudo to a user-local bin dir | Installer read before execution; installs to `~/.grok/bin` |
| Installed version | `grok 1.0.4 (d846eb93d94d)`, macos-aarch64 |
| Device-code auth exists for headless/remote hosts | `grok login --device-auth` |
| Auth succeeded on the SuperGrok account | session written to `~/.grok/auth.json`, mode 0600 |
| Session token carries explicit CLI entitlement | JWT scope includes `grok-cli:access` |
| A `-p` headless run succeeds with no API key in the environment | `XAI_API_KEY` and `GROK_DEPLOYMENT_KEY` confirmed ABSENT from the environment *before* the probe; a `-p` run then succeeded. **This proves only that SOME credential worked — see 0.0 for why it does NOT establish the billing sink.** |
| Headless returns structured token accounting AND a cost figure | `-p … --output-format json` returns `usage{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens}`, `total_cost_usd`, and per-model `modelUsage` |
| Model id in use | `grok-4.6-build` |
| Fixed per-invocation overhead is material | a one-word prompt consumed 12,061 total tokens, of which 11,520 were cache reads |
| **There is no usage/quota subcommand** | full subcommand list enumerated; no `usage`, `quota`, or `billing` command exists |

### 0.2 RESOLVED — the reported cost field's rate card (2026-08-14 burn test)

§ 0.1 flagged that `total_cost_usd` had an unknown basis. It is now **solved exactly.**

Least-squares over **22 runs** spanning 12k → 65k tokens per run, with widely varying
input/cache/output mixes, recovers the rate card at **0.00% maximum residual**:

| token class | solved rate / 1M | published `grok-4.6` list | ratio |
|---|---|---|---|
| input | **$0.3400** | $2.00 | 17.00% |
| cached input | **$0.0850** | $0.50 | 17.00% |
| output | **$1.0200** | $6.00 | 17.00% |

A uniform **17.00% of list across all three classes**, exact to four decimals, is not
coincidence — and it is not simply another model's list price: published `Grok Build 0.1`
rates are $1.00 / $0.20 / $2.00, which the data does NOT fit.

**Conclusion:** `total_cost_usd` is denominated at a plan rate of exactly **1/5.882 of
public API list** — an 83% discount, i.e. a **5.88× rate subsidy**.

**What this does NOT establish:** that the weekly pool is the debited sink, or that the
pool debits at this rate. Those still require the § 0.0 pool-delta observation. This
resolves the *denomination* question only. § 6's prohibition may accordingly be relaxed
from "never sum it" to "sum it, labelled plan-rate dollars, never list-rate dollars."

### 0.3 Pool-delta result: the counter DID NOT MOVE (2026-08-14)

The § 0.0 decisive test ran. Result: after **1,305,220 tokens** consumed on the account in
one day, the "Weekly SuperGrok Limit" still reads **0% used**, and Extra Usage Credits
remain **$0.00** with auto-top-up unconfigured.

**The account is confirmed correct.** The session JWT carries `tier = 1`, and the vendor's
own source maps tier 1 → `"supergrok"` (`jwt_tier_claim`: 0=free, 1=supergrok, 2=x_basic,
3=x_premium, 4=x_premium_plus, 5=supergrok_heavy, 6=supergrok_lite, 7=supergrok_plus).
So this is not a wrong-account artifact.

Three explanations remain, and the data does not separate them:

1. the pool is very large — >130M tokens if the display floors at 1%, >260M at 0.5%;
2. Grok Build usage does not debit the displayed weekly counter at all (the vendor FAQ
   describes a per-product breakdown that this account's screen does not show);
3. the counter lags.

**What this settles regardless of which is true:** 1.3M tokens ran at zero observable
cost, with no credit balance to draw on and no API key present. Whatever the mechanism,
the marginal cost of this framework's usage is not appearing anywhere we can see.

**What it does NOT settle:** the billing sink. § 0.0's classification stands.

**The load-bearing consequence — § 6.1 is now empirically proven, not merely argued.**
The pool percentage is useless as a burn signal: 1.3M tokens produced no movement, so the
counter cannot warn us before a wall. Budgeting MUST therefore come from our own token
accounting (§ 6.0), never from a vendor quota reading. This is the strongest form of the
earlier argument — we tried to observe quota, at real expense, and could not.

### NOT verified — open questions that gate parts of this spec

1. **What `total_cost_usd` is denominated in.** The observed run reported `$0.00118558`.
   The same tokens priced at published `grok-4.6` list rates come to `$0.00697400`
   (5.88× higher); at published `Grok Build 0.1` rates, `$0.00287800` (2.43× higher).
   Neither matches. So the field is either (a) a cheaper coding-variant rate, or
   (b) an already-discounted plan rate. **These imply very different subsidy
   arithmetic and the field must NOT be summed as if its basis were known.**
   § 6 specifies recording raw tokens so the basis can be chosen later.
2. Whether the weekly usage pool is readable by any programmatic means (no CLI
   surface exists; a settings screen shows a percentage).
3. Whether server-side per-tier enforcement differs from the client's tier
   classification (see § 3.2).
4. Whether `grok trace` exposes token counts usable for accounting.

---

## 1. Scope

Add `grok-build` as a **fifth** framework value alongside `claude-code`, `codex-cli`,
`gemini-cli`, and `pi-cli`.

**In scope:** the provider adapter, framework threading through the type union and its
~48 consuming files, session launch, quota handling, credential/login handling,
component routing eligibility, cross-model spec review as a third external family,
the stall-coverage matrix, and the three required test tiers.

**Out of scope for this spec:** a Cursor-CLI adapter (a separate route, tracked
separately); the subsidy measurement itself (deprioritised by the operator; it
accumulates for free once § 6 lands).

**Non-goal:** displacing any existing framework. This is ADDITIVE. Claude work stays on
Claude Code. Registration is gated on explicit opt-in exactly as `pi-cli` is, so an
agent that does not opt in is byte-identically unaffected.

---

## 2. Framework identity

- Framework id: `grok-build`
- Binary: `grok`
- Default model: `grok-4.6-build`
- Home: `~/.grok` (`GROK_HOME`-aware), config at `~/.grok/config.toml`

### 2.1 Binary-name collision (must not be papered over)

The installer creates **two** binaries: `grok` **and** `agent`. Cursor's CLI also
installs a binary named `agent`. If both routes are ever present on one machine they
collide on PATH.

**Requirement:** this adapter MUST invoke the absolute path to `grok`, resolved via
`frameworkBinaryPaths['grok-build']` with a default of `~/.grok/bin/grok`. It MUST NOT
invoke bare `agent`, and MUST NOT rely on PATH ordering.

---

## 3. Authentication

### 3.1 Auth precedence (documented by the vendor, confirmed by probe)

An active session token in `~/.grok/auth.json` takes precedence; `XAI_API_KEY` is only a
**fallback** when no session token is active.

**Requirement:** the adapter MUST treat an active session token as the only acceptable
credential for subscription-billed work, and MUST refuse rather than silently fall back
to an API key. A silent fallback would invert the economics without any visible signal —
this mirrors the existing cross-model reviewer door, which already forbids API-key auth
for exactly this reason (`codex-auth-apikey-forbidden`).

**Requirement:** on adapter init, if `XAI_API_KEY` is set in the environment AND no
session token exists, the adapter reports unavailable with a distinct, nameable reason
(`grok-auth-apikey-forbidden`) rather than proceeding.

#### 3.1.1 Use the vendor's own control, not only ours (probe finding, 2026-08-14)

The CLI exposes a native **Login Policy** with `disable_api_key_auth` (observed `(unset)`,
with `api_key_auth_disabled: false`). This is a stronger mitigation than the adapter-side
refusal specified above, because it closes the fallback inside the binary rather than
around it — covering credential locations the adapter cannot enumerate (config file,
keychain, an env name we did not think to check), which is exactly the gap external
review finding 3 identified.

**Requirement:** set `disable_api_key_auth` for the agent's grok home, and treat the
adapter-side refusal as a second layer rather than the primary control. Verify the
setting is in force via the CLI's own inspect output before enabling the framework —
a policy we believe is set but cannot observe is not a control.

### 3.2 Tier gating — what is actually true

The CLI's own tier classifier restricts exactly two tiers: the free tier and X Basic.
SuperGrok, SuperGrok Lite, SuperGrok Heavy, X Premium and X Premium+ are all classified
unrestricted, and the restriction governs image/voice endpoints rather than coding.

**Caveat carried forward:** that is the *client's* classification, and the source
explicitly notes the server authoritatively enforces per-tier limits and that the client
should never withhold a capability on a guess. So the adapter MUST NOT implement its own
tier gate. It surfaces whatever the server returns.

### 3.3 Per-machine login (multi-machine requirement)

The operator requires this account usable from both machines.

**Requirement:** each machine mints its **own** session via `grok login --device-auth`.
A session token is NEVER copied between machines. This matches the existing
Account Follow-Me model (re-mint per machine; only non-credential metadata replicates)
and avoids relocating a login, which is the failure mode that model exists to prevent.

**Requirement:** `FrameworkLoginDriver` gains a `grok-build` path that starts device-code
auth and surfaces the user code + URL for operator approval — never a browser assumption,
since the login must be approvable from a phone.

---

## 4. Transports

Two, mirroring the existing adapter shape:

### 4.1 One-shot completion (internal LLM calls)

`grok --prompt-file <FILE> --output-format json [-m MODEL]`

**Requirement (review-2 finding 12):** the prompt MUST NOT be passed as a command-line
argument. `-p <PROMPT>` places the full prompt in the process argument list, where it is
readable by any process on the host and subject to argument-length limits. I hit this
directly while running the review passes for this spec — a 16KB prompt passed as argv
worked, but it was visible in the process table the whole time. Use `--prompt-file` (or
stdin), spawn without a shell, and cap prompt size.

- Returns a single JSON object; token usage and cost are in that object (§ 6).
- Supports `--json-schema` for constrained structured output — this is a genuine
  capability advantage and SHOULD be used where a component needs a typed result.
- Supports `--allow` / `--deny` tool rules and `--disallowed-tools`.
- `--disable-web-search` MUST be set for any call whose prompt contains untrusted
  content, matching how other adapters bound egress.

### 4.2 Agentic session (interactive / spawned sessions)

`grok agent stdio` speaks Agent Client Protocol over JSON-RPC with session lifecycle,
streaming and permissions. Sessions persist under `~/.grok/sessions` with
`-s/--session-id`, `-r/--resume`, and `-c/--continue` — which maps directly onto the
resume semantics `ResumeValidator` and the reap/revival path already expect.

Interactive TUI sessions run in tmux exactly as other frameworks do; dashboard streaming
is unchanged.

---

## 5. Integration surface

Threading a framework value touches ~48 files (measured against `pi-cli` in the current
source tree). Grouped:

| Area | Files (representative) |
|---|---|
| Type union | `core/types.ts` — framework, binary paths, default models, component routing, failure-swap |
| Adapter | `providers/adapters/grok-build/*` — capabilities, config, errors, policy, index, transport, observability, control |
| Registration | `providers/bootRegistration.ts` — gated on `enabledFrameworks` |
| Session lifecycle | `frameworkSessionLaunch`, `FrameworkSessionStore`, `SessionManager`, `ResumeValidator`, `SessionReaper` |
| Routing | `IntelligenceRouter`, `internalFrameworkDefault`, `intelligenceProviderFactory` |
| Quota / accounts | `QuotaTracker`, `SubscriptionPool`, `CredentialLocationLedger`, `PendingLoginStore` |
| Config / setup | `Config.ts`, `commands/setup.ts`, `commands/init.ts`, `PostUpdateMigrator` |
| Review | `crossModelReviewer.ts` (§ 8) |
| Signals | `frameworkProcessSignals`, `frameworkActivitySignals`, `FeatureMetricsLedger` |
| Agent awareness | `scaffold/templates.ts` (mandatory — see § 10) |

---

## 6. Token and cost accounting

This framework reports **more** than the others: every headless run returns exact token
counts and a cost figure, per model. Instar currently reconstructs this for other
frameworks.

### 6.0 Accounting semantics — VERIFIED by arithmetic (closes review-2 finding 9)

Review pass 2 raised that the usage fields might overlap or double-count. Checked across
three independent runs (12,061 / 26,104 / 40,754 total tokens):

- `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`
  equals `total_tokens` **exactly, in all three samples**. The four are disjoint and
  exhaustive.
- `reasoning_tokens` is strictly ≤ `output_tokens` in all three (28≤33, 6162≤9260,
  614≤866), i.e. a **subset of output**, not an additional bucket.

**Requirement:** sum the four disjoint fields; NEVER add `reasoning_tokens` on top, and
never sum top-level `usage` together with `modelUsage` (they describe the same run).
n=3 on a single model — re-check if the envelope version changes.

**Requirement:** record the **raw token counts** (`input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`reasoning_tokens`) into `FeatureMetricsLedger` as the authoritative record.

**Requirement:** `total_cost_usd` MAY be recorded as a reported-cost annotation but MUST
NOT be treated as list-price-denominated, because its basis is unresolved (§ 0, open
question 1). Pricing decisions join raw tokens against a reviewed rate manifest on read —
the same discipline the routing-spend view already uses.

**Consequence for `usageCoverage`:** `grok-build` reports per-call tokens, so it is NOT a
cannot-surface exemption. Zero coverage on this framework is a drift alarm.

### 6.1 Quota

There is no usage/quota command. `QuotaTracker` therefore CANNOT read remaining
allowance for this framework.

**Requirement:** `grok-build` quota state is reported honestly as **unknown** rather than
defaulted to healthy. A framework whose quota cannot be read must not be treated as
having headroom — that is how a silent wall happens. Placement and swap logic MUST treat
unknown as unknown, not as available.

---

## 7. Rollout

Ships **dark**. Registration occurs only when `enabledFrameworks` explicitly contains
`grok-build`, exactly as `pi-cli` is gated. With no config change, nothing differs.

Graduation order: adapter available → one-shot internal calls on an opt-in component →
spawned sessions → cross-model review family. Each step is separately reversible by
removing the framework from `enabledFrameworks`.

---

## 8. Cross-model spec review (the strongest motivating case)

`crossModelReviewer` currently supports two external families: codex (GPT-tier) and
gemini (Gemini-tier). It runs one external pass per family, and its detection layer is
per-family (`detectGeminiReviewer` + a registry entry) specifically so families can be
added.

**Requirement:** add `detectGrokReviewer` + a registry entry, making Grok a **third**
family. Because the reviewer door forbids API-key auth, and this framework authenticates
by subscription session token, it satisfies that door natively.

**Requirement:** reviewer runs execute in an empty read-only scratch dir with no repo
access and with web search disabled, matching how the codex reviewer is already confined.

---

## 9. Stall-coverage matrix (gating requirement)

Onboarding a framework REQUIRES `docs/frameworks/grok-build-stall-coverage.md`: every
session-stop class enumerated, with detection and recovery per class. The apprenticeship
lifecycle enforces this — a provisional matrix gates `pending→active`, and a full matrix
verified from live state gates `active→complete`.

Classes needing framework-specific analysis here, at minimum:
- device-code session token expiry mid-run (the token carries an `exp`)
- weekly-pool exhaustion with no readable quota (§ 6.1) — the wall is invisible in advance
- leader-process wedge (`~/.grok/leader.sock`)
- ACP JSON-RPC stream stall
- headless run that exits 0 with empty output

---

## 10. Agent Awareness (mandatory)

Per the Agent Awareness Standard, `generateClaudeMd()` MUST gain a `grok-build` section:
how to check whether it is available, the per-machine login model, the quota-unknown
caveat, and the proactive trigger for using it as a third review family. A capability the
template does not mention is a capability no agent will surface.

## 11. Migration Parity (mandatory)

New framework values reach existing agents only through the update path. `migrateConfig`
MUST add absent `grok-build` fields with existence checks only, and `migrateClaudeMd`
MUST add the § 10 section behind a content sniff. Both idempotent.

---

## 12. Testing (all three tiers required)

- **Unit** — tier classification is NOT reimplemented (§ 3.2); auth precedence refuses
  API-key fallback; binary path resolution never uses bare `agent` (§ 2.1); token
  extraction from the JSON envelope; cost field recorded as reported-basis, never as list.
- **Integration** — full HTTP pipeline with the framework enabled; routing selects it;
  metrics rows carry real token counts; quota reports unknown rather than healthy.
- **E2E** — production initialization path mirroring `server.ts`: with `grok-build` in
  `enabledFrameworks`, the adapter registers and answers 200 rather than 503; with it
  absent, registration does not occur and behaviour is unchanged.
- **Wiring integrity** — the registered adapter is the real implementation, not a no-op.
- **Semantic correctness** — both sides of the auth-precedence and quota-unknown
  boundaries, with realistic inputs.

---

## 13. Risks

1. **Quota invisibility (§ 6.1).** The most serious. We cannot see the wall coming.
   Mitigation: honest unknown state; rely on the per-run cost/token record to accumulate
   an empirical burn rate over time.
2. **Cost-basis ambiguity (§ 0.1).** Mitigated by recording raw tokens and refusing to
   sum a field of unknown denomination.
3. **Server-side tier enforcement diverging from client classification (§ 3.2).**
   Mitigated by not implementing a local gate and surfacing server errors verbatim.
4. **Binary collision (§ 2.1).** Mitigated by absolute-path invocation.
5. **Single-account, two machines.** Both machines draw on one weekly pool; combined
   burn is invisible per § 6.1. Worth an explicit operator conversation before the
   second machine is authorised.

---

## 14. Open decisions for review

- Should `grok-build` be eligible for the internal off-Claude default chain
  (`codex-cli → pi-cli → gemini-cli → claude-code`)? Adding it would spread background
  load further, but the quota-unknown property (§ 6.1) argues for keeping it OUT of the
  automatic failure-swap tail until burn rate is empirically known.
- Whether `grok trace` gives a cheaper accounting path than parsing run output.
- Whether the Cursor route should be specced in parallel as a second door, given its
  documented 2× credit subsidy applies to non-Grok models.
