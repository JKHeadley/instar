---
title: "Routing Spend — an operator surface for the money-layer master switch"
slug: "money-layer-operator-enable-surface"
author: "echo"
status: "draft"
parent-principle: "Mobile-Complete Operator Actions — A PIN-Gated Route With No Human Surface Is An Incomplete Feature"
eli16-overview: "docs/specs/money-layer-operator-enable-surface.eli16.md"
approved: true
approved-by: "operator (Justin), conversational approval in topic 46473, 2026-08-16 14:26 PDT"
---

# Routing Spend — an operator surface for the money-layer master switch

> **How to read this document.** Everything up to "Appendix A" is the **normative build
> contract** — what Phase 1 must implement. Appendix A is Phase 2 design, deliberately out
> of scope. Appendix B records why the design is shaped this way. Appendices are
> non-normative and are not part of what is being specified.

## Problem statement

Increment B of the Routing Control Room shipped the full paid-door arming flow — a caps
form, a server-rendered canonical plan, a PIN commit, a freeze control and a change log
(`POST /routing-spend/plan`, `/routing-spend/caps/adjust`, `/routing-spend/freeze`,
`GET /routing-spend/caps/log`) with a dashboard Spend tab rendering them.

Every one of those routes is gated on `routingSpend.money.enabled === true`, and **there
is no way for the operator to perform that enable.** The dashboard control sits *behind*
the switch; `PATCH /config` deliberately cannot set it (`routingSpend` is excluded from
`PATCHABLE_CONFIG_KEYS` because a Bearer token — held by the agent — must never reach
money state); no CLI sets it. The only path is hand-editing `.instar/config.json` on the
machine. The operator's report was exactly this: *"still has no path/mechanism to enable
any options."*

That violates **Mobile-Complete Operator Actions**: a PIN-gated route with no human
surface is an incomplete feature, not a finished API.

**Adding `routingSpend` to `PATCHABLE_CONFIG_KEYS` is the smallest diff and the wrong
fix** — it would let the agent switch on its own spending authority, collapsing the
requester ≠ authorizer separation the money layer exists to preserve. That exclusion is a
safety property and this spec does not weaken it.

---

# THE BUILD CONTRACT (Phase 1)

## 0. Glossary

Five terms do distinct work and are easy to conflate; this is the whole vocabulary.

| Term | One line |
|---|---|
| `intentEnabled` | the operator ASKED for the layer on (store flag OR config key) |
| `lifecycleState` | the CONSTRUCTION/probe state: `disabled` / `enable-pending-restart` / `probed` / `probe-failed` / `construction-failed` |
| `servingReady` | money MAY move: `intentEnabled && lifecycleState === "probed" && singleInstanceLockHeld` |
| `enforcementReady` | the API field for `servingReady` — identical by definition, never a proxy |
| `enableSources.state` | WHICH source enabled it: `disabled` / `operator-enabled` / `config-enabled` / `both-enabled` |

The trap the vocabulary exists to avoid: *asked for* (`intentEnabled`), *built*
(`lifecycleState`), and *permitted to spend* (`servingReady`) are three different facts, and
collapsing any two of them produces a surface that reports one while the spend path enforces
another.

## 1. Invariants

**MLE-1 — two inputs, one question.**
`intentEnabled = store.operatorEnabled === true || config.routingSpend.money.enabled === true`.
An OR, so neither source can silently disable what the other enabled. The four states are
enumerated and each has a declared operator-visibility:

| store | config | `enableSources.state` | Surfaced to operator? |
|---|---|---|---|
| false | false | `disabled` | normal — the enable control is shown |
| true | false | `operator-enabled` | normal — not a warning |
| false | true | `config-enabled` | **yes** — labelled as set by the config file, with a "mirror into store" action offered |
| true | true | `both-enabled` | informational only, in the detail view |

Recomputed at money-layer construction, on **every `GET /routing-spend/enable-status`**, on
every **plan render**, on every `GET /routing-spend/caps` read, and at each commit's
post-verify step.

**`enable-status` does NOT force a config reload.** It recomputes `enableSources` from the
current process snapshot and returns `configSnapshotAt` alongside it, so the operator can see
HOW FRESH the config half of the answer is rather than assuming it is live. Forcing a disk
re-read per status poll would be a disk hit on a polled route to chase a value the spec
already says is not an immediate control. The store half IS live.

The first two matter most and were missing from an earlier list: `enable-status` is the
always-visible pre-gate route that actually returns `enableSources`, so a config edit made
while the layer is disabled would otherwise be invisible or stale on the one surface the
operator is looking at; and plan rendering must recompute because the state chooses between
`money-layer-disable` and `money-layer-disable-store-only`. `GET /caps` is gated and cannot
be relied on as a recomputation point.

**Audited on TRANSITION, and only from paths that already write.** The state is recomputed
on every read, but **a read never writes** — `GET /routing-spend/enable-status` is genuinely
read-only, with no audit append and no `lastObservedSourceState` update. Making a polled GET
capable of audit writes would both contradict its contract and let dashboard polling drive
log volume.

So `lastObservedSourceState` is compared and updated only on paths that are already mutating:
**money-layer construction (boot) and each commit's post-verify step.** An
audit row keyed `enable-source-transition:<from>-><to>` is appended when the recomputed state
differs from the stored one. The cost of this choice, stated: a config edit adopted by
nothing is noticed at the next boot or adopt rather than at the next poll — acceptable,
because the operator-facing surface shows the current state and its `configSnapshotAt`
regardless of whether a row was written.

**MLE-2 — intent is not permission to spend.**

| Predicate | Means | Composed of |
|---|---|---|
| `intentEnabled` | the operator asked for the layer to be on | MLE-1 |
| `servingReady` | the enforcement layer is up, so paid calls may be attempted | `intentEnabled && lifecycleState === "probed" && singleInstanceLockHeld` |

- **Paid spend is gated on `servingReady`**, never on `intentEnabled`, in addition to the
  existing freeze and cap checks.
- **The single-instance lock is revalidated on every paid call AND before every money
  authority write or audit append** — not only on the spend path. §7's single-writer audit
  discipline depends on one process, and several routes are pre-gate and reachable even when
  the layer is off, so a process that lost the lock could otherwise still write. A lost lock
  fails closed: spend refuses, authority writes refuse, and authoritative audit appends
  refuse.

  **Freeze is the ONE exception, and it must be**, or the emergency stop would be the thing
  the lock takes away.

  **It is safe without the lock because freeze is MONOTONIC, and that is the whole argument.**
  §7's single-writer discipline exists to stop two processes producing an incoherent
  interleaving — but freeze is **set-true-only and idempotent**: two processes writing "frozen"
  concurrently cannot disagree, and there is no interleaving whose outcome is wrong. Concretely:

  - A freeze writes an **atomic durable marker per keyRef** (`freeze/<keyRef>`): write to a temp file, **fsync the file**, `rename` into place, then
    **fsync the containing directory**. `rename` alone gives atomic REPLACEMENT, not
    durability across a crash — the fsync pair is what makes the marker survive, and naming
    only `rename` was an overclaim. No read-modify-write, so no lost update.
  - **The spend path reads the freeze set from disk on every paid call** (§5), so whichever
    process holds the lock observes a marker written by one that does not — which is exactly
    the case that must work: a losing process freezing, and the lock holder honouring it.
  - **Unfreeze is NOT exempt** and requires both the lock and the PIN. Clearing is the
    non-monotonic direction, so it takes the full discipline; the asymmetry is deliberate and
    is the same one freeze/unfreeze already has.
  - If the audit append cannot be trusted, the freeze still applies and is recorded to the
    server log marked non-authoritative, with the operator told the row is provisional.
  - **T34** asserts the load-bearing case end to end: a freeze issued by a process that does
    NOT hold the lock stops spend in the process that does.

  **The lost-lock case needs its own reporting path, or the refusal would be unrecordable** —
  a refusal that cannot be audited because auditing is what is refused. So: when the lock is
  absent, the failure is returned to the caller AND written to the ordinary server log as a
  **non-authoritative** record explicitly marked as such. It is not an audit-channel row and
  must never be presented as one. The audit trail stays trustworthy precisely by refusing to
  accept rows it cannot vouch for.
