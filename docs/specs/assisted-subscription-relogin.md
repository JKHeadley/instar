---
title: "Assisted Subscription Re-Login — one approval, autonomous repair"
slug: assisted-subscription-relogin
parent-principle: "No Manual Work (user *or* agent)"
status: draft
owner: echo
author: echo
topic: 33890
depends-on:
  - subscription-pool-authority-foundation
  - subscription-signin-ledger
review-convergence: "2026-08-28T08:27:11.672Z"
review-iterations: 3
review-completed-at: "2026-08-28T08:27:11.672Z"
review-report: "docs/specs/reports/assisted-subscription-relogin-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "two successful rounds; claude-code clean-door degraded on execution"
approved: true
approved-by: "Justin (verified operator uid:7812716706), Telegram topic 33890, 2026-08-28 09:20 PDT"
approval-context: "Approved the reviewed V1 boundary and directed the autonomous session to continue through full implementation, release, deployment, and live verification without stopping. At 2026-08-28 09:23 PDT Justin also preapproved required authentication decisions and required phone-complete dedicated Chrome-profile provisioning through secure links or the Instar dashboard, with no host-machine access. Separate authorization remains required before using any real operator-owned subscription as the canary."
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 5
---

# Assisted Subscription Re-Login

## 1. Outcome and boundary

When a subscription account has a corroborated authentication failure, Instar offers the verified
operator one repair approval. That approval authorizes one account, one machine, one bounded repair
episode. After the click, Instar launches the provider-native login in the account's isolated slot,
drives the browser with the account's registered browser profile, completes any CLI paste-back,
verifies the resulting provider identity, proves authenticated use, and closes the incident without
requiring more routine operator work.

The initial release is **approval-gated autonomous repair**. It does not silently enable unattended
repairs. A later per-account `unattended` policy may remove the approval only after the same account,
provider, and machine path has enough successful, identity-correct repair evidence. The unattended
policy is an explicit operator choice, never inferred from use.

This is a repair system, not a credential copier. The provider's own login client writes the
credential into the existing per-account config home. Instar stores no password, TOTP seed, OAuth
token, returned authorization code, or browser cookie in its repair ledger.

## 2. Existing authorities reused

The feature composes existing authorities rather than duplicating them:

- `SubscriptionPool` is the account/config-home authority.
- `SubscriptionLoginLedger` supplies corroborated status episodes. Provisional credential-read
  windows are never repair triggers.
- `EnrollmentWizard` + `FrameworkLoginDriver` own isolated CLI launch, public artifact capture,
  expiry, reissue, restart recovery, and pending-attempt state.
- the dashboard PIN / verified topic operator mints the one-episode approval mandate.
- `PlaywrightProfileRegistry` resolves the exact browser identity and vault-reference names;
  ambiguity or stale/missing profile state refuses automation.
- `PlaywrightSeatLease` serializes the physical browser.
- the existing follow-me completion gate proves the freshly authenticated provider email matches
  the intended subscription account before the pool becomes active.
- `QuotaPoller` provides the final authenticated-use proof. Credential-file existence alone is not
  success.

## 3. Trigger admission

A repair candidate is admitted only when all are true:

1. pool authority is `ready`;
2. the account exists and is `needs-reauth`;
3. the login ledger has an open status episode for the same account/machine whose cause is a
   corroborated authentication cause (`refresh-rejected`, `provider-unauthorized`, or the existing
   closed equivalent); an inferred level may surface a suggestion but cannot auto-run;
4. no live pending login or repair episode already owns the cell;
5. the account has an unambiguous browser-profile mapping for its provider identity;
6. the framework has a verified isolation mapping and credential witness;
7. the provider path is supported by the browser driver;
8. global, per-provider, per-account, and per-machine breaker/cooldown budgets admit the run.

Repeated missing/unreadable credential observations, pool corruption/unavailability, identity
ambiguity, quota exhaustion, rate limits, and unmeasured cells never trigger re-login.

## 4. Authorization

