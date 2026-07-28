---
title: "Subscription account email invariant and honest follow-me recovery"
slug: "subscription-account-email-invariant"
author: "Instar Agent (instar-codey)"
parent-principle: "Capacity Safety — No Unbounded Self-Action"
parent-principle-fit: "The incident combined a malformed identity record with an autonomous retry that could fire forever under an unchanged failure. Provider-attested email closes the malformed-record ingress; durable finite backoff proves the follow-me self-action converges under sustained failure."
eli16-overview: "subscription-account-email-invariant.eli16.md"
lessons-engaged: "P1,P2,P4,P7,P8,P10,P14,P19,P20,P21,B22,B28"
review-convergence: "2026-07-24T00:54:26.533Z"
review-iterations: 6
review-completed-at: "2026-07-24T00:54:26.533Z"
review-report: "docs/specs/reports/subscription-account-email-invariant-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 13
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Echo (Slack C0BA4F4E0FP, 2026-07-23)"
approval-basis: "Direct build authorization for this exact incident class: prevention/backfill, honest matrix and enroll-start surfaces, repeated-409 parking, and full instar-dev ceremony. Review convergence refined mechanisms without expanding the authorized outcome."
---

# Subscription account email invariant and honest follow-me recovery

## Problem statement

On 2026-07-23 a real subscription-pool record (`gearfinity3d`) existed with
`email: null`. Follow-me enrollment deliberately fails closed when it cannot
derive the operator-approved email, because accepting a freshly authenticated
credential without an expected identity could enroll the wrong account.
Consequently one malformed registry record blocked every correct path:

- the account-machine matrix returned a generic 409 and rendered “details
  couldn’t be resolved,” hiding the repair;
- the delivered-mandate consumer retried the same 409 every minute across four
  mandates for hours;
- a correctly completed provider sign-in was held as
  `missing-expected-email`, even though its credential was valid.

The operator repaired production by adding the known email to the record. This
spec makes that invariant structural, repairs resolvable legacy records, tells
the operator the actual fault, and bounds repeated identical retries.

## Reader model

- **Follow-me** re-mints the same account login on another operator-owned
  machine; credentials are never copied.
- A **mandate** is PIN-approved, signed, expiring enrollment authority.
- A **holder** is a machine reporting an account record.
- A **slot tenant** is the provider identity currently authenticated in one
  local config-home credential slot.
- The **matrix start-cell** is the dashboard action for one account-machine
  intersection.
- HLC/record version and evidence hashes supply causal change without comparing
  wall clocks across machines.

## Goals

1. Every newly registered `SubscriptionAccount` has a non-blank email.
2. Registration resolves the slot tenant through a provider-specific identity
   oracle even when the caller supplies an email. Caller email is a hint that
   must canonically match the attested result, never identity authority.
3. A one-shot startup sweep backfills existing email-less local records from
   their own credential slots when resolvable, without copying credentials or
   guessing identity.
4. Follow-me 409 responses carry a stable machine-readable class and plain,
   operator-actionable text naming the missing account-record email.
5. The account-machine matrix displays that real fault and repair direction.
6. The delivered-mandate consumer makes at most four autonomous attempts for
   one unchanged failure episode, then parks durably.
7. Only causal email-evidence repair wakes a parked identity-failure episode.
   Duplicate/new delivery and alternating failure classes cannot reset it.

## Non-goals

- Replicating or transporting provider credentials between machines.
- Inferring an email from account id, nickname, request body, or user prose.
- Weakening the follow-me expected-email validation gate.
- Automatically completing a held login whose expected identity was absent at
  the time of validation. The operator starts a fresh correctly-bound flow.

## Proposed design

### 1. Structural registry invariant

`SubscriptionAccount.email` becomes a required canonical string. The old
public `AddAccountInput`/`SubscriptionPool.add()` identity-creation contract is
retired. Callers use `RegistrarRegisterInput`, whose optional `email` is a hint,
not authority. A module-private `CompleteAccountCommitInput` contains the
registrar-verified email and is accepted only by
`commitCompleteAccount()`. This final persistence boundary validates that the
verified value is nonblank, structurally valid, control-free, and at most 254
characters before any write.

`SubscriptionPool.add()`, `SubscriptionPool.update()`, and the public PATCH
route no longer accept raw email. One oracle-owning
`SubscriptionAccountEmailRegistrar` performs verification and durable commit
inside the same method call; it never exports a transferable attestation:

```ts
register(input, callerEmailHint?)
repairLegacy(accountId)
completeValidated(loginId, expectedEmail)
refreshAfterCredentialWrite(accountId)
```