- **What "reads current state" means for each of the two sources**, since they change by
  different mechanisms and an unstated answer here is exactly the symbol/state drift this
  spec exists to prevent:
  - **The store flag** is read live on every paid call. It is the source this surface writes,
    so a disable must take effect on the very next call.
  - **The config key** is read from the process's config snapshot; it is NOT re-read from
    disk per call. **The refresh latency is explicitly NOT bounded by this spec** — it
    depends on instar's existing config-invalidation behaviour, which varies by key and
    call path. Rather than assert a bound this spec cannot guarantee, the contract is:
    *a config-file edit is not an immediate control; use freeze for immediate effect.*
    Every surface that shows `config-enabled` state renders it as **"as of `configSnapshotAt`"**,
    so the operator is never shown a config-derived claim without its age, **and offers a
    refresh action — `POST /routing-spend/config-inspect`**, which REPORTS and adopts
    nothing. It returns `{ differs, configSnapshotAt, fields: [{ path, current, onDisk }] }`
    over the enumerated authority-bearing fields, so an operator who hand-edited the file can
    see that the edit has not taken effect, and exactly which values differ.

    **Bearer alone sees ONLY `routingSpend.money.enabled`.** The cap values under
    `routingSpend.money.limits.*` are the same data §7 withholds from a pre-gate reader, so
    returning them here would have handed the agent through one route exactly what the log
    filter denies it through another — the boundary is only as strong as its leakiest
    surface. Limits therefore require the PIN, and a Bearer-only inspect reports
    `differs`/`configSnapshotAt` for the enable flag alone, which is all that is needed to
    answer "has my edit taken effect?".

    It is **non-adopting inspection**: it mutates no authority, config or process state. It
    does append an audit row and advance rate-limit state, which is why it is a POST and why
    it is not called "read-only" — that term is reserved for `GET /enable-status`, which
    writes nothing at all (T32).

    **There is deliberately NO route that adopts on-disk config into the running process.**
    An earlier draft had one, plus a durable per-field overlay to stop a later global reload
    undoing it — with precedence rules, provenance tags, divergence handling and clearing
    semantics. Two successive convergence checks named that mechanism as the largest
    remaining architectural risk: it was a second configuration system growing inside a money
    feature, and it produced an effective-authority value that was neither the file nor the
    store.

    It is removed, because the problem it solved already has two better answers:

    | The operator wants… | The answer |
    |---|---|
    | to change money authority now | use the store flag — `money-layer-enable` or the disable actions. PIN-gated, plan-bound, effective immediately, no restart. This is the intended path. |
    | their hand-edit of `config.json` to take effect | **restart** — already specified here (§4), PIN-gated, and completable from a phone. |

    So a config edit is picked up the way every other config value is picked up: by the
    process reading it at start. No overlay, no precedence rules, no third value. MLE-1's two
    inputs stay the store flag (read live) and the config value as loaded at boot.
  - **This is stated to the operator rather than hidden:** the `config-enabled` surface says
    a config-file edit is not an immediate control, and points at **freeze** for anything
    that must take effect now. Freeze reads live, unconditionally.
- **Route visibility** is an explicit allowlist, not a predicate doing double duty. The
  single normative statement is the **route visibility matrix** in §2; no other section
  adds or removes an exception.
- **`moneyOn()` is removed, not redefined.** Its callsites migrate to whichever predicate
  they meant; a lint fails the build if the name reappears.

**`ready` means enforcement-ready, never provider-ready — and this must not drift.** The
likely long-run failure is social, not technical: `enforcementReady` gets treated as "spend
works". Two guards: UI and API copy stay constrained to *"spending controls are up and
enforcing"*, and **T16 is required coverage near any future metered-path change**, so a
change that widens what the probe implies has to confront the narrower claim.
 It asserts: the cap gate is
constructed, reachable from the metered path, and refusing over-cap attempts. Credentials,
booking commit and downstream execution are separate concerns with their own failures. UI
copy says *"spending controls are up and enforcing"* and never the bare word "ready".

## 2. Routes

All **six** are **pre-gate** (the allowlist): they must work while the money layer is off,
because they are the door to turning it on. Five mutate or act; `GET
/routing-spend/enable-status` is a read and is allowlisted by the same mechanism.

| Route | Auth | Body | Returns |
|---|---|---|---|
| `POST /routing-spend/plan` | Bearer | `{ action: <member of MONEY_LAYER_PREGATE_ACTIONS> }` | `{ planId, nonce, renderedText, action, sourceStateAtRender, machineId, machineNickname, expiresAt }` |
| `POST /routing-spend/money-layer/commit` | Bearer **+** PIN | `{ pin, planId, nonce }` | `{ lifecycleState, enforcementReady, enableSources, storeCleared, probe, message }` |
| `POST /routing-spend/money-layer/restart` | Bearer **+** PIN | `{ pin, nonce, confirmationTextHash }` | `{ accepted, message }` |
| `POST /routing-spend/config-inspect` | Bearer; **+ PIN** for limits fields | `{ pin? }` | `{ differs, configSnapshotAt, fields: [...] }` — non-adopting inspection. The route is always reachable pre-gate; without a PIN, `fields` contains ONLY `routingSpend.money.enabled` |
| `POST /routing-spend/money-layer/restart-nonce` | Bearer | `{}` | `{ nonce, expiresAt, confirmationText }` — refused (409) outside the three restartable states |
| `GET /routing-spend/enable-status` | Bearer | — | `{ lifecycleState, enforcementReady, enableSources, configSnapshotAt, machineId, lastTransitionAt, failingComponent?, settlingCount, restartEligible, anyKeyFrozen, freezeRecordProvisional }` — read-only, `Cache-Control: no-store`, mints nothing |

### The action enum (defined once, referenced everywhere)

```
MONEY_LAYER_PREGATE_ACTIONS = [
  "money-layer-enable",              // enable from disabled
  "money-layer-mirror-config",       // from config-enabled: copy config into the store,
                                    // yielding both-enabled; does NOT clear the config key
  "money-layer-disable",             // refused by the renderer while the config key is set
  "money-layer-disable-store-only",  // the acknowledged variant, rendered in its place
]
```

**Four** public actions. Any statement of a count elsewhere refers to this enum; the commit
route accepts a signed action **iff** it is a member of it. There is no internal-only
variant — `money-layer-disable-store-only` is a public action precisely so that what the
operator approved is visible in the signed plan and the audit log.

**"Mirror into store" is its own action, `money-layer-mirror-config`.** Overloading
`money-layer-enable` would have made one signed action mean different things depending on
the source state when it was rendered — so a plan rendered in one state and committed in
another could do something the operator did not approve. Each action means exactly one
thing.