`POST /subscription-relogin/:episodeId/approve` accepts dashboard-PIN proof or a signed verified-
operator action token. The server resolves account, machine, expected identity, config home, and
browser profile from authoritative stores; none are trusted from the request body.

An approval mandate is:

- scoped to one repair episode and its immutable input digest;
- single-use, 15-minute expiry, CAS-consumed before the first external action;
- invalidated when the source incident closes, account mapping changes, authority degrades, or a
  newer repair episode supersedes it;
- insufficient for another account, machine, provider, or retry episode.

Dashboard and Telegram actions carry only the opaque episode id. They never carry credentials,
codes, email addresses, or login URLs.

## 5. Durable state machine

The durable `SubscriptionReloginStore` is the single writer for repair state:

`suggested -> approved -> cli-starting -> artifact-ready -> browser-driving -> cli-finishing ->
identity-verifying -> auth-verifying -> succeeded`

Terminal alternatives are `refused`, `cancelled`, and `failed`. `waiting-operator-only` is a loud,
nonterminal state for a closed provider-policy/implementation challenge that this release forbids
automation from satisfying (phone confirmation, CAPTCHA, risk review, consent expansion, or an
unknown challenge class). It is not reported as autonomous success; no LLM makes this policy choice.

Every transition is CAS guarded and records only closed enums, timestamps, attempt counters,
account/machine opaque ids, and redacted correlation ids. Restart recovery re-observes external
truth before advancing. It never blindly repeats a browser click, code submission, or credential
mutation whose prior outcome is uncertain.

## 6. Autonomous execution

### 6.1 Deterministic controller

`SubscriptionReloginOrchestrator` owns admission, state transitions, retry classification, time
budgets, cancellation, and final verification. It does not inspect web-page prose or handle secret
values.

### 6.2 Tier-1 supervised browser worker

Each approved episode launches a bounded browser worker under a structured contract. The worker:

- acquires the host Playwright seat lease and activates the resolved profile;
- opens only the provider verification origin allowlisted for that framework;
- confirms the page is for the expected provider and the expected account identity before approval;
- uses an existing authenticated browser session first;
- if the registered login method is `password` or `password+totp`, resolves only the named vault
  refs inside the worker and submits them directly to the allowlisted origin; values never enter
  prompts, logs, state, screenshots, or API responses;
- refuses password+phone-2fa, CAPTCHA, account chooser ambiguity, recovery-email changes, consent
  expansion, billing prompts, or any unexpected origin;
- returns a closed typed result plus redacted page-state evidence.

A Tier-1 LLM supervisor validates each page transition against the deterministic contract. The LLM
may classify a known page state; it cannot choose the account, broaden origin scope, approve new
permissions, retrieve arbitrary vault secrets, or declare success.

The supervisor is required because provider login pages vary their accessible labels, layout, and
interstitial ordering without a stable versioned DOM API. Deterministic predicates still establish
origin, account, scope, challenge class, and the closed allowed-action set; the supervisor only maps
the already-redacted visible structure to one member of that set. Invalid, low-confidence, or
out-of-set output refuses. The release records supervisor disagreement/refusal and provider-challenge
rates; a deterministic-only worker may replace it once the supported page variants demonstrate an
equivalent false-action rate over the same canary corpus.

The browser-profile mapping is one exact tuple: `(profileId, provider, loginIdentity,
subscriptionAccountId, loginMethod, vaultBindingNames)`. Exactly one tuple must match the pool cell.
Multiple matching tuples, multiple provider identities visible in the active page, an account chooser,
delegated/impersonated context, an alias that is not the identity oracle's canonical identity, or an
enterprise-managed account without an explicit canonical mapping all refuse as `account-ambiguous`.