Each method resolves provider identity itself, applies the path-specific
binding/match rules, then invokes the pool’s module-private complete-account
commit closure. No queue, worker, serialized token, or cross-process boundary
exists between proof and commit. Generic pool mutation cannot write identity.
Before the oracle call, the registrar captures the credential-location
ledger’s slot epoch/fingerprint. Immediately before commit it re-reads and
CAS-compares that epoch. A changed slot discards the stale proof and re-probes
once; a second change fails `credential-changed-during-proof`. A credential
swap inside the 10-second oracle window therefore cannot bind stale identity.
One `AgentServer` process owns pool writes by architecture. If Instar later
supports multiple API writer processes, this registrar contract must first move
the epoch/CAS and commit under a durable single-writer lease or database
transaction; call-stack locality alone is not claimed safe in that topology.
Startup refuses a configured multi-writer API topology unless that durable
lease/transaction capability is present, and a wiring test ratchets the
refusal. Module privacy is encapsulation, not the security authority; the
single-writer invariant plus slot-epoch CAS is the authority.

One normalizer is used by attested write, oracle output, peer conflict
comparison, and completion validation: trim for stored display, derive a
lowercase comparison key, reject ASCII controls, require one non-edge `@` with
non-empty local/domain parts, and enforce the 254-character bound. Instar treats
provider email as a provider-scoped account identifier, not universal RFC
mailbox equivalence: Gmail dots/plus aliases and Unicode domains are not
rewritten, and provider-returned casing is preserved for display.
Throughout this spec, “canonical” means only this Instar
`providerEmailComparisonKey`; it does not claim mailbox/provider
canonicalization.
Loading old on-disk version-1 records remains tolerant so reconciliation can
repair them.

### 2. Registration-time oracle backfill

The direct `POST /subscription-pool` registration route becomes asynchronous,
waits for its oracle result, and returns 201 or 400 (never 202). It uses:

```ts
interface SubscriptionIdentityOracle {
  resolve(input: {
    provider: SubscriptionProvider;
    framework: SubscriptionFramework;
    configHome: string;
  }): Promise<
    | { resolved: true; email: string; subject?: string }
    | { resolved: false; code:
        'unsupported-provider' | 'credential-unavailable' |
        'profile-unavailable' | 'invalid-email' }
  >;
}
```

One provider registry wraps the shared underlying identity oracle. The existing
`CredentialIdentityOracle.resolveSlotTenant(configHome)` is the
Anthropic/Claude adapter; the credential ledger and enrollment wizard receive
that same underlying instance. Providers without an installed identity adapter
are refused with the stable
`subscription-account-identity-provider-unsupported` code; the route never
pretends the Anthropic profile endpoint can identify an OpenAI, Google, or
Copilot slot.

The oracle runs whether or not the caller supplied email. A supplied value is a
non-authoritative hint and must canonically equal the attested email. Mismatch
produces `subscription-account-email-mismatch` and no write. A usable attested
result is committed inside `registrar.register()`; no raw resolved email
reaches `SubscriptionPool.add()`. Unavailable or thrown oracle produces a 400:

```json
{
  "error": "subscription account email could not be resolved from its credential; sign in to this account slot and try again",
  "code": "subscription-account-email-unresolved"
}
```

The request body never supplies identity authority to the oracle or follow-me
gate. Validated enrollment completion calls
`registrar.completeValidated()`, which performs the identity check and commit
in one registrar-owned flow. Existing non-Anthropic enrollment flows use their own
provider-specific oracle before registration; unsupported providers fail
honestly instead of persisting an unverifiable identity.

`subject` is an optional provider-stable account identifier. A complete record
may store credential-free `identitySubject?: { provider, subject }` when an
adapter supplies it, and later repairs must match it. Anthropic currently
returns email only; future adapters must supply and compare subject when their
API exposes one. Migration from email-only is additive on the first attested
refresh.

For Anthropic email-only identity, an attested email change on an already-known
record is never silently migrated. It marks identity conflict/needs-reauth and
requires operator re-enrollment; only a legacy-missing record may acquire its
first email through repair. Background polling cannot rewrite expected
identity after provider email change/reuse.

Email-only identity is accepted for Anthropic solely because its current
profile API exposes no stronger pool identity. Suspected provider email
change/reuse moves the account to **Needs sign-in** with “The provider reports a
different email for this account.” The operator uses the existing matrix
**Sign in** action; the freshly authenticated email is held for explicit
same-account re-enrollment and never auto-migrates continuity from the old
email.

Residual risk is explicit: email can be renamed, recycled, aliased, or shared
across provider contexts. When Anthropic exposes a stable subject, the first
subject-bearing refresh does not silently bind it to an email-only record; it
requires explicit same-account re-enrollment, then persists the subject for all
future comparisons.

Provider-specific risk acceptance: if Anthropic recycles an email, email-only
continuity could otherwise bind the pool label to a different provider account.
The mismatch/needs-reauth/re-enrollment rules bound that risk. Stable subject
support becomes mandatory once Anthropic exposes it, with the explicit
re-enrollment migration above.