**Every plan additionally carries the `enableSources.state` it was rendered under, in the
signed material, and commit refuses (`409`) if that state has changed since.** The operator
approves a decision made in a particular situation; if the situation moved, they should see
the new plan rather than have the old one applied to it.

### Route visibility matrix (the single normative statement)

**`freeze` is ALWAYS visible — unconditionally, pre-gate, like the enable routes.**

**Why Bearer-only denial is inside the boundary, analysed rather than assumed.** Freeze is
an agent-reachable lever that can permanently deny spend, which deserves the same scrutiny
the restart route got. It is accepted because the asymmetry is deliberate and load-bearing:
**halting money must always be cheap; resuming it must not be.** A Bearer holder can stop
spend (worst case: a denial-of-service on the agent's own paid capability, visible, audited,
and reversible by the operator); a Bearer holder can NOT resume it — **unfreeze is
PIN-gated**, unchanged from Increment B. Freeze calls are audited on the authority channel
with the caller and reason, and rate-limited only to bound log volume, never to delay a stop.

**The residual risk is durable denial-of-service, and it is handled by visibility, not by
gating.** A Bearer holder can freeze every key and leave the operator's paid workflows dead
until they notice and PIN-unfreeze. Gating freeze would be the wrong cure — it would trade a
visible, reversible outage for an unstoppable overspend. Instead: freeze is **per-keyRef**
(never a single global switch), each freeze raises **one attention item naming the keyRef,
caller and reason**, `enable-status.anyKeyFrozen` makes the state visible pre-gate, and the
freeze reason and caller ARE readable pre-gate in the filtered log — a stop the operator
cannot see the cause of is worse than one they can. Only freeze *timing history* stays
withheld. The failure this ordering prevents — an agent that cannot stop its own overspend
because the stop was gated — is far worse than the one it permits.

An earlier draft made it conditional (`intentEnabled || constructedSpendMachineryExists ||
settlingCount > 0`). That is wrong for the same reason the whole spec exists: under a stale
config snapshot `intentEnabled` can read false while spend is in fact enabled, and the
emergency stop would be hidden at exactly that moment. A brake whose availability is
computed from possibly-stale state is not a brake. Freeze is therefore not gated on
anything; when there is nothing to freeze it is a harmless no-op that says so.

| Route group | Visible when |
|---|---|
| `plan` (allowlisted actions), `money-layer/commit`, `money-layer/restart`, `money-layer/restart-nonce`, `config-inspect`, `enable-status` | **always** (pre-gate) |
| `freeze` | **always** (pre-gate, unconditional) |
| `caps/log` — enable/disable/status rows, and **redacted** freeze/unfreeze summaries (keyRef, caller, reason; no timestamp) | **always** (pre-gate), Bearer |
| `caps/log` — caps, arming, spend rows, and **full** freeze/unfreeze rows with timing | `servingReady \|\| settlingCount > 0` |
| read-only spend views: `summary`, `caps` | `servingReady \|\| settlingCount > 0` |
| everything else under `/routing-spend/*` — caps adjust, arming, and all mutating routes | `servingReady` |

**`caps/log` is always visible, but only PARTLY.** The audit trail must survive a clean
disable — a log that disappears when its subject is off is not a log. But making the WHOLE
merged history Bearer-readable pre-gate would hand the agent caps, arming state, freeze
history, spend figures and operational timing while the money layer is off, which quietly
weakens the requester ≠ authorizer boundary the rest of this spec defends.

So the log is **split by sensitivity, not by availability**, with the row types enumerated
rather than described by category:

| Row type | Pre-gate readable? |
|---|---|
| enable/disable plan rendered, enable/disable committed | yes |
| enable-source transition, lifecycle transition | yes |
| restart requested / initiated / observed-ready | yes |
| config-inspect | yes |
| freeze / unfreeze — keyRef, caller and reason (NO timestamp) | yes — an operator must be able to see WHY spending stopped |
| **PIN attempt failed** | **no** — attempt timing is an attack signal |
| caps adjusted, door armed | no |
| freeze / unfreeze — full rows WITH timing history | no |
| probe result | no — it reveals enforcement timing |
| spend rows | no | Both remain one
merged, time-ordered view for an operator whose read satisfies both conditions.

**Sensitivity filtering happens BEFORE pagination**, and cursors are opaque — they encode no
offset, index or count over the unfiltered set. Otherwise a pre-gate reader could infer the
volume and timing of hidden spend and freeze rows from gaps in the cursor sequence, which is
exactly the information the split exists to withhold. Totals and counts returned to a
pre-gate reader describe the filtered set only.

No other section adds or removes an exception. §1's "freeze reads live" describes *how* it
reads state; this table alone says *when* each route is reachable.

**Allowlist discipline.** The pre-gate exemption is keyed on the **action value**, expressed
as one enumerated constant so the exempt set is greppable and testable — never a "the body
looks like an enable" condition.

**The commit route loads the stored plan and rejects it unless its SIGNED action is one of
the `MONEY_LAYER_PREGATE_ACTIONS` enum** (`409`), before any effect. The action is not in the request
body, so without this check the pre-gate commit route would accept any valid plan id —
including a caps-adjust plan — and apply it while the layer is off.

**Bearer is required in addition to the PIN.** The PIN is the authority; it must not also
be the sole online secret.

**Restart is deliberately operational authority, not plan-bound authority — and this is a
named exception to the plan-binding discipline, not an oversight.** It changes no
money state — it restarts a process — so binding it to a rendered plan would add ceremony
without adding a decision for the operator to read. It is therefore PIN-gated and audited
but not plan-bound, and the difference is stated rather than left as an inconsistency with
§7's "authority writes are plan-bound". To close the gaps that plan-binding would otherwise
have covered: the route takes a **single-use nonce** minted by `POST
/routing-spend/money-layer/restart-nonce` (**single-use replay protection** — the claim is
deliberately narrowed: without session or origin binding this does not prove browser CSRF is
impossible, and calling it CSRF protection would overstate it), the nonce expires on a short window
(stale-PIN replay), and it is accepted only in `enable-pending-restart`, `probe-failed` or
`construction-failed`.

**The operator approves the SERVER's words, not the client's.** The commit UI must display
the canonical `renderedText` and action returned by the server, verbatim — never
client-authored copy describing what the plan supposedly does. A client that paraphrases
could show a reassuring label over a different signed action, which is the whole failure
plan-binding exists to prevent. The **hash of `renderedText`** is audited with the commit,
so what the operator was shown is recoverable afterwards rather than merely asserted.

**Plan rendering REQUIRES the single-instance lock**, unlike the other audit-only pre-gate
routes. A rendered plan is not an authority write, but it IS authorization material — a
`planId`/`nonce` later spendable with the PIN — so minting it from a process that is not the
owner would let a non-owner manufacture the artifact the commit path trusts. Render is
refused without the lock, and commit additionally **rejects any plan whose render was not
recorded under the lock**, so an unaudited render is structurally unusable rather than merely
discouraged.

**Working remotely against a machine-bound flow.** Plans, the enable state and the audit are
all machine-local, and the operator is usually remote. That is workable but must be said:
the operator drives the Spend tab **of the machine they are enabling** — the existing
pool-link machinery resolves the fronting server to the owning machine, and every rendered
plan names its target machine and nickname so a multi-machine operator always knows which
one they are arming. There is deliberately no fleet-wide enable: each machine is enabled on
its own, by its own PIN, from wherever the operator happens to be.

**Plans are machine-bound.** `machineId` is part of the signed plan material and named in
the rendered text; a plan committed on a different machine is refused (`409`).