Supervisor input is a closed JSON object containing only `pageClass`, exact `origin`, boolean
predicates (`expectedIdentityVisible`, `scopeAllowed`, `chooserPresent`, `challengePresent`), a closed
`allowedActions` array, and normalized element roles/test identifiers from an allowlist. It excludes
text-node content, input values, URLs/query strings, cookies, emails, codes, screenshots, and arbitrary
accessibility labels. Output is `{action, confidence}`; the action must be allowed and confidence must
be at least 0.95 or the worker refuses. The canary corpus is a versioned set of synthetic/redacted DOM
fixtures for every V1 matrix row and known refusal page.

Alternatives considered: device-code-only cannot cover Claude's URL/paste-back variants; browser
extensions add a larger privileged persistence surface; selector-only RPA remains the deterministic
guard but is brittle across provider layout/interstitial variants; fixture traces supply regression
evidence but cannot classify a previously reordered known state. The constrained, non-authoritative
supervisor is the smallest V1 fallback that preserves deterministic security gates.

### 6.3 CLI completion and proof

For Claude's paste-back flow, the returned one-time code is held in memory only and delivered
through the existing readiness-checked pane path. For device-code flows, the browser approval is
followed by the existing credential witness. Tmux scrollback is cleared after any code submission.

Success requires all of:

1. provider identity oracle returns the expected account;
2. the credential-location ledger points to the intended isolated slot;
3. a fresh authenticated provider call succeeds;
4. the pool returns to `active`;
5. the sign-in ledger closes the exact source episode.

If any proof disagrees, the credential is quarantined/held by the existing identity gate and the
repair cannot succeed.

## 7. Retry, recovery, and breakers

- One browser drive at a time per host; one repair per account/machine cell.
- Default maximum: 3 attempts per episode, 2 artifact reissues per attempt, 10 minutes wall clock.
- Retry only typed transient failures (seat busy, target temporarily unreachable, expired public
  artifact, provider 5xx). Use capped exponential backoff with jitter and preserve the same episode.
- Never retry wrong identity, unexpected origin, CAPTCHA, permission expansion, corrupt authority,
  missing vault references, or repeated provider rejection.
- Three failed episodes for the same account/provider path within 24 hours open a breaker for 24
  hours. Breaker reset requires a verified success or explicit operator action.
- Any CAPTCHA, phone challenge, risk-review interstitial, or unexpected provider anti-abuse prompt
  opens the provider-path breaker immediately for that account. A rising challenge rate in the
  disposable canary corpus blocks rollout of that path; Instar never retries through provider risk
  controls or treats them as a browser-selector defect.
- Rollout stops for any wrong-identity, unexpected-origin/scope, or secret-exposure event, or a
  challenge-rate increase above the disposable manual-login baseline. The path disables after the
  first security event or two risk challenges in 24 hours; the verified operator owns review and only
  an explicit config change may re-enable it.
- Operator cancel is authoritative at every nonterminal state and prevents new external actions.
- Cancellation is checked before and after every awaited port call. In `browser-driving` it aborts
  the worker, closes its page/context, releases the seat, and drops in-memory secret/code references.
  In `cli-finishing` it prevents further pane writes, clears submitted-code scrollback, and re-observes
  credential truth without advancing. An uncertain already-issued action is never replayed.
- A shutdown leaves enough durable intent to re-observe safely; it does not leave a credential code
  or secret on disk.

## 8. Modes and rollout

- `off`: no candidates, routes return typed disabled state.
- `observe`: candidates and reasons only; no approval action.
- `approval`: one-click approval, autonomous execution after approval. Initial live mode.
- `unattended`: per-account opt-in; no approval click for corroborated incidents. Dark in the first
  release, but the policy/state shape is included so enabling it later does not require migration.

Graduation from `approval` to `unattended` requires at least 10 successful repairs for the exact
provider/framework path across at least 30 days, zero identity mismatches, zero unexpected-origin
events, and an explicit operator opt-in. Metrics are evidence for the option, never authority to
enable it.

## 9. Surfaces

- `GET /subscription-relogin` — bounded local/pool episode view with typed peer failures.
- `POST /subscription-relogin/:episodeId/approve` — one-click mandate and start.
- `POST /subscription-relogin/:episodeId/cancel` — authoritative cancellation.
- `POST /subscription-relogin/:episodeId/retry` — explicit retry after a non-security terminal.
- `GET /subscription-relogin/:episodeId/events` — redacted bounded audit trail.