The oracle retains its 10-second request bound. Timeout/unavailability writes
nothing and returns the stable 400. Caller retry is appropriate only after a
credential/login repair. If a client retries after an uncertain response, an
exact duplicate (same id, provider, framework, configHome, and canonical
attested email) returns the existing resource as a successful no-op; any
disagreement is 409.
Duplicate detection happens only after fresh attestation. If provider identity
changed between attempts, the second request is 409/needs-reauth, not an
idempotent replay.

Compatibility: the direct registration route is currently used by API/manual
callers and integration tests; the dashboard enrollment flow uses
`POST /subscription-pool/enroll` plus completion, not this route. The direct
route already returns synchronous 201/400 rather than 202, so only latency
changes. The CLI/capability documentation and tests are updated to allow the
10-second bound and the new stable error codes. Clients must tolerate a delayed
201/400 up to that bound. Timeout is a 400 with no partial record; retry after
credential repair returns either the created resource or the exact-duplicate
successful no-op above.

Provider capability matrix:

| Provider/framework | Identity adapter | Stable subject | Admission posture |
|---|---|---|---|
| Anthropic / Claude Code | OAuth profile oracle | unavailable today | Email-only provider-scoped identity; explicit downgrade risk because no stronger provider field exists |
| OpenAI / Codex | not implemented in this lane | unknown | Refuse registration |
| Google / Gemini | not implemented in this lane | unknown | Refuse registration |
| GitHub Copilot / pi | not implemented in this lane | unknown | Refuse registration |

### 3. Bounded one-shot legacy reconciliation

Add a dependency-injected `backfillSubscriptionAccountEmails()` helper:

- enumerate local pool records whose email is absent/blank;
- for each non-empty `configHome`, call the existing identity oracle;
- on a candidate, call `registrar.repairLegacy(id)`, which re-resolves identity,
  atomically persists, and emits the normal redacted metadata update; backfill
  never receives a generic email-write seam;
- on unavailable/throw, return a scrubbed enumerated reason class containing
  account id only; never propagate or log raw oracle error messages, credential
  responses, or tokens;
- remain idempotent: a second run sees no candidate after successful repair.

Server boot constructs one shared provider-dispatched oracle and attaches the
metadata replication emitter before repair writes. The HTTP server does begin
serving health, dashboard assets, and read routes immediately. Exactly these
mutation routes await the initial barrier:

- `POST /subscription-pool`
- `POST /subscription-pool/:id/repair-email` (PIN-gated mobile repair)
- `PATCH /subscription-pool/:id` with `email` is always refused; the dedicated
  registrar repair operation is barrier-gated
- `POST /subscription-pool/enroll/:id/complete`
- `POST /subscription-pool/follow-me/enroll/:id/complete`
- `POST /subscription-pool/follow-me/enroll/start`
- `POST /subscription-pool/matrix/start-cell`

They carry route capability tag `requiresEmailReconciliation:true` and return
retryable 503
`subscription-account-email-reconciliation-running` until the barrier settles.
Middleware enforces the tag; integration inventory proves every identity
mutation path is tagged, avoiding a second hand-maintained list. Classification
is inverted: every `/subscription-pool` write defaults to
identity-mutation/barrier-required unless explicitly registered
`readOnlyOrNonIdentity:true`; an unclassified new write fails the inventory
test. The
delivered-mandate consumer awaits the same barrier.

The barrier uses concurrency 3, preserves one bounded timeout per oracle call,
and has a 30-second whole-sweep deadline. Deadline/unresolved records fail
closed into the honest missing-email surface; server availability is not held
hostage. It logs aggregate repaired/unresolved counts only.

At deadline the global barrier settles as `degraded`, with each unfinished row
materialized in `emailGaps` as `reconciliation-timeout`; mutation routes stop
returning the global 503 and apply their normal per-record fail-closed contract.
The PIN-gated repair route performs a fresh bounded oracle attempt—it does not
merely replay the boot result—so a provider that recovers after the deadline is
repairable immediately.

Running response example:
`503 { code:'subscription-account-email-reconciliation-running',
retryable:true, emailReconciliation:{state:'running'} }`.
After deadline, the same account returns
`409 { code:'account-record-missing-email', repairRequired:true,
emailReconciliation:{state:'degraded', repairRunsFreshProbe:true} }`.
Dashboard and HTTP client tests assert this exact transition.

`GET /subscription-pool` and the Subscriptions dashboard expose
`emailReconciliation: { state:'running'|'degraded'|'complete',
unresolvedCount, repairRunsFreshProbe:true }`. The dashboard explains the
running 503 → degraded per-record 409 transition in plain language.

The boot pass is genuinely one-shot and creates no recurring provider-call
loop. Later repair runs only on a concrete new evidence epoch: a credential
write or completed login for that exact configHome. An unchanged quota/identity
poll does not call the oracle again.

Runtime types remain honest:

```ts
type LegacyStoredSubscriptionAccount =
  Omit<SubscriptionAccount, 'email'> & { email?: string | null };
type SubscriptionAccount = /* normal fields */ & { email: string };
type SubscriptionAccountRead =
  | { emailState: 'known'; account: SubscriptionAccount }
  | { emailState: 'legacy-missing'; account: LegacyStoredSubscriptionAccount };
```

The loader retains gaps in a quarantine collection exposed through
`listEmailGaps()`. `GET /subscription-pool` keeps `accounts` as complete rows
and adds `emailGaps: [{ emailState:'legacy-missing', id, nickname, provider,
framework, status, machineId, machineNickname }]` with no configHome. Pool-scope
aggregation merges that additive array. The matrix merges gap ids into account
rows and renders the missing-email repair state. The resolver receives both
complete accounts and gap ids, so it distinguishes missing-email from
not-found. `locallyExecutable()`, selectors, enrollment authority, and
replication writes use only complete accounts.

Before repair, known `identityDrifted` rows are refused. The oracle proves the
credential currently in the slot; independent account binding requires the
local credential-location ledger to map that exact configHome to the same
account id. Unanimous peer-holder email is corroboration/conflict detection
only and can never substitute for local binding, so poisoned legacy replication
cannot launder identity. Without local binding, repair returns
`account-binding-unproven` and writes nothing. Email is sufficient for the
currently supported Anthropic provider because its profile API exposes no
separate stable subject used by the pool; a future adapter exposing a stable
subject must include and compare it.

The credential-location ledger is written only by provider-oracle audit and the
credential-write funnel, with its own slot epoch and atomic store; it is not
seeded from `SubscriptionPool.email`. A malformed legacy pool row therefore
cannot create its own binding evidence. Repair reads the ledger mapping and
CAS-checks its epoch around the profile probe.

Repair is transactional: candidate state is written atomically before the
in-memory store changes or metadata replication emits. Persistence failure
throws a typed error, leaves memory/disk/replication unchanged, and reports the
scrubbed `persistence-failed` result. This tightens the current `save()` path,
which silently swallows write errors.

During rolling upgrade an old writer may still emit malformed metadata. New
readers preserve quarantined visibility but never use it as authority. Its
owning machine repairs it on upgrade/start or a concrete credential-write
epoch; another machine never probes a credential that is not physically local.

### 4. Honest follow-me refusal

`resolveFollowMeEnrollTarget()` gathers every matching local and peer holder
record. Replicated metadata comes only from authenticated, registered
same-operator pool peers, but remains low-impact reference data: it becomes
usable as expected-identity evidence only when every nonblank holder email
canonically agrees. It returns:

- `account-record-missing-email` when the id is known but no matching holder
  carries a valid email;
- `account-record-email-conflict` when local/peer holders disagree;
- `account-not-found` when no matching account exists;
- a resolved target only for one canonical unanimous email.

Input order never changes the verdict. Conflict is fail-closed and tells the
operator to repair the disagreeing account records; last-writer-wins metadata
is never silently promoted into enrollment authority.

The enroll-start and matrix routes map the missing-email reason to:

```json
{
  "error": "This subscription account record is missing its email. Repair or re-enroll the account, then try again.",
  "code": "account-record-missing-email",
  "repairRequired": true
}
```

The matrix client renders the server message for this code:
“This account record is missing its email. Repair or re-enroll the account,
then try again.” It does not replace all 409s with generic text.

“Repair” is a real mobile-complete action: the matrix/account card shows
**Repair account identity**, asks for the dashboard PIN, and calls
`POST /subscription-pool/:id/repair-email`. The PIN-gated, barrier-tagged route
invokes `registrar.repairLegacy(id)`. Success is 200 with the complete account;
unproven binding or unavailable identity is 409 with stable code/message;
unsupported provider is 400. No email is typed into the form.

The conflict class returns 409 `account-record-email-conflict` with “This
account has conflicting emails on your machines. Repair or re-enroll the
account records, then try again.” The not-found class returns 404
`subscription-account-not-found` with “This subscription account is no longer
registered.” Both carry `repairRequired:true`.

### 5. Durable pair-scoped backoff

Add a dedicated atomic `FollowMeConsumerBackoffStore`, keyed by
`targetMachineId + accountId`, not mandate id:

```ts
{
  key: string;
  episodeLane: 'non-identity' | 'identity';
  lastFailureClass: string;
  consecutiveFailures: number;
  lastAttemptAt: string;
  nextAttemptAt: string | null;
  breakerOpen: boolean;
  breakerOpenedAt: string | null;
  emailEvidenceKey: string;
  authoritySetKey: string;
  lastWakeEvidenceKey: string | null;
  evidenceHashVersion: 1;
  updatedAt: string;
}
```