**Rate limits and lockout — concrete defaults, so tests and abuse analysis are not fuzzy.**
All are config keys under `routingSpend.money.limits` and these are the shipped defaults:

| Key | Default | Governs |
|---|---|---|
| `planRenderPerHour` | 20 / machine | pre-gate plan renders (`429` + one deduped attention item) |
| `planTtlSeconds` | 600 | rendered plan expiry |
| `restartNonceTtlSeconds` | 120 | `restartNonce` validity |
| `restartCooldownSeconds` | 60 | minimum gap between accepted restarts |
| `pinFailuresBeforeLockout` | 5 | failed commits/restarts before lockout |
| `pinLockoutSeconds` | 900 | lockout duration, per machine |

The mint route succeeds **only** in `enable-pending-restart`, `probe-failed` and
`construction-failed` — the
three states where restart is accepted — and is absent otherwise, so the surface cannot offer
a restart the route would refuse. **The nonce is minted by `POST /routing-spend/money-layer/restart-nonce`, never by the GET.**
An earlier draft had `enable-status` issue it — a read-only, cacheable, prefetchable route
minting security-relevant state, which is the same mistake this spec rejected for
`config-refresh` two sections earlier. `enable-status` now reports only `restartEligible`
(a boolean) and carries `Cache-Control: no-store`. The mint route **stores the hash of the confirmation text against the nonce**, and the restart
request MUST submit that hash as `confirmationTextHash`; the server compares and refuses
(`409`) on mismatch or absence. That makes the check real: a client that never fetched the
text cannot produce the hash. **What it proves, stated exactly:** the caller possessed the
canonical text — NOT that a human read it. A Bearer+PIN holder can mint the nonce, hash the
text and restart without any human ever seeing it; the hash is a **client-integrity check,
not an operator-consent proof**, and it must never be cited as the latter. The consent
evidence for restart is the PIN, exactly as elsewhere in this spec. Display remains a client obligation, and this
spec does not claim cryptographic proof of display, because it does not have one. The mint route
returns, alongside the nonce, a **canonical server-rendered confirmation string bound to
that nonce**, which the UI must display verbatim before the restart is
submitted — naming the machine and that the whole agent server restarts. This is the same
discipline as plan-binding, minus the durable plan record: an accidental mobile tap has to
pass a server-authored sentence describing what it actually does. It is single-use and
expires on a short window; a consumed
or expired nonce is `409` and the client re-reads status to obtain a fresh one.

Restart is **rate-limited with a cooldown** per machine, and **failed restart attempts —
bad PIN, stale nonce, wrong state — are audited** exactly like failed commits.

**The security boundary is stated rather than implied: Bearer + PIN is the whole boundary.**
The nonce is issued by a Bearer-only read and the Bearer token is agent-held, so the nonce
is replay/CSRF protection, **not** a second authority — an attacker holding both Bearer and
PIN can restart the server, bounded only by the cooldown. That is accepted deliberately: a
restart moves no money, books no spend and changes no cap, so its worst case is availability
damage the cooldown bounds.

**The money PIN is intentionally also server-restart authority here, and that is stated
rather than assumed.** The PIN is the operator's credential for this machine, not a
money-scoped one; there is no separate operational credential in the system to bind to, and
inventing one for a single button would be a new authority surface with its own lifecycle.
The restart is additionally narrowed so it cannot be a general lever: accepted only in the
three restartable states, single-use nonce, cooldown, refused while money work is settling
without `force: true`, and gated behind a server-rendered confirmation naming the blast
radius.

**There is NO caller-identity binding on the nonce, and claiming one would be false.**
An earlier draft said the nonce was bound to "the Bearer-token identity". Checked against
the source: `authMiddleware` compares one shared agent token against one configured value —
every Bearer caller collapses to a single identity, so binding to it isolates nothing and a
test for it could not fail. The claim is withdrawn rather than restated more carefully.

What the nonce actually provides is **replay protection, not caller isolation**: single-use,
short TTL, valid only in the three restartable states, and spendable only alongside the PIN
and the displayed confirmation string. Anyone holding the Bearer token and the PIN can
restart the server; that is the accepted boundary, stated plainly in §2. Binding to a
specific *dashboard* session is deliberately NOT required: the operator may legitimately
drive this from the dashboard, a phone browser or a direct call, and hard-binding to one
surface would recreate the mobile-incompleteness this spec exists to remove. A short TTL,
single use, the two-state restriction and the displayed confirmation string are the whole
boundary.

**And availability damage is not nothing, so the copy must say so.** A restart interrupts
this machine's whole server — unrelated operator workflows, in-flight non-money work, local
agent sessions — not just the money layer. The button's text names that plainly (*"restarts
the agent server on this machine"*) rather than reading like a money-layer-local action. Restart is **not** bound to
a session or origin, and the spec does not claim it is.

`settlingCount` is the number of in-flight calls/reservations still settling (§5). Because it
unlocks read visibility, a stale positive would keep sensitive rows readable indefinitely, so
it is pinned:

- **Source of truth:** the ledger's live in-flight/reservation set — derived, never an
  independently-incremented counter that can drift.
- **Not persisted across restart.** A process restart ends its own in-flight work; the new
  process derives the count from reservations the ledger can still account for, and anything
  unaccountable is reconciled to settled rather than left pending.
- **Bounded:** each in-flight entry carries a settle deadline; past it the entry is reconciled
  (settled or abandoned, recorded either way) and stops counting.
- **Tested** for the crashed and stuck cases (T24).

**Errors:** `400` **syntactically invalid** input — an `action` outside the enum, malformed
body · `401` bad/absent PIN · `409` a **well-formed but not-permitted** request: plan
unknown/expired/consumed, signed action not on the pre-gate allowlist, wrong machine, stale
nonce · `429` rate-limited · `503` restart could not be initiated.

The `400`/`409` split is *syntax* versus *permission*: an unrecognised action string never
named a real action (`400`); a validly-signed caps-adjust plan named a real action that is
not allowed through the pre-gate door (`409`).

## 3. States

`lifecycleState` is the **construction/probe state** of the money layer, derived from
resolved intent and construction — never from the store flag alone.

**It is not by itself the answer to "can money move right now?"** That question is
`servingReady`, which additionally requires the single-instance lock (MLE-2), so a process
that loses the lock is `lifecycleState: "probed"` yet refuses spend. To remove any gap
between what the surface reports and what the spend path enforces:

> **`enforcementReady === servingReady`, by definition.** The status routes return the same
> predicate the paid path consults — not a proxy for it. A surface that could report
> enforcement-ready while the spend path disagreed would be the symbol-not-state failure
> this spec is built to avoid.

| State | Meaning |
|---|---|
| `disabled` | resolved intent is false |
| `enable-pending-restart` | intent true, layer not constructed; comes up on restart |
| `probed` | intent true, layer constructed, cap-gate probe passed |
| `probe-failed` | intent true, components CONSTRUCTED, cap-gate probe failed; carries `failingComponent` |
| `construction-failed` | intent true, components ABSENT or construction errored; carries `failingComponent` |

**The lifecycle value is `probed`. The token `ready` is REJECTED legacy terminology and must
not appear as a lifecycle enum value anywhere in code, tests, API output or UI** — a lint and
T22 assert it is never emitted. (`enforcementReady` is a different, retained field name; the
banned thing is the bare lifecycle *value*.) `ready` invites the reading "spend works", and a
warning in prose is a weaker guard than simply not having the word. UI never renders a
lifecycle enum value directly; it renders operator-facing copy derived from
`enforcementReady`.