The dashboard Subscriptions grid shows one action: **Repair sign-in**. After the click it shows the
state machine and only interrupts the operator for a genuinely operator-only challenge. Telegram
receives no per-pass noise: one actionable approval, one final success, or one durable blocker.

The same dashboard includes **Create a dedicated sign-in profile**. A recent dashboard PIN proof
authorizes one exact Google identity/profile tuple; the server creates the jailed 0700 machine-local
profile directory and registry mapping idempotently. The agent completes all routine setup. If a
password, TOTP, CAPTCHA, phone check, or provider consent genuinely requires the operator, the only
operator task is one secure Secret Drop/provider link or one dashboard challenge response. Physical
or remote-desktop access to the host machine is never part of the workflow.

## 10. Privacy and security

- Repair DB, logs, screenshots, and artifacts are machine-local, mode 0600/0700, excluded from
  backups, file viewer, publishing, mesh replication, and diagnostics bundles.
- Screenshots are disabled by default. On a typed failure, a redacted DOM/state digest may be kept;
  no form values, cookies, URLs with query strings, emails, or free text.
- All outbound navigation is exact-origin allowlisted with redirect validation on every step.
- Vault references are names in durable state; values exist only in the browser worker process and
  are zeroed/released on completion as far as the runtime permits.
- External-operation, coherence, mandate, write-domain, SourceTreeGuard, and credential-write
  funnels remain in force. This feature creates no bypass.

## 11. Testing and release gates

### Unit

Cover both sides of every admission predicate, immutable approval scope, single-use/expiry CAS,
every state transition, restart at every boundary, idempotency after uncertain outcomes, secret
scrubbing, origin redirects, identity mismatch, cancellation races, retry taxonomy, breakers, and
unattended graduation refusal/admission.

### Integration

Exercise authenticated HTTP routes through the real controller and stores, duplicate requests,
stale approvals, cross-machine relay failures, corrupt/unavailable authorities, operator cancel,
worker typed outcomes, and bounded audit responses. Prove no response contains credential-like
fields or login URL query strings.

### E2E

Boot the production `AgentServer` composition and prove the feature is alive (not 503) when enabled,
dark when disabled, wired to real non-no-op dependencies, and able to complete a synthetic provider
repair through CLI artifact, browser-worker contract, identity oracle, authenticated probe, pool
recovery, and ledger closure. Add crash/restart lifecycle fixtures and a clean-install migration
test.

Before merge: build, static preflight, full `npm run test:all` with zero failures, independent
security/architecture review, release note, CLAUDE.md capability/proactivity update, config + hook +
skill migration parity as applicable, coherence gate, CI, npm publish, Echo auto-update, and a live
approval-mode canary against a disposable/test identity before any real subscription repair.

### V1 acceptance matrix

| Provider path | Required positive evidence | Required refusal evidence |
|---|---|---|
| Anthropic-direct, existing authenticated profile | Provider-native approval reaches identity oracle, authenticated probe, active pool, and exact incident closure | Wrong/absent identity and multiple identities refuse before approval |
| Anthropic-direct, password | Named password vault binding is resolved only inside the worker; exact-origin submit completes the same four-part success proof | Missing binding, unexpected origin, chooser, CAPTCHA, phone/risk challenge, or added scope refuses without retry |
| Anthropic-direct, password + TOTP | Named password and TOTP bindings are submitted only to the allowlisted page and produce the same independent success proof | Stale/rejected TOTP retries only within the single attempt contract; recovery/MFA-setting changes refuse |
| Google identity for Anthropic | Exact Google tuple and canonical post-login Anthropic identity both match before activation | Any Google chooser, alias ambiguity, delegated/managed ambiguity, or consent expansion refuses |
| Claude URL + paste-back | Public artifact is bounded/reissuable; returned code is memory-only and delivered through the readiness-checked pane; live credential oracle and authenticated use corroborate completion | Expired artifact reissues within budget; dead pane, uncertain submission, or credential/identity disagreement cannot succeed |