The store writes through temp-file + fsync + rename (using the repository’s
established safe atomic-file primitive) and owns
`recordConsumerFailure(pair, class)` and `clearOnSuccess(pair)`. One sweep
groups all valid delivered mandates by pair, chooses the newest still-valid
authorization as provenance for at most one attempt, and consults one shared
backoff row. Four mandates for one broken pair therefore produce one attempt,
not four.

Every autonomous failure belongs to one finite pair episode. The episode starts
`non-identity`; a missing/conflicting-email result monotonically promotes it to
`identity`. It can never demote. Transport, service, and other classes update
`lastFailureClass` but share the same counter and never reset it. This fixed
shape preserves one breaker under arbitrary class alternation while selecting
the stricter identity wake whenever identity has appeared. Delays are
deterministic and bounded:

| Consecutive failures | Next eligible attempt |
|---:|---:|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4 | parked — no next timer |

Ticks before `nextAttemptAt` skip the whole pair. A successful 201 clears retry
metadata. After failure four, `breakerOpen:true` is durable and there is no
timer edge: K=4 regardless of time horizon.

Rows store fixed-size `emailEvidenceKey` and `authoritySetKey` hashes. A parked
identity episode wakes only when email evidence changes and resolves unanimously.
A non-identity episode wakes only when the target observes a changed set of
signature-valid, unexpired mandate ids—causal authority measured locally, with
no cross-machine timestamp comparison. Duplicate delivery leaves the set hash
unchanged. A delayed but still-unexpired unseen authorization is valid and may
wake one new finite non-identity episode; expired authority never does.

On wake, the exact triggering hash is persisted as `lastWakeEvidenceKey` before
the breaker clears. The same evidence version can open at most one
post-breaker episode; another wake requires a distinct hash generation.

Only PIN-originated operator mandates qualify for non-identity wake, and an
outer pair cap permits at most three such post-breaker wakes per rolling 24
hours. After the cap, even new mandates leave the breaker parked until the
operator repairs the underlying account/service state; this bounds buggy
upstream mandate production across episodes, not merely inside one episode.

`emailEvidenceKey` hashes sorted tuples
`(machineId, accountId, recordVersionOrHlc, emailState,
canonicalComparisonKeyOrMissing)`. Local repair increments record version; a
late peer observation changes holder set/HLC. Either causes a real transition
even when the eventual canonical email text already exists elsewhere.

Hash change alone never wakes identity. The controller persists the resolver
verdict and wakes only on the semantic transition
`missing|conflict -> unanimous-resolved` for that pair. Version/HLC churn while
remaining missing, conflicting, or already resolved cannot re-arm it.

A provider/profile outage is `non-identity`, not missing/conflicting identity.
When repaired email wakes an identity episode and the subsequent provider call
is temporarily unavailable, that outcome starts one new non-identity episode
whose valid-authority-set wake applies; it cannot strand the repaired account
behind an unchanged identity hash.

Server restart, clock rollback, invalid/future timestamps, and alternating
failure classes never make an attempt eligible earlier. Malformed timestamps
fail closed as parked until lane-appropriate causal wake evidence exists. The route’s
`repairRequired:true` is the operator contract; the controller’s bounded
self-heal is separate from blind caller retry.

Formal controller transitions:

| Current | Event | Guard | Next | Action |
|---|---|---|---|---|
| absent | failure(class) | valid unexpired mandate | episode count 1, lane from class | persist; nextAttempt=+1m |
| waiting count 1–2 | failure(class) | eligible time | count+1; promote lane to identity if needed | persist +5m/+15m |
| waiting count 3 | failure(class) | eligible time | parked count 4 | persist breaker; no timer |
| any open episode | 201 success | valid response | absent | atomically clear row |
| parked identity | email evidence changed | now unanimous valid identity | absent | clear; next tick may start one new episode |
| parked non-identity | authority-set hash changed | contains valid unexpired authority | absent | clear; next tick may start one new episode |
| parked | duplicate/irrelevant evidence | hash unchanged or wrong wake class | parked | no call, no write |
| waiting/parked | mandate expiry | no valid authority remains | unchanged but ineligible | no call |
| any | malformed persisted time/hash version | validation failure | parked | canonical fail-closed rewrite |

## Decision points touched