`enableSources.state` (MLE-1) is a **separate axis** and the two are never merged.
`storeCleared` is a third, independent boolean reporting what the operator's action did.

The pair is what makes "I disabled it and it is still on" legible: a disable while the
config key is set returns `lifecycleState: "probed"`, `enableSources.state: "config-enabled"`,
`storeCleared: true`.

**Persistence and boot recovery.**

| Field | Persisted | Why |
|---|---|---|
| operator-enabled flag | yes | the operator's decision survives a crash |
| `lifecycleState` | **no** — derived at boot | a stored in-progress state would be a lie after that process died |
| `lastTransitionAt` | yes | ages a stuck state |
| last failure state (`probe-failed` / `construction-failed`) + failing component | yes | see below |

**Recovery rule:** flag set + components constructed ⇒ probe ⇒ `probed` or `probe-failed`.
Flag set + components absent ⇒ `enable-pending-restart` — **unless** a failure record is
stored with no successful enable since, in which case the state is the stored
`construction-failed` (or `probe-failed`) carrying its component. A failure must not be
forgotten by the act of crashing.

## 4. Enable, and the restart that completes it

The money layer's components are constructed at server start. Persisting the flag alone
therefore yields a switch that reads on over machinery that is not running. **Phase 1 does
not construct hot** (Appendix A); it persists intent and converges on restart, honestly
labelled at every step.

1. **Commit** persists the flag (PIN-committed, plan-bound, audited) and returns
   `{ lifecycleState: "enable-pending-restart", enforcementReady: false }` with plain text:
   *"enabled — the money layer comes up on the next server restart; it is not enforcing
   yet."* It restarts nothing synchronously.

2. **`POST /routing-spend/money-layer/restart`** accepts **only** when `lifecycleState` is
   `enable-pending-restart`, `probe-failed` **or** `construction-failed` — the three states a restart can plausibly
   clear. Refused in `disabled` and `probed`, so it is never a general-purpose restart button
   on the money surface. It uses the server's existing supervised-restart path (the one the auto-updater
   uses, under launchd keepalive); no new restart machinery. If the restart cannot be
   initiated it returns `503` naming the reason and the state is unchanged.

3. **The poll is the source of truth, not the response** — the connection may die with the
   process. The Spend tab shows *enabled — not enforcing yet*, a **Restart now** button,
   then polls `GET /routing-spend/enable-status` on an interval within a bounded window
   until `enforcementReady: true`, or surfaces the failure state with its component. Past the
   window it reports *"the restart does not appear to have completed"* and offers a retry —
   never an indefinite spinner, never an assumed success.

4. **Audit ordering against the handoff.** `restart requested` is appended **and flushed
   before** the supervisor handoff, so a process that exits mid-restart still records that
   the operator asked. `initiated` is explicitly best-effort; its absence must never be read
   as "never tried". `observed-ready` is written by the *new* process after its probe and is
   the only durable proof the restart achieved anything.

**Re-pressing enable while the flag already reads true is NOT a no-op.** "Switch on,
machinery down" is exactly the state this control exists to rescue the operator from. Enable
is idempotent in intent — it never double-enables — but always re-verifies and re-repairs.

**Recovering from a failure state** — the operator's path out is specified, because a
terminal-looking state with no named action is a dead end:

**The two failure states differ in what can fix them, which is why they are two states.**
An earlier draft had a single combined failure state and claimed a retry commit could
"re-run the probe"
— impossible in Phase 1 when the components are absent, since Phase 1 does not construct hot.

- **`probe-failed`** — components exist, so an enable commit CAN re-probe. The commit does not
  re-persist the flag (already set); it re-runs the probe and returns the re-derived state:
  `probed` if it now passes, `probe-failed` again with the current component if not.
- **`construction-failed`** — components are absent, so **nothing a commit does can fix it in
  Phase 1**. An enable commit in this state is accepted but honestly returns
  `construction-failed` with the message that a restart is required; it never pretends to
  probe. The restart route is the remedy.
- **`POST .../restart` is accepted in `enable-pending-restart`, `probe-failed` and
  `construction-failed`** — the three states a restart can plausibly clear. Refused in
  `disabled` and `probed`.
- The stored failure record is cleared only by a probe that actually passes — never by the
  attempt itself, so a repeatedly-failing layer keeps reporting the same honest failure rather
  than resetting to a clean-looking state on each try.

**Enabling arms no door.** Every door stays `not-live` with `$0` committed until separately
armed with the PIN. The enable is permission to *use* the arming flow, never a grant of spend.

## 5. Disable, and what it does not do

> **The one-line truth that qualifies every disable claim in this document:** *disable stops
> new spending immediately **only when the store flag is the active enable source**. If the
> config key is also set, spend remains enabled and **freeze is the emergency stop**.*

- **Disable clears the STORE flag only.** No route here writes `.instar/config.json` —
  `PATCHABLE_CONFIG_KEYS` stays untouched, because a route that can edit the money config
  file is a larger authority than the one being added.
- **When the config key is true**, the response and the Spend tab say plainly that the layer
  is still enabled by a config-file setting, name the remediation, and **require the
  separately-signed `money-layer-disable-store-only` action**: the renderer refuses plain
  `money-layer-disable` in that state and renders the acknowledged variant instead, whose
  first line states that this will NOT stop spending. The acknowledgement is carried in the
  signed action itself rather than a checkbox beside it, so what the operator approved is
  exactly what lands. In that state the UI leads with
  **freeze** as the primary action and demotes disable to secondary — a button labelled
  "disable" that leaves money flowing is an operator hazard however well documented.
- **Disable never restarts the server.**
- **Freeze and read-only settling visibility** are governed by the §2 matrix, not by prose
  here. The reasoning: gating the emergency stop, or the spend log, on the healthy state
  would remove the brake and the view precisely when the operator most needs them —
  including the window after a disable when charges are still landing.

**Freeze is checked live on every paid call, before provider execution or reservation, and
a frozen key refuses regardless of `intentEnabled`, the config key, `lifecycleState`, or the
single-instance lock.**

**Which means the freeze check CANNOT live inside the constructed money layer.** If it did,
a `construction-failed` layer would take the emergency brake down with it — the one state
where the operator is most likely to reach for it. The check therefore lives in the
**metered-call entry path itself**, ahead of the money layer and independent of whether that
layer constructed: it reads the freeze set directly from the caps store on disk. This is
called out explicitly so an implementer does not naturally place the brake inside the
machinery it is meant to survive. This is stated as its own invariant because freeze is the control
the rest of this spec points at as the emergency stop; a stop that is only checked at some
layers is not one.

**What makes disable real rather than cosmetic:** the metered-call path performs a
**synchronous live enable check on every paid call**, reading current state rather than a
value captured at construction. A constructed-but-disabled layer refuses at the point of
spend. Disable is verified by its own probe: a dry-run call on the real metered path must
refuse with the specific *money-layer-disabled* reason, or the result is `probe-failed`
rather than success.

**In-flight work at the moment of disable:**

| Work | Outcome |
|---|---|
| not yet past the enable check | refused |
| already in flight with the provider | **allowed to finish, and its spend IS booked** — killing it would spend the money without recording it |
| queued but unstarted | dropped at the enable check |
| reservation made before disable | settles normally; no new reservation granted |

The disable response reports the count of in-flight calls still settling, so "disabled"
never silently means "and a few more charges are still landing."