Every row requires unit coverage of the decision boundaries, integration coverage through the real
worker/controller seam, and an AgentServer E2E witness that the enabled production dependency is
non-null and delegates. The disposable live canary must exercise at least the row being promoted.

## 12. Non-goals for the first release

- bypassing provider CAPTCHA, phone confirmation, or anti-abuse controls;
- changing passwords, recovery email, MFA settings, consent scopes, plans, or billing;
- copying a credential between machines instead of authenticating provider-natively;
- treating browser session presence, credential-file existence, or LLM judgment as success;
- enabling unattended mode automatically.

## 13. Multi-machine posture

The repair database, CLI pane, config home, browser profile, provider credential, and physical
browser seat are **machine-local BY DESIGN**.

`machine-local-justification: physical-credential-locality`

Those objects describe and mutate a credential that physically exists on one machine. Replicating
the repair ledger or approval proof would be unsafe: a peer cannot observe the local pane/browser
outcome and could replay an external action against a different credential slot. A pool-wide account
view may show that another machine needs re-auth, but the repair itself must be proposed and executed
by the machine holding that cell. User-facing notices use the existing attention hub and stable
delivery keys, producing one approval notice and one terminal/blocker notice per episode rather than
one notice per scan. The dashboard action targets the holder's local episode; no credential-bearing
URL is generated or relayed. If the holder disappears, the durable local episode remains; another
machine does not inherit or guess its authority.

## 14. Decision points touched

| Decision point | Class | Floor / authority |
|---|---|---|
| Admit a repair candidate | `invariant` | Closed conjunction of ready pool authority, corroborated open incident, exact cell/profile/identity mapping, supported method, and closed breaker. Absence/ambiguity refuses. |
| Approve an episode | `invariant` | Only a short-lived proof minted by dashboard PIN unlock (or explicit PIN fallback) may consume the immutable episode digest. The ordinary agent bearer token is insufficient. |
| Choose a browser action | `judgment-candidate` | Deterministic page classifier supplies a closed state and closed allowed-action list; Tier-1 supervisor chooses only within it. Invalid output refuses. Account/origin/scope/secrets/success remain outside LLM authority. |
| Classify provider challenge | `invariant` | CAPTCHA, phone confirmation, unexpected origin, scope expansion, and wrong identity have fixed conservative outcomes; automating around anti-abuse controls is forbidden. |
| Retry a failure | `invariant` | Only the closed transient taxonomy retries, under attempt/reissue/time/backoff budgets. Security terminals never retry. |
| Declare repair success | `invariant` | Requires independent identity oracle, authenticated provider use, active pool state, and closure of the exact source incident. No proxy symbol alone suffices. |
| Graduate to unattended | `invariant` | Dark in v1. Future admission requires explicit per-account opt-in plus the fixed evidence floor; metrics cannot self-enable authority. |

## 15. Frontloaded Decisions

| ID | Resolution |
|---|---|
| FD1 | First release mode is `approval`, not unattended. One operator click scopes one exact episode; everything routine afterward is autonomous. |
| FD2 | Fleet defaults remain `enabled:false`, `dryRun:true`, `mode:approval`. Echo is promoted locally only after clean gates and a controlled canary. Existing operator-set values are preserved by add-missing migration. |
| FD3 | Initial provider/framework support is Anthropic Claude Code only, through exact provider-owned origins and either one exact Anthropic-direct or Google browser identity mapping. |
| FD4 | Password and TOTP are vault-name bindings stored on the profile account. Secret values are resolved only inside the worker and never enter LLM input, repair state, logs, screenshots, APIs, or messages. |
| FD5 | Machine-local state is required by physical credential locality; no cross-machine replay/replication is added. Attention uses the single existing hub. |
| FD6 | The browser supervisor remains mandatory Tier 1, but holds no authority beyond selecting one deterministic allowed action. |
| FD7 | Retry/time limits are 3 attempts, 2 artifact reissues, and 10 minutes per episode; three failed episodes in 24 hours open the durable breaker. |
| FD8 | Rollback is the config kill switch (`enabled:false`) followed by a code revert. Durable redacted rows may remain for audit; no credential cleanup is required because Instar never owns the provider credential. |