| Decision | Classification | Justification / authority |
|---|---|---|
| Admit a new pool record without provider-attested canonical email | `invariant` | Email is a required identity field. The domain is enumerable: a supported oracle attests one canonical email or reject. |
| Accept caller email / unsupported provider | `invariant` | Caller email is hint-only and must match attestation; a missing provider adapter refuses. |
| Backfill from a credential slot | `invariant` | Durable non-drifted configHome binds candidate id; provider oracle attests current tenant; peer evidence, when present, must agree. |
| Expose/select a legacy record | `invariant` | Discriminated legacy rows stay operator-visible but cannot enter complete-account selectors or enrollment authority. |
| Commit and replicate repair | `invariant` | Durable atomic write succeeds before memory mutation or replication emission. |
| Mutate an existing email | `invariant` | Generic update/PATCH cannot; only the oracle-owning registrar can mint an attestation recognized by the pool commit seam. |
| Run reconciliation | `invariant` | One boot pass plus one run per concrete credential-write/login-completion evidence epoch; unchanged polls do nothing. |
| Resolve multiple holder emails | `invariant` | Canonical unanimity is required; absence/conflict fails closed without order-dependent judgment. |
| Permit follow-me enrollment | `invariant` | Existing expected-email safety authority remains fail-closed; this change improves reason classification only. |
| Delay/park consumer failures | `invariant` | Fixed pair schedule, K=4 breaker, unexpired authority, and causal wake conditions are enumerable. |
| What the operator sees | `invariant` | Stable server code selects a predefined truthful message; no message-intent judgment is involved. |
| Introduce a new detector or authority | `invariant` | None is introduced: structural validation and bounded controller state feed the existing enrollment authority. |

## Controller convergence argument

Control-loop edge: an eligible account-machine pair with at least one valid
delivered mandate triggers one enroll-start attempt. Any failure advances its
named finite lane’s
durable state monotonically through 1m, 5m, 15m, then parked.
The controller cannot fire more than once per pair per stored `nextAttemptAt`,
and its single-flight prevents overlap.
Steady state has no firing edge after at most four attempts per broken pair,
regardless of mandate count or failure-class alternation. Success clears the
episode; lane-appropriate causal evidence opens one new finite episode.
This behavior is covered by the repository’s self-action convergence ratchet
and focused fake-clock tests.

One extracted `FollowMeConsumerController` is the lifecycle owner for boot,
tick, pair grouping, evidence observation, attempt, response classification,
breaker/wake, and stop. It receives injected clock, backoff store, delivered
mandates, peer/local evidence reader, and enroll driver. `AgentServer` only
starts/stops it. The older inline
`AgentServer.driveDeliveredFollowMeEnrollments()` is removed, and
`runFollowMeConsumerSweep` delegates to this controller or is removed—there is
never a parallel second owner.

## Multi-machine posture

- Account metadata, including email, is **replicated** through the existing
  `subscription-account-meta` coherence-journal projection. Successful local
  backfill emits the normal metadata update.
- Credential probing is **machine-local BY DESIGN** because the credential
  physically lives in that machine’s config-home slot.
  `machine-local-justification: physical-credential-locality`
- Consumer retry state is **machine-local BY DESIGN** on the target
  that physically owns and drives the login.
  `machine-local-justification: physical-credential-locality`
- Operator wording is returned through the existing pool-scoped dashboard
  proxy; no generated URLs are added.
- No new user-facing notice source is added, so one-voice notification gating
  is not applicable.

## Security and privacy

- The oracle is the only source allowed to backfill from a credential.
- No token, credential blob, or raw provider response enters the registry,
  response, logs, or retry metadata.
- Request-supplied email is a hint only; provider attestation must match it.
- Peer metadata must be canonically unanimous before it contributes
  expected-identity evidence.
- Missing identity always fails closed.
- Retry metadata contains pair id, versioned email/authority evidence hashes,
  lane/class, counts, and timestamps only. Scrubbed diagnostics expose holder
  count, valid/invalid count, agreement boolean, source machine ids, hash
  version, breaker state, and next-attempt time—never raw emails.

## Compatibility and migration

The on-disk pool schema remains version 1 with the explicit internal legacy
union described above.
No destructive rewrite occurs. Successful reconciliation repairs use the
registrar’s attested commit and normal replication. Unresolvable legacy records remain readable but
are not usable for follow-me until repaired, and all refusal surfaces say why.

Mixed-version behavior is explicit: old writers may still create malformed
records until upgraded; new readers preserve quarantined visibility but never
use missing/conflicting email as identity authority. One-shot repair runs as
each holder upgrades, without unsafe LWW identity selection.

Existing tests and fixtures that construct pool accounts must provide emails,
except fixtures explicitly exercising legacy-load migration.

## Testing

### Unit

- registrar registration rejects absent/unavailable attestation, blank/malformed
  provider email, and caller-hint mismatch.
- the private complete-account commit rejects invalid verified input; generic
  `SubscriptionPool.update()` has no email mutation surface.
- legacy email-less JSON loads for repair.
- canonical email validation covers case/whitespace, controls, oversize, and
  malformed addresses;
- backfill repairs resolvable records, skips complete records, records
  unavailable outcomes, and is idempotent.
- resolver distinguishes missing-email, conflict, and not-found; local/peer
  order reversal produces the same result.
- backoff store persists atomically, advances, clears only on success, and
  survives restart.
- fake-clock schedule reaches the parked K=4 steady-state bound, handles
  invalid/future times and clock rollback, and never becomes eligible early.

### Integration

- direct registration with or without email requires oracle attestation;
  mismatch/unavailable/unsupported provider writes nothing.