## 6. The cap-gate readiness probe

A **cap-gate** readiness probe — its name is its scope. It proves cap enforcement is wired
and refusing; it does not exercise provider credentials, booking commit or downstream
execution, and full-path coverage remains with the metered path's own integration tests.

**There is no bypass.** Earlier drafts reached the cap check by entering the metered path
after the go-live check, behind a capability token — a privileged execution path inside the
money path, fenced with a non-exported entry point, a lint and a negative HTTP test. Review
challenged it in five separate rounds and the convergence comparator named it the single
largest unresolved architectural risk. Fencing it better was the wrong answer five times
running. It is removed, and the risk with it.

**Instead: a probe DOOR that is genuinely live and structurally cannot bill.**

| Property | Value |
|---|---|
| keyRef | `__probe__` — reserved; refused as a user-supplied keyRef everywhere |
| provider | `null-provider` — a built-in no-op that performs NO network call and returns a fixed synthetic response |
| **evaluation price** | fixed **positive** synthetic price (`$1.00`), in the price manifest, not operator-editable — used ONLY for cap evaluation |
| `goLiveState` | **live** — deliberately, so the go-live check PASSES |
| dailyCap / lifetimeCap | `$0` |
| actual booked spend | always `$0` — the gate refuses before execution, and the provider cannot bill in any case |

The probe is then an **ordinary metered call on the ordinary path**: go-live passes because
the door really is live; the cap check evaluates the request at its **positive** synthetic
price of `$1.00` against a `$0` cap and therefore refuses with `cap-exceeded`. Nothing is
skipped, nothing is privileged, and the thing being proven — *the cap gate refuses on the
path that spends* — is proven by the path that spends.

**The positive price is load-bearing and an earlier draft got this wrong.** With a `$0`
price, `$0` usage does not exceed a `$0` cap, so the probe would never trip the gate and
readiness could never pass — the check would have been permanently broken in a way that
reads as "not ready" rather than as a defect. The price is what the gate *evaluates*; it is
never what the ledger *books*, because the gate refuses before execution and the provider
cannot bill regardless. Both facts are asserted (T7).

**Why this is safe where a bypass was not.** The bypass's risk was that a privileged branch
inside metered execution could be reached by something other than the prober — through a
refactor, a barrel file, DI, or a leaked token. That branch no longer exists. The probe door
is protected by two independent structural facts instead: its provider **cannot** perform a
billable operation (it makes no call), and its cap is `$0` (so the gate refuses it even if
the provider were swapped). Either alone prevents spend; both must fail together to bill,
and neither is reachable by editing spec-local code.

**The probe's contract is unchanged, including the cause check:**

- **Preconditions asserted first:** the `__probe__` door resolves, is live, and the request
  is well-formed — so "door not armed", "unknown key" and "malformed" cannot be mistaken for
  enforcement.
- **Expected result:** refusal with the specific **cap-exceeded** reason. Any other refusal
  reason ⇒ `unknown` ⇒ NOT ready. A refusal for the wrong reason is a probe failure, never a
  pass.
- **Post-assertion:** committed spend is unchanged, and the ledger records `$0`.
- **Unmeasurable ⇒ `unknown` ⇒ not ready**, per P20.

**The cost, stated honestly:** a permanently-live `$0` door exists in the caps registry. It
appears in `GET /routing-spend/caps` flagged `probe: true` so it is never mistaken for a real
paid door, it is excluded from spend summaries and from the operator's arming UI, and its
keyRef is refused as user input. That is a smaller and far more inspectable surface than a
privileged branch inside metered execution — a visible always-`$0` row versus a hidden
conditional in the code path that moves money.

## 7. Audit channels

Two channels sharing one file, distinguished by **interface**, not convention:

- **Authority writes — split by direction, because they do not share one discipline:**
  - *Authority-increasing / non-monotonic* (enable, caps raised, arming, **unfreeze**): **PIN-committed and plan-bound.**
  - *Monotonic-restricting* (**freeze**, clearing the store flag): **Bearer-only, no plan** — halting money stays cheap — but still recorded on the
    **authority channel**, not the audit-only channel, because they change what may spend.

  A single "PIN-committed, plan-bound" line covering both contradicted freeze being
  Bearer-cheap everywhere else in this spec.
- **Audit-only appends** (plan rendered, PIN attempt failed, probe result, state
  transition, restart requested/observed): a **distinct handle offering only `append` and
  `read`** — no update, no delete, no rewrite, structurally absent from the type rather
  than refused at runtime. It carries no authority fields.

A caller holding one handle cannot reach the other. `GET /routing-spend/caps/log` presents
one merged, time-ordered history with each entry tagged by channel.

**Durability, because the restart handoff depends on it.** The `restart requested` ordering
guarantee in §4 is only worth as much as the append underneath it, so the audit channel
reuses instar's existing append-only JSONL discipline rather than inventing storage:
a **single process-local writer** — serialized through one append queue in the one server
process the single-instance lock already guarantees — issuing one `write()` per record to an
`O_APPEND` descriptor. Cross-process atomicity is therefore not relied upon at all, which is
the honest position: `O_APPEND` atomicity for large records is filesystem-dependent, and this
spec does not need it. Records are size-bounded; an oversize record is truncated with an
explicit marker rather than split. The log is never rotated or renamed by this path, so no
directory-fsync semantics are involved. **Append/fsync failure is a first-class outcome, not an assumed success.** If an
authority-write's audit append fails, **the authority write is refused** — money state never
changes without its record.

**FREEZE is the one named exception to that coupling.** Refusing a freeze because its audit
row could not be written would let a logging failure disable the emergency stop, which
inverts the priority: stopping spend matters more than recording that we stopped it. So for
freeze specifically, **the marker write is authoritative and proceeds**, and the audit row is
best-effort — written to the server log marked provisional when the authority append cannot
be trusted (lost lock, fsync failure). The operator is told the freeze applied and its record
is provisional. **Unfreeze is NOT excepted** and follows the normal coupling: no record, no
resumption. T36 covers an audit failure during freeze. If a non-authority audit append fails, the operation proceeds and
the failure is reported to the caller and the server log. **This covers the lock case too:**
a pre-gate audit-only route (`config-inspect`, status transitions) whose append is refused
because the lock is absent still SERVES — it changes no money state, so refusing
the read would be a self-inflicted outage for no safety gain. Only AUTHORITY writes are
coupled to a trusted append, and freeze is the named exception to even that. If the pre-handoff fsync fails, the
restart is **not** initiated and returns `503`: an unrecorded restart is precisely the case
the ordering exists to prevent. There is an explicit **flush/fsync before the
supervisor handoff**
— the one point where an unflushed buffer would lose the evidence. A truncated trailing
line from an unclean exit is skipped on read with a logged warning rather than failing the
whole log; no record is ever rewritten to "repair" it.

**Tamper evidence is explicitly out of scope, and that is a scope statement rather than an
oversight.** Append-only *by interface* is not append-only *on disk*: anyone with local
admin access to the machine can edit the file. This log is an **operator trust record
against accident and against the agent**, not a forensic record against a local
administrator — and the operator IS the local administrator, so a hash chain would protect
them from themselves rather than from a threat that exists. If this log ever needs to
satisfy an external auditor, that is a different requirement and needs its own design.

## 8. Required tests