No unresolved user decision remains in the implementation. Enabling `unattended`, broadening provider
origins/scopes, adding a new provider, or using a real operator-owned identity for canary is a new
authority decision and is outside this release.

## 16. State-symbol verification

| Symbol read | Real state claimed | Independent corroboration | Unmeasurable outcome |
|---|---|---|---|
| Open login-ledger episode | A provider-auth failure is currently unresolved | Pool account independently reports `needs-reauth` for the same account/machine cell and the episode cause is exchange-corroborated | No candidate; never infer from missing files |
| Browser page class | Which bounded browser action may be attempted | Exact current origin, expected-account visibility, scope allowlist, and deterministic DOM predicates | Unknown page may only wait within budget, then fails transiently; no credentials submitted blindly |
| Provider credential readable | The CLI may have consumed the returned code | Identity oracle reads the live slot credential and resolves a provider identity | Remain pending/re-observe; file presence is not accepted |
| Identity match | The intended account owns the new credential | Fresh authenticated quota/provider call against that same slot | Retry boundedly or refuse mismatch; never activate pool |
| Pool `active` and source episode closed | The repair is integrated into both authorities | Fresh re-read after idempotent finalization, not the return value of the write | Stay `auth-verifying`; never emit success |

## 17. Automated notice and self-heal declaration

The recurring scanner never alerts on first detection of a raw credential symptom. The passive ledger
first exhausts its own corroboration floor; the repair service then performs the remediation itself.
An approval notice is the necessary authority request, not an avoidable failure escalation. After
approval, transient failures self-heal through bounded retry/reissue before any terminal notice.

- remediation actions: re-observe existing CLI attempt, refresh an expired public artifact, reacquire
  the browser seat, re-poll identity/authenticated use, and idempotently finalize pool/ledger state;
- brakes: max 3 attempts, max 2 reissues, 10-minute wall clock, capped exponential backoff, one
  episode per account/machine cell, stable outbox delivery key, and durable per-account breaker;
- compensation: cancellation aborts in-flight work and prevents new actions; uncertain non-idempotent
  browser outcomes park operator-only rather than replay; finalization is repeatable from authoritative
  reads;
- maximum notification latency: the approval request is emitted on candidate admission; an
  operator-only challenge or terminal result is queued immediately after its durable transition;
- audit location: `state/subscription-relogin/repairs.db`, metadata-only and excluded from backup,
  file viewing, publishing, diagnostics, and replication;
- severity: wrong identity, unexpected origin, scope expansion, CAPTCHA/phone confirmation, and
  authority corruption are security/operator-only classes with immediate durable attention; ordinary
  seat/provider/artifact failures are recoverable inside the bounds above.

## Maturation plan

- **test-agent-live:** run the complete synthetic Anthropic-direct and Google identity fixture
  matrix through the real AgentServer composition, including every refusal, crash boundary, and
  secret-scrubbing assertion; no real credential enters a fixture.
- **dev-agent-live:** promote only Echo to approval mode after a disposable identity completes the
  exact path being enabled, including one restart recovery and one cancellation during active work.
- **fleet:** remain `enabled:false` and `dryRun:true` until the graduation criterion passes; fleet
  enablement remains an explicit later release/config decision.
- **graduation criterion:** at least 10 identity-correct disposable repairs over 30 days on the exact
  provider/framework path, zero wrong-identity/origin/scope/secret events, no challenge-rate increase
  above manual baseline, successful restart/cancel recovery, and zero repository test failures.
- **dark-window:** minimum 30 days development-agent-only for each provider path; any security event
  resets the window and disables that path pending verified-operator review.

## Open questions

*(none)*