- public PATCH with arbitrary email writes nothing; oracle
  mismatch/unavailability writes nothing; registrar-attested correction
  succeeds and replicates; generic update cannot mutate identity.
- a repository invariant enumerates every `SubscriptionAccount.email` write
  site and permits only registrar commit plus tolerant legacy load; any new
  bypass/export/test-helper mutation fails CI.
- enroll-start missing-email 409 includes exact code/message and
  `repairRequired:true`.
- matrix local and proxied 409s preserve the stable code and actionable text.
- dashboard cell renders the server-classified missing-email message.
- bounded initial reconciliation gates mutation/consumer paths without blocking
  health/read serving and emits replicated updates.

### Lifecycle / controller

- four mandates for one pair produce one aggregate attempt per eligibility
  window.
- process restart retains `nextAttemptAt`.
- successful drive clears the episode.
- duplicate or fresh mandate delivery does not wake/reset an identity breaker;
  a changed valid authority-set hash may wake one non-identity lane episode.
- alternating failure classes do not reset it.
- alternating identity↔transport results preserve one counter/breaker; identity
  promotion is monotonic and only email evidence wakes the promoted episode.
- repaired unanimous email evidence wakes exactly one new finite episode.
- authority expiry prevents every attempt after the mandate door closes.
- the controller is registered in `SELF_ACTION_CONTROLLERS` with durable
  restart state, finite K, causal wake, and sustained-pressure ratchet coverage.
- `tests/unit/self-action-convergence.test.ts` remains green.

### Repository gates

Run focused suites, affected smoke, full unit suite, typecheck, lint,
repository invariants, docs coverage, and CI including e2e.

## Acceptance criteria

1. No public registration path can persist a new account without email.
2. A valid supported-provider credential supplies the canonical email at
   registration or during bounded reconciliation.
3. Unresolvable identity causes no registry write and returns a named,
   actionable fault.
4. Follow-me completion never validates against an absent expected email.
5. Repeated failures converge after at most four autonomous attempts per broken
   account-machine pair and remain restart-safe.
6. Repair evidence wakes one bounded episode without manual state-file editing.
7. All existing security, replication, enrollment, dashboard, and
   self-action-convergence tests remain green.

## Rollback

Revert the runtime change and ship the next patch. Backfilled emails are valid
provider-attested metadata and need not be removed. The separate backoff file
is ignored by older binaries and may remain, but an old consumer resumes
once-per-minute retries and an old writer reopens malformed admission.
Operational rollback therefore first disables account-follow-me consumer
driving, rolls back, and only re-enables it after the fix is restored or all
records are verified. No credential or irreversible external state is created
by reconciliation.

## Frontloaded Decisions

| Decision | Chosen value | Authority | Reversibility |
|---|---|---|---|
| Development tier | Tier 2 | `instar-dev` risk floor plus agent judgment delegated by the operator | Process-only; no runtime effect |
| Email normalization | Preserve trimmed provider-returned display; lowercase comparison key; controls, malformed shape, and >254 refused; no Gmail dot/plus or Unicode rewriting | Provider email is a provider-scoped identity string, not universal mailbox equivalence | Code revert; display value remains intact |
| Provider/hint authority | Provider oracle attests; caller email is match-checked hint; unsupported provider refuses | Credential is the current identity authority | Add provider adapters later without schema change |
| Existing-email mutation | Remove email from generic update/PATCH; one registrar owns oracle and opaque attestation writes | Prevent caller-controlled expected-identity poisoning | Registrar API can evolve; arbitrary string mutation remains forbidden |
| Legacy representation | Internal optional-email union plus quarantined discriminated read; normal account type requires email | Type-safety and fail-closed selector invariant | Revert type split after fleet data is fully migrated |
| Repair trigger | One boot pass plus a concrete credential-write/login-completion evidence epoch; never unchanged polling | Finite-action / physical credential locality | Disable trigger; provider-attested repairs remain valid |
| Repair barrier | concurrency 3, per-call 10s, whole sweep 30s; enumerated mutation routes wait | Availability balanced against fail-closed identity admission | Config/code revert |
| Persistence order | Atomic disk commit before memory mutation and replication | Durable-state integrity invariant | Revert possible but would reopen acknowledged data-loss class |
| Holder conflicts | All valid canonical holder emails must agree | Low-impact peer metadata cannot be promoted by LWW/order | Conflict policy can be tightened, not silently weakened |
| Error contracts | Exact missing/conflict/not-found status, code, and plain repair message | Mobile-complete honest operator surface | Additive response evolution possible |
| Consumer control | Pair key; 1m/5m/15m then K=4 parked; no attempt after mandate expiry | P19 finite self-action convergence | Disable consumer or remove its state file after rollback |
| Breaker wake | Identity lane: changed unanimous email evidence. Other lanes: changed target-observed valid authority-set hash. | Causal progress without cross-machine timestamp ordering | New wake evidence may be added only if equally causal and bounded |
| Rollout | Default-on invariant for upgraded writers; mixed-version legacy reads quarantine | Operator’s requested structural prevention | Rollback sequence disables consumer first |