| # | Assertion |
|---|---|
| T1a | An `action` value outside the enum is refused `400`. |
| T1b | A validly-signed non-allowlisted plan action presented pre-gate is refused `409` and does NOT reach the gated handler. |
| T2 | A caps-adjust plan presented to the money-layer commit route is refused (409). |
| T3 | A plan rendered on machine A and committed on machine B is refused (409). |
| T4 | Commit without Bearer is refused even with a correct PIN. |
| T5 | Enable commit yields `enable-pending-restart` and constructs nothing. |
| T6 | After construction, the probe passes only when the refusal reason is cap-exceeded; every other refusal reason yields not-ready. |
| T7 | The probe books nothing — `__probe__` committed spend stays `$0`, and `null-provider` performs no network call. |
| T8 | The `__probe__` keyRef is refused when supplied by a caller on any route; only the internal prober may target it. |
| T9 | Disable with config true returns `lifecycleState: "probed"`, `storeCleared: true`, and does not report success. |
| T10 | A paid call refuses when the single-instance lock is not held by this process. |
| T11 | Money layer refuses to construct when the single-instance lock is absent/unverifiable ⇒ `construction-failed`. |
| T12 | Boot with a stored failure and no successful enable since yields that failure state, not `enable-pending-restart`. |
| T12b | An enable commit in `construction-failed` returns `construction-failed` with a restart-required message and does NOT claim to have probed. |
| T13 | Freeze is reachable in every state, including both failure states and `config-enabled`. |
| T32 | `GET /routing-spend/enable-status` performs NO writes: repeated polling appends no audit rows and does not update `lastObservedSourceState`. |
| T33 | In `config-enabled` + frozen, the surface states that freeze is active but the layer is still enabled by config — it must not read as a durable disable. |
| T34 | A freeze written by a process NOT holding the single-instance lock stops spend in the process that DOES hold it. |
| T35 | Repeated `config-inspect` calls mutate no authority, config or process state (audit + rate-limit only). |
| T38 | A plan rendered without the single-instance lock is refused; a plan whose render was not recorded under the lock is rejected at commit. |
| T39 | Restart is refused when `confirmationTextHash` is absent or does not match the hash stored at mint. |
| T40 | A Bearer-only `config-inspect` returns no `routingSpend.money.limits.*` values; with a PIN it does. |
| T36 | A freeze whose audit append fails still applies, and is reported as applied-with-provisional-record; an unfreeze whose append fails is REFUSED. |
| T29 | `config-inspect` is Bearer-only, adopts nothing, and reports the per-field disk-vs-process diff correctly. |
| T30 | No route adopts on-disk config into the running process; `config-inspect` leaves the process snapshot unchanged. |
| T31 | Restart is accepted in all three restartable states and refused in `disabled` and `probed`. |
| T14 | The audit handle cannot write authority fields; the authority handle cannot append audit rows. |
| T15 | The metered path re-reads enable state per call (constructed-but-disabled layer refuses). |

| T16 | **Required, and normative.** A real armed-door dry-run refuses over-cap through the full metered path, covering provider-credential and per-door routing the probe door deliberately does not. It is tied to `enforcementReady` regression coverage: the sentinel probe is NOT comprehensive readiness, and T16 exists so a future implementer cannot treat it as such. |
| T17 | Read-only spend/settling status stays reachable while `settlingCount > 0` after a disable. |
| T18 | `GET /routing-spend/caps/log` is reachable in every state, including `disabled` with nothing settling. |
| T19 | A frozen key refuses a paid call in every combination of `intentEnabled`, config key, `lifecycleState` and lock state. |
| T20 | In-flight money reservations settle or recover correctly across a restart. |
| T21 | The commit audit records the hash of the `renderedText` the operator was shown. |
| T22 | No API response or UI string emits `ready` as a lifecycle value; only `probed` is emitted. |
| T23 | A pre-gate `caps/log` read with Bearer only returns enable/disable/status rows — no caps, arming, freeze or spend rows. |
| T24 | `settlingCount` returns to zero after a crash with in-flight reservations, and after a settle deadline passes. |
| T25 | A plan rendered under one `enableSources.state` is refused (409) if committed after that state changed. |
| T26 | An authority write or audit append is refused when the single-instance lock is not held, and the refusal appears in the server log marked non-authoritative — never as an audit row. |
| T27 | A `restartNonce` is single-use: a second presentation is refused (409), and it is refused outside the three restartable states. |
| T28 | `enable-status` returns `configSnapshotAt`, and every surface showing `config-enabled` renders it. |

Three tiers per the Testing Integrity Standard: unit (predicates, state derivation, probe
cause-checking), integration (the four routes over HTTP), E2E (the feature is alive — enable
→ restart → status reports enforcing).

## Why not a durable job model for the restart handoff

The restart path specifies audit-before-handoff, a poll, and an `observed-ready` written by
the new process — which resembles a small durable-workflow engine, and the alternative
(a local job record with explicit states and retries) deserves an answer rather than a
silent preference.

It is rejected for this build because the handoff has exactly **one** step, **no** retry
semantics worth modelling, and a **self-evident** terminal condition that the new process
writes on its own. A job record would add durable state that can itself go stale, disagree
with the derived lifecycle state, and require its own reconciliation — a second source of
truth about readiness, which §1 spent an invariant eliminating. The operator-visible
guarantee is already the strongest available one: **the poll observes the new process, not
a record of intent.** If Phase 2 ever introduces multi-step or retrying transitions, a job
model becomes the right shape; at one step it is machinery without a job to do.

## Decision points touched

- **Adds** the three plan actions of `MONEY_LAYER_PREGATE_ACTIONS`, one PIN-gated commit
  route and one restart route to the money authority; the state lands OUTSIDE
  `PATCHABLE_CONFIG_KEYS`.
- **Replaces** `moneyOn()` with `intentEnabled` / `servingReady`.
- **Modifies the metered call path** — a synchronous live enable check per paid call, and a
  live freeze check ahead of the money layer. This is the load-bearing change; without it
  disable is cosmetic. **No privileged probe entry point is added**: the probe is an ordinary
  metered call against the reserved `$0` `__probe__` door (§6).
- **Modifies the caps store** — the reserved `__probe__` door, operator-enabled flag, failure record,
  `lastTransitionAt`, probe sentinel, and the separate audit handle.
- **Modifies the ledger (dry-run path only)** — the sentinel evaluation books nothing.
- **Genuinely untouched:** per-door arming, the freeze asymmetry, `PATCHABLE_CONFIG_KEYS`.

Classification per **Judgment Within Floors**:

| Decision point | Class | Justification |
|---|---|---|
| May this commit apply? (PIN + plan id + nonce + signed action + machine) | `invariant` | Authorization on money. No competing signals: either the operator's PIN authorized this exact rendered plan or it did not. |
| `intentEnabled` | `invariant` | A pure OR over two declared sources. |
| `servingReady` | `invariant` | Conjunction of intent, lifecycle and lock. Fails closed when any input is `unknown`. |
| Is the cap gate enforcing? (readiness probe) | `invariant` | A liveness check with a declared expected cause; unmeasurable ⇒ `unknown` ⇒ not ready. |
| Which of MLE-1's four source states applies? | `invariant` | Equality over two booleans; surfaced, never tiebroken. |

No judgment-candidate points. Every decision added is a deterministic authorization or
liveness check on money — the class where static rules are correct and weighing competing
signals would be a defect.

## Verify the state, not its symbol (P20)

The one detector added is the cap-gate readiness probe (§6).

- **Symbol:** the money-layer components resolve as constructed.
- **State claimed:** cap enforcement is live on the path that spends.
- **Corroboration:** a synthetic over-cap dry-run through the real metered path that must
  refuse **for the cap-exceeded reason specifically** — component presence is explicitly
  not sufficient evidence, and neither is a refusal of unknown cause.
- **Symbol present, state absent:** components from a stale pre-enable boot could exist
  while the gate is not enforcing — hence the probe, not an inference from siblings.
- **State present, symbol absent / unmeasurable:** returns `unknown`, treated as NOT ready.
  The least-harmful action is to report honestly and repair: a false "ready" opens spending;
  a false "not ready" costs a restart.

## Multi-machine posture

- **Operator-enabled flag, caps state, audit trail:** `machine-local`.
  `machine-local-justification: physical-credential-locality` — the state authorizes spending
  against provider credentials that physically live in one machine's config home, and the
  dashboard PIN that commits it is per-machine and does not cross the mesh. Replicating an
  enable would grant spend authority on a machine whose operator never approved it. Enabling
  is a per-machine action and the Spend tab says so rather than implying a fleet-wide switch.
- **The Spend tab surface:** `proxied-on-read` — the existing pool-link machinery resolves
  the holder.

## Frontloaded Decisions

1. **Build it** — yes (operator, 2026-08-16 14:26 PDT).
2. **Cap shape** — daily-rate approximation (operator, same message); the cap model is untouched.
3. **Where enable state lives** — `RoutingSpendCapsStore`.
4. **Two sources** — OR; four enumerated states; disable clears the store flag only and
   never writes config.
5. **Enable when already enabled** — re-verify and repair, never a no-op.
6. **Disable** — clears the store flag; stops new spending only when config is not also
   enabling it; never restarts the server.
7. **Freeze** — stays Bearer-cheap and exempt from `servingReady`.
8. **Hot construction** — Phase 2, explicitly out of scope.
9. **Agent authority** — unchanged. Bearer renders plans; only the PIN commits.

## Open questions

*(none)* — both previously-open decisions were resolved by the operator on 2026-08-16.

## Honest scope limit — Phase 1 cannot fully remediate `config-enabled` remotely

Stated plainly rather than left for an operator to discover: if the money layer was enabled
by the config-file key, **Phase 1 gives no remote way to turn it off.** Disable clears only
the store flag; mirroring produces `both-enabled` and leaves config the stronger source; no
route here writes `.instar/config.json`, deliberately.

What a remote operator CAN do: **freeze**, which stops spend immediately and completely, and
is always reachable. That is a real stop, not a consolation — but it is a different control
from "off", and the surface says so instead of implying parity.

**A frozen-but-config-enabled state must never read as "off".** The surface says both facts
together — *spending is frozen; the layer is still enabled by a config-file setting* — with
the freeze presented as active-and-holding rather than as a completed disable, because an
operator who believes they durably disabled and later unfreezes would resume spending they
thought was off. T33 covers the displayed state.

To genuinely disable, the config key must be removed on the machine. The Spend tab therefore
shows, in the `config-enabled` state, **the exact file path and key to remove** — so the
operator can do it themselves, or hand the instruction to someone at the machine, without
having to ask what to change. Making that removal remotely performable is a larger authority
question and belongs to its own spec, not to this one.

## Risks

- **This makes real spending easier to switch on.** Mitigated by keeping the enable
  PIN-gated and plan-bound, leaving every door disarmed on enable, and keeping freeze
  Bearer-cheap. The alternative — leaving it unreachable — has its own failure mode: the
  operator hand-editing a money-bearing JSON file while reading instructions off a phone.
- **Two inputs to one question.** Mitigated by MLE-1's enumerated states, by only one of
  four needing operator attention, and by the acknowledgement requirement on a
  config-enabled disable. Honestly stated cost: a disable can fail to disable, and the
  surface must say so every time.
- **The daily rate is not a monthly cap.** A $3.30/day cap bounds any single day and bounds
  a 30-day worst case near $100, but does not cap a calendar month and does not prevent a
  heavy fortnight. The operator chose this shape "for now"; a real monthly cap remains
  available as its own spec and nothing here forecloses it.

---

# Appendix A — Phase 2: hot construction *(non-normative, out of scope)*

Phase 1 converges on restart. Phase 2 would remove that restart by constructing the layer
in place. It is recorded here so Phase 2 need not rediscover the ordering — not as
requirements for this build.

**Phase 2 must plug into the existing server lifecycle, not invent a parallel one.** Its
first task is to extend the existing component-construction path in `server.ts`. If that is
infeasible, Phase 2 needs its own spec; it does not grow out of this one.

Additional states: `enabling` (with `423` on concurrent enable) and `500` construction
error. A process-local lock serializes construction — sufficient *only because* instar
enforces one server process per agent home, which Phase 1 already verifies at runtime
(T10/T11).

Lifecycle container:

| Phase | What may happen | Global visibility |
|---|---|---|
| `prepare` | allocate components, acquire handles | none |
| `start` | start internal machinery | none |
| `probe` | cap-gate readiness probe | none |
| `commit` | publish; register metrics, timers, watchers, handlers | **only here** |
| `rollback` | idempotent cleanup, reverse order | — |

Global registration only after a successful probe. Every prepared component exposes an
idempotent cleanup hook; a cleanup that throws is logged and the rest still run; rollback is
safe to call twice. "Discarded" is not sufficient — dropping a reference does not stop a
timer, close a watcher, unregister a metric or shut down a provider client.

# Appendix B — Why the design is shaped this way *(non-normative)*

Ten rounds of cross-model review (GPT-tier, via the agent's own codex CLI) shaped this
design. The substantive corrections, recorded so they are not re-litigated:

1. **The bootstrap exemption exists because the first draft reproduced the bug it fixes.**
   The enable plan was rendered by a route behind the very gate being opened.
2. **`moneyOn()` was split** because one predicate answered two questions — "did the
   operator ask?" and "is it safe to spend?" — and could answer yes to the second when only
   the first was true (persisted flag, failed construction).
3. **`lifecycleState` derives from resolved intent** because a draft returned
   `disabled` while the config key still enabled spend. A field reading "disabled" while
   money can move is the exact failure this spec exists to eliminate.
4. **The metered path re-checks per call** because a draft closed the routes and left the
   spend path reading a construction-time value — a cosmetic disable.
5. **The probe checks the refusal's cause** because a refusal alone can come from a dozen
   unrelated failures, any of which would have read as success.
6. **The probe uses a live `$0` door, not a bypass.** Five rounds challenged a privileged
   branch inside metered execution and the convergence comparator named it the largest
   residual risk. Fencing it better was the wrong answer each time; removing the privileged
   path — so the probe is an ordinary call that cannot bill — was the right one.
7. **Phase 1 ships pending-restart** because hot construction is a lifecycle manager, and
   the operator's complaint was "no way to turn it on", not "it takes a restart".
8. **The restart is specified end to end** because "the tab offers a restart" left a remote
   operator holding a switch they could not finish flipping — the original complaint in a
   new costume.
9. **The single-instance-lock dependency is checked at runtime** because asserting a
   load-bearing invariant in prose is not proving it.
10. **"Mirror into store", not "migration"** — since no route may write config, the one-tap
    action can only produce `both-enabled`, not a move off config.
11. **The audit channel is a separate handle** because schema validation constrains what a
    caller sends, not what the store permits.
12. **A config-enabled disable requires acknowledgement and leads with freeze**, because a
    button labelled "disable" that leaves money flowing is a hazard however well documented.