## Lessons engaged

- P1/P2: carry the real incident through durable evidence and make every
  non-cheap decision before build.
- P4/P7/P8: preserve the single provider identity authority, keep failure
  states explicit, and test the real HTTP/dashboard path.
- P10/P14: repair the class at the persistence boundary and keep multi-machine
  metadata provenance/conflict explicit.
- P19/P20/P21: finite controller convergence, evidence before action, and no
  authority beyond mandate expiry.
- B22: establish one controller lifecycle owner rather than parallel inline and
  helper sweep paths.
- B28: preserve honest pre-authorization/convergence posture; the spec remains
  unapproved until its convergence report is complete and operator approval is
  recorded.

LLM supervision tier is 0: provider identity, canonical email admission,
conflict refusal, persistence order, and retry convergence are closed
deterministic invariants. An LLM must never become email identity authority.

## Maturation plan

- **test-agent-live:** unit/integration/fake-clock coverage plus a Tier-3 boot
  test using a real temporary pool file, delayed oracle, route barrier, restart,
  four mandates, controller stop, and dashboard rendering.
- **dev-agent-live:** default-on for the development agent; capture aggregate
  boot repair counts and scrubbed controller transitions, with no raw oracle
  error or email in controller logs.
- **fleet:** normal patch-train rollout after dev evidence; legacy reads remain
  quarantined and repair is non-destructive.
- **graduation criterion:** at least one real legacy repair or a clean zero-gap
  boot, no repeated per-minute identity 409s, no selector seeing a legacy gap,
  and no false conflict/provider-adapter mismatch.
- **dark-window:** none — this load-bearing writer invariant is default-on;
  fleet promotion waits for dev evidence and any failure holds fleet rollout.

## Alternatives considered

- **Placeholder email:** rejected because it defeats the identity safety gate
  while merely satisfying field presence.
- **Require the operator to type email:** rejected as sole authority because
  the authenticated slot can attest its own identity and request input can be
  stale or poisoned. Typed email remains a match-checked hint.
- **Permanent mandate parking:** rejected because a repaired record should
  recover without state-file surgery or another operator ceremony.
- **Per-mandate backoff:** rejected because duplicate mandates multiply load for
  one underlying account-machine fault.
- **Generic job/workflow engine:** rejected because this is tiny-cardinality,
  machine-local controller state and the repository already uses atomic
  file-backed follow-me stores. A workflow engine adds migration/authority
  surface without strengthening finite convergence.
- **Generic idempotency/circuit-breaker primitive:** transport idempotency does
  not model pair identity evidence or mandate expiry, while existing
  in-process breakers do not survive restart. This controller uses the standard
  finite-breaker pattern with an application-specific atomic state adapter and
  still registers in the shared self-action ratchet.
- **Small durable state-machine library:** no existing repository abstraction
  combines mandate expiry, semantic identity evidence, restart persistence, and
  pair aggregation. The extracted controller therefore uses a pure transition
  reducer plus the atomic store; tests exercise the reducer table directly so
  transition logic is not scattered through server callbacks.
- **SQLite / durable KV:** rejected for this lane because account and delivered
  mandate state already use repository-standard atomic JSON files, cardinality
  is bounded by account-machine pairs, and introducing a second transactional
  substrate would add schema migration and lock ownership. Temp+fsync+rename,
  single-writer refusal, and epoch CAS provide the required atomicity here.

## Glossary

- **Follow-me:** re-minting the same subscription account login on another
  operator-owned machine; credentials are never copied.
- **Mandate:** PIN-approved, signed, expiring enrollment authority.
- **Holder:** a machine reporting that it has an account record.
- **Slot / slot tenant:** a local config-home credential location / the provider
  identity currently authenticated there.
- **Matrix start-cell:** the dashboard action that sets up one account on one
  machine.
- **Authority-set hash:** a fixed-size digest of currently valid delivered
  mandate ids, used only as causal change evidence.

## Concrete lifecycle example

1. An old `gearfinity3d` row loads without email and appears in `emailGaps`;
   selectors exclude it.
2. Boot repair cannot prove local slot binding, so it writes nothing and the
   matrix states that the record is missing email.
3. Four delivered mandates for the pair aggregate into one attempt sequence
   (1m, 5m, 15m, parked), never four requests per minute.
4. The operator taps **Repair account identity**, enters the dashboard PIN, and
   the registrar verifies ledger epoch → provider profile → unchanged epoch,
   then atomically commits the first email and replicated metadata.
5. Record version/HLC changes the email-evidence hash; the parked identity
   episode wakes once, resolves one unanimous expected email, and starts the
   correctly-bound sign-in.

## Open questions

*(none)*
