---
title: "One tap turns on automatic sign-in repair for every account on every chosen machine"
slug: "one-tap-unattended-repair"
author: "Echo"
owner: echo
eli16-overview: "docs/specs/one-tap-unattended-repair.eli16.md"
parent-principle: "The Agent Carries the Loop (docs/STANDARDS-REGISTRY.md): a signed-out account the agent can repair itself is the agent's job. Operator Handoff — minimum effort, verified authority: the smallest human decision (one PIN unlock + one tap) on a phone-completable surface, bound to the exact action and target. Updates Never Restrict Existing Agents: nothing changes on a machine the operator did not tick. Operator direction 2026-11-07 (topic 33890): 'All machines should use all accounts, both Claude code and Codex and should have auto login and sign and repair functional. Yes, go'."
depends-on:
  - assisted-subscription-relogin
  - relogin-unattended-agent-session-and-slow-retry
approved: true
approved-by: "Justin (operator) directed this build on 2026-11-07 in topic 33890 ('All machines should use all accounts ... auto login and sign and repair functional. Yes, go'), relayed to the building session by echo-subscription-management; under his standing direction (2026-10-22) that only constitution changes need his separate sign-off. No constitution file is touched."
review-convergence: "2026-11-08T09:22:55.908Z"
amended: "2026-11-10"
amendment-directed-by: "Justin (operator), 2026-11-10 11:15 PST, topic 33890, verbatim: 'This is an Instar failure. A user should be able to take ALL actions for an agent on the dashboard, regardless of which machine is serving/driving that dashboard'. See the section Amendment 2026-11-10."
review-iterations: 6
review-completed-at: "2026-11-08T09:22:55.908Z"
review-report: "docs/specs/reports/one-tap-unattended-repair-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 7
---

# One tap turns on automatic sign-in repair for every account on every chosen machine

## Problem

Automatic sign-in repair ("unattended" assisted re-login) is switched on per machine by
`POST /subscription-relogin/configure`. That route accepts only the
`X-Instar-Operator-Session` header from a fresh dashboard PIN unlock, writes
`subscriptionPool.assistedRelogin` locally, appends an audit line and requests a restart.

Gaps that keep the operator's goal ("every machine, every account, repair works") out of reach:

1. **No surface calls it.** No dashboard code posts to `/subscription-relogin/configure`
   (checked on `origin/main` da2d9ec19f).
2. **It is machine-local.** With five machines the operator would unlock five dashboards.
3. **The lists are out of date and nothing shows it.** Measured 2026-11-07: Studio allows 4
   identities, Mama PC 6, Laptop 3, Mac Mini unread, M5 Pro off. Accounts added later are not on
   the list, so their repairs stop to ask, and no surface says so.
4. **Its restart request is shaped like an update restart** (`targetVersion` set), so the
   supervisor's per-version restart cap can skip it: a second setting change after an update is
   saved to disk but never takes effect. (Found in review; it affects the existing route too.)

This change fixes 1 and 4. For 2, one tap reaches every machine already set to "without
asking"; a machine that is off, watch-only or "asks first" is switched on once from its own
dashboard (a deliberate per-machine choice, §3 step 4). For 3, the gap is shown on every row and
one tap closes it. The allow-list stays an exact-email snapshot (the parent spec's exact-email consent
rule); it does not silently follow future accounts.

## Honest scope of the authority

No brittle detector gains blocking authority; the new refusals are authenticity, exact-match and
ordering checks on authority the operator just granted (signal-vs-authority compliant).

The PIN unlock is the human-presence signal this whole subsystem uses, and this change keeps
that bar: the new fronting route accepts only the session header, never a PIN in the body. It is
not a cryptographic barrier against the agent itself. An agent can read the PIN from its own
secret store, and a peer machine's identity key is a file on that machine. Today
`requireReloginOperatorPin` also accepts the PIN in the request body with no attempt limit, and
a delivered mandate proves only that an active, registered pool machine signed it. Agent
restraint here is behavioural, as it is for every PIN-gated route. This spec does not change
that foundation; the gaps are filed as their own feedback (see Left behind). What this change
does do is bound what a rogue or buggy signer can achieve (target-side identity check,
compare-and-set, closed config set, provenance audit), so a forged mandate cannot widen the
allow-list beyond the target's own verified accounts or silently rewrite an unrelated setting.

## Amendment 2026-11-10: any dashboard, any machine

**The operator rule.** Justin, 2026-11-10 11:15 PST, topic 33890, verbatim: "This is an Instar
failure. A user should be able to take ALL actions for an agent on the dashboard, regardless of
which machine is serving/driving that dashboard". The original design (below, §3 step 4 and §6)
let another machine only refresh the list of a machine already set to "without asking"; a machine
that was off, watch-only or "asks you first" could be raised only from its own dashboard. That
made an action available on one dashboard and missing on another, which the rule forbids.

**What changes.** A PIN-unlocked operator on any machine's dashboard can switch any paired machine
of the agent to "repairs without asking" (from off, watch-only or "asks you first") and back to
"asks you first", through the same `configure-pool` → signed single-use mandate →
`configure-with-mandate` path. Every readable row with accounts gets a tick box. Turning a machine
on, wherever it is, sets no waits (0/0), exactly as turning on the machine you are on always did; a
machine already set to "without asking" keeps its waits and only gets its list refreshed.

**Why the carried PIN unlock is sufficient authority.** The original rationale (§3 step 4) already
established that Instar has one operator principal per agent: the dashboard PIN is agent-wide, so
the person unlocked on any dashboard is the same person who would unlock the target's own
dashboard. The only thing the restriction protected was a per-machine *mode* choice, and the person
who made that choice is the same principal now making a new one, deliberately, by ticking that
machine's row (rows other than already-unattended ones start unticked). The round-6 objection to a
"confirm on that machine" step applies with more force to the restriction itself: other machines'
dashboards are not reachable from the operator's phone, so it blocked the operator while guarding
nothing the agent-wide PIN did not already allow. The authority is therefore the operator's recent
PIN unlock on the issuing dashboard, and it is made explicit and checkable on the target: the
fronting route issues the mandate only after `verifyDashboardOperatorSession` passes, writes
`author: 'dashboard-pin-operator'`, and binds `operatorUnlock: 'dashboard-pin-session'` into the
authority's bounds. Both fields are inside the canonical bytes the R4a issuance signature covers,
so they cannot be added or altered in transit. The target raises a machine only when both are
present (`readConfigureBounds` → `operatorUnlockCarried`); a mandate without them (an older issuing
machine, or anything not issued by the unlocked route) can still refresh a list on a machine
already "without asking", as before, but is refused `403 operator-unlock-missing` for a raise.
This is the same strength as every other PIN-gated action in the subsystem (see "Honest scope of
the authority": not a cryptographic barrier against the agent itself); it adds no new trust
assumption, it removes a restriction that rested on a per-machine owner the system does not have.

**What still blocks.** Unchanged and enforced on the target for every remote request:

- an unpaired or unreachable machine: no mandate is issued (`target-unreachable`), and an
  unregistered sender's delivery is refused before any signature check;
- a stale read: compare-and-set on `expectedRevision` (`stale-config`);
- an identity that is not one of the target's own verified pool emails
  (`identity-not-on-this-machine`), or an unreadable pool (`pool-unreadable`);
- a mandate that is expired, already used, for another machine, or whose digest does not match the
  exact config (`not-authorized` / `config-mismatch`);
- a raise that tries to set waits (`invalid-config`), or any request to disable repair or set
  watch-only (closed set, `invalid-config`);
- a raise without the carried unlock (`operator-unlock-missing`).

Audit rows on both sides: the target's `logs/subscription-relogin-config.jsonl` line now also
records `previousMode` and the carried `operatorUnlock`; the fronting machine appends an
`operator-configure-issued` line per peer target (target, mandate id, requested mode, outcome).
Supervised restart, minimum-evidence fields and nonce single use are unchanged.

**Mixed versions.** A target on an older Instar still answers a raise with
`owner-must-enable-here`; the card reads it as "that machine needs an Instar update before it can be
switched on from here". A new target answering a raise from an older fronting machine says
`operator-unlock-missing`, read as "the machine you tapped on needs an Instar update".

**Where the original text below is superseded:** the §2 "This machine" difference for
`unattended` (remote now follows the same waits rule), the remote clause of §3 step 4 and its
consent paragraph, the §6 tick rule and the `owner-must-enable-here` row of the result table, the
"Which machines change" and "Remote without asking only on a machine already unattended" rows of
Decision points touched, the per-machine-consent sentence of Multi-machine posture, and the
`owner-must-enable-here` items in Testing and Maturation. The rest of the design stands.

## Proposed design

### 1. Read: each machine's repair setting rides the existing pool read

`GET /subscription-relogin` gains a `config` field with this machine's closed metadata only:

```json
{ "machineId": "m_…", "enabled": true, "mode": "unattended" | "approval" | "observe" | "off",
  "identities": ["…"], "minimumSuccessfulRepairs": 0, "minimumEvidenceDays": 0,
  "generation": 7, "revision": "sha256:…", "activationPending": false,
  "verifiedPoolEmails": ["…"] }
```

- `mode`, `dryRun` and the minimums use EXACTLY the runtime's reading (server.ts,
  `createSubscriptionReloginRuntime`): `off` unless `enabled === true`; `observe` unless
  `dryRun === false`; a missing mode is `approval`; missing minimums are the policy defaults 10
  and 30. A looser reading would let a block that is watch-only at runtime look live and pass the
  owner-consent check.
- `generation` is a monotonic integer stored in the block (`assistedRelogin.generation`) and
  incremented by every write through `applySubscriptionReloginOperatorConfig` (the local
  configure route and both new routes). A missing value reads as 0.
- `revision` is the sha256 of the canonical closed metadata above (enabled, mode, dryRun,
  sorted identities, both minimums) **plus `generation`**. It is the compare-and-set token for
  writes. Because the generation only grows, content that returns to an earlier value
  (A → B → A) still gets a new revision, so an old mandate can never match again.
- `activationPending` is true when the on-disk `revision` differs from the revision of the block
  the running server loaded at boot, so the card can say "restarting" truthfully until the
  machine has actually picked the change up (a hand edit that changes the block also shows as
  pending). If `generation` is removed by hand it reads 0 again; the 15-minute mandate expiry is
  then the fallback bound on an old mandate.
- `verifiedPoolEmails` are the sorted, lower-cased verified emails of this machine's own pool
  accounts (both frameworks), the same set the target will accept as identities.

With `?scope=pool` each peer's `config` is merged into `pool.configs[]`. A peer whose answer
lacks `config` (an older release) is reported as `pool.configsMissing[]`; a peer that fails is
already in `pool.failed`. When the repair runtime is not running the route keeps its 503 status
(so no existing consumer changes) but adds `config` to the body, and the pool fan-out reads
`config` from a 503 or `enabled: false` answer before filing that peer under `unavailable`. An
older peer with repair off answers 503 without `config` and is reported in `configsMissing`.
No new fan-out is added: the console Accounts page already reads this route.

Where the values come from: `revision`, `generation` and the closed metadata are read from the
**on-disk** `config.json` block, the same read the compare-and-set uses, never from the running
`ctx.config` (which only changes after a restart). `activationPending` compares the on-disk
revision with the revision of the block the running server loaded at boot (never generations). `verifiedPoolEmails` come from
`ctx.subscriptionPool.list()` (in memory, this machine only; signed-out accounts included,
because they are the ones that need repair), normalised with `normalizeSubscriptionEmail`; only emails that also pass the configure
validator's exact-email check are listed (a dotless domain is left out, so the card never offers
an email the target would refuse). If the
pool cannot be read, `verifiedPoolEmails` is `null` (unknown): the row cannot be ticked and the
target refuses with `pool-unreadable`, never `identity-not-on-this-machine`.

### 2. The fronting write: `POST /subscription-relogin/configure-pool`

Authority: the `X-Instar-Operator-Session` header verified by `verifyDashboardOperatorSession`
only, exactly like `configure`. No PIN-in-body fallback. Body:

```json
{ "mode": "unattended",
  "targets": [ { "machineId": "m_…", "expectedRevision": "sha256:…", "identities": ["a@x.com"],
                 "minimumSuccessfulRepairs": 0, "minimumEvidenceDays": 0 } ] }
```

- `mode` is `unattended` ("Turn on, repairs without asking") or `approval` ("Switch back to
  asking first").
- At least one target; duplicate machine ids → `400`. Each target must be this machine or a
  machine in the pool peer list at request time (`resolvePeerUrls`); otherwise it fails as
  `target-unreachable` with no mandate issued.
- Per target the server builds ONE exact config: `{ enabled: true, mode, dryRun: false,
  unattendedPolicy: { identities, minimumSuccessfulRepairs, minimumEvidenceDays } }`. For
  `unattended` on **this machine** the minimums are 0/0 (Frontloaded decision 1); for
  `unattended` on **another machine** the request carries that machine's current minimums as the
  card read them (effective values, missing reads as 10/30) and the target requires them to equal
  its current effective values, so a remote tap refreshes the
  account list but never lowers a wait the owner chose; for `approval` the request carries the
  identities and minimums exactly as the card read them, they are bound into the digest, and the
  target requires them to equal its current values (only `mode` changes). Validation uses `validateSubscriptionReloginOperatorInput`;
  identities are lower-cased, de-duplicated and **sorted** (the canonical order; the digest and
  the config's unchanged-check both use it).
- `configDigest` = sha256 over the canonical config plus `expectedRevision` (sorted keys).
- **Peers first, this machine last**, peers with bounded concurrency 4, per-peer delivery
  timeout 15 s and per-peer apply timeout 15 s, a peer deadline of 75 s, then this machine, and
  the response by 90 s (inside the tunnel's ~100 s cut-off). The deadline bounds the response, not completion: a target still in
  flight at the deadline is reported `outcome-unknown` ("may have applied; re-reading"), and the
  card's re-read shows what happened. With today's 4 peers everything finishes in one wave.
- **This machine:** the same point-of-use checks as a peer (§3 steps 2–6) minus the mandate,
  with one difference: for `unattended`, step 4's remote clauses (current mode already
  unattended, minimums unchanged) do not apply, because the operator is unlocked on this
  machine's own dashboard; the identity-subset check still applies. Turning this machine on from
  off, watch-only or "asks first" sets minimums 0/0; when it is already "without asking", the tap
  only refreshes its list and keeps its waits (found in the second-pass review). The approval rules apply unchanged. This is the local surface where a machine
  that is off, watch-only or "asks first" is switched on (identities still must be this machine's
  verified emails). A machine with no verified pool emails cannot be set to "without asking" (a
  live unattended list needs at least one), and its row says so. This machine is applied after every peer has answered or the deadline has
  passed, whichever comes first; peers still in flight then stay `outcome-unknown`. Its own restart cannot cut off the response: the response is written in
  the same synchronous turn as the apply, the supervisor that acts on the request is a separate
  process polling every 10 s, and the in-process restart watcher waits a further 3 s before
  exiting.
- **A peer:** issue a coordination mandate (scope `subscription-relogin`, 15-minute expiry,
  `author: 'dashboard-pin-operator'` — the mandate records what was verified, never a guessed
  name) with ONE authority: `{ action: 'subscription-relogin-configure', bounds: {
  targetMachineId, configDigest } }`. Package with `packageMandateForDelivery`, deliver with
  `deliverMandateToMachine`, then POST the peer's `/subscription-relogin/configure-with-mandate`
  with `{ mandateId, config, expectedRevision }`.
- Response `200 { ok, results: [ { machineId, ok, mode?, changed?, restartRequested?, revision?, error? } ] }`,
  where `revision` is the target's on-disk revision after the write.
  `ok` only when every target succeeded. Closed per-target codes: `target-unreachable`,
  `delivery-failed`, `route-missing` (older peer: delivery refused as
  `not-an-account-follow-me-mandate`, or a 404 from the apply route), `not-authorized`,
  `delivery-refused` (the mesh check refused the delivery with `mandate-deliver-unauthorized`;
  on an older Instar this is the usual answer, so the card says "This machine refused; it may
  need an Instar update"), `pool-unreadable`,
  `config-mismatch` (digest differs, e.g. version skew), `stale-config` (revision moved),
  `identity-not-on-this-machine`, `not-unattended` (approval asked of a machine not currently
  unattended), `owner-must-enable-here` (the machine's repair is off or watch-only, see §3),
  `outcome-unknown`, `invalid-config`, `apply-failed`. Without `ctx.coordination` or mesh delivery,
  this machine still applies and every peer returns `delivery-failed`.

### 3. The target point of use: `POST /subscription-relogin/configure-with-mandate`

Bearer-authenticated like `approve-with-mandate`. In order:

1. **Mandate.** `verifyDeliveredConfigureMandate(mandateId)`: R4a signature against the key
   recorded at delivery, not expired, not consumed, a `subscription-relogin-configure` authority
   with `targetMachineId` = this machine. Failure → `403 not-authorized`. Digest of
   (`config`, `expectedRevision`) ≠ bound `configDigest` → `403 config-mismatch`. This runs
   first, so a request without a valid mandate never reaches the setting checks or the write.
2. **Closed set.** Validate `config`; require `enabled: true, dryRun: false`, `mode` in
   {`unattended`, `approval`}. Anything else → `400 invalid-config`. This route can never
   disable repair or put it in watch-only mode.
3. **Already applied?** If the current on-disk config already equals the requested config, the
   answer is success (`changed: false`), whatever `expectedRevision` says, and the restart request
   is re-written when activation is pending. This is how a lost response, or a crash between the
   config write and the restart request, is recovered by tapping again, in either mode. The
   mandate is consumed.
4. **Owner consent and identities.**
   - For a remote `unattended`: the current mode must already be `unattended` → else
     `409 owner-must-enable-here`; the minimums must equal the current effective values → else
     `409 invalid-config`; every identity must be in this machine's `verifiedPoolEmails` → else
     `409 identity-not-on-this-machine`.
   - Why this is the consent rule. Instar has one operator principal per agent: the dashboard PIN
     is agent-wide, so the person who unlocks any machine's dashboard is the same principal who
     set each unattended list in the first place. There is no separate per-machine owner identity
     to consult. What is a per-machine choice is the **mode**: a machine left off, watch-only or
     "asks first" has not been opted into autonomous repair, and a remote tap never escalates it
     (that step is taken on the machine itself, §2 "This machine"). A machine already set to
     "without asking" has been opted in by that principal, and the same principal refreshing its
     list to the machine's own accounts is not a new grant of a different kind; it can never add
     an email the machine does not hold and never lowers the waits. Adriana's M5 Pro is off, so it
     cannot be changed remotely at all. A recorded per-machine consent flag was considered in
     round 5 and dropped in round 6: other machines' dashboards are not reachable from the
     operator's phone, so a "confirm once on that machine" step would block the goal while
     guarding nothing the agent-wide PIN does not already allow.
   - For `approval` (remote or local): the current mode must be `unattended` → else
     `409 not-unattended`; the identities and minimums must equal the current ones → else
     `409 invalid-config`. The verified-pool check does not apply, so switching back works even
     after an allowed account was removed from the pool.
5. **Compare-and-set.** Current `revision` ≠ `expectedRevision` → `409 stale-config`. Steps 5–6
   run in one synchronous block (read, compare, write config, write restart request), so no other
   write through this server process can interleave; a hand edit of `config.json` or a CLI write
   outside the process is not excluded (it would make the next read show a new revision). The
   write changes only the `assistedRelogin` block and preserves every other config field.
6. **Consume, then apply.** Consume the mandate (one-way tombstone), then
   `applySubscriptionReloginOperatorConfig` (generation + 1, provenance `{ via: 'mandate',
   mandateId, deliveredBy }` in its audit line; the local route records `via: 'local-session'`),
   which writes the config and the restart request back to back. Answer `202` like `configure`.
   If the process dies between consume and apply, nothing was written; the next read shows the
   old revision and the operator taps again. If the response is lost after apply, the next read
   shows the new revision. If the process dies between the config write and the restart request,
   the next read shows `activationPending: true`, and the card offers "Finish restarting" (§6), a
   restart-only operation.

### 4. Delivery acceptance (both upstream gates)

Two gates refuse today before any signature check, and both are changed for this one shape:

- the mesh-level `authorizeMandateDeliver` (server.ts, called from `MeshRpc`) passes only when
  account follow-me is on, and on `main` receives only `{ sender }`; this change passes the command
  payload too so it can recognise the configure-only shape;
- `acceptMandateDelivery` returns `feature-disabled` first when follow-me and repair are both off.

New order: sender is an active registered machine → **shape** (does the mandate carry exactly one
authority, a `subscription-relogin-configure`?) → its registered key
→ R4a signature → not revoked → not expired → `targetMachineId === self` → `configDigest`
matches `^sha256:[0-9a-f]{64}$`. A configure-only mandate passes both gates regardless of
follow-me or repair state (turning repair on is the point). A mandate mixing configure with any
other authority → `mixed-authorities`. Every other mandate keeps today's path byte-for-byte.
The follow-me consumer sweep filters to `account-follow-me` authorities, so configure mandates
stay invisible to it.

### 5. Restart request

`applySubscriptionReloginOperatorConfig` writes an unversioned restart request (no
`targetVersion`) and clears an unversioned restart count, the shape
`writeConnectRestartRequest` uses, so a setting change is never counted as an update restart and
the Telegram lifeline is not restarted with it. This also fixes the existing `configure` route.

### 6. Dashboard: the "Automatic sign-in repair" section (console Accounts page)

The console is the dashboard now (`/dashboard`); the old Subscriptions tab is the legacy page
and is not changed. The section goes on the console Accounts page (`dashboard/console/accounts.js`
with its model in `accounts-model.js`), which already reads `/subscription-relogin?scope=pool`
and already has `askPin({ adapter: 'session' })` for repair. No extra read is added.

Per machine row (machine name via `verifiedDisplayName` and the page's machine names, never a
raw id):

- Current state in words: "On, repairs without asking", "On, asks you first", "Watching only",
  "Off", "Couldn't read this machine" (with a "Check again" action that re-renders the page),
  "Needs an Instar update first" (with a link to that machine on the console Machines page).
- What the tap will write, specific to the button: for "Turn on", the machine's own
  `verifiedPoolEmails` as the new list, with **removals marked** ("stops: x@y") and **missing
  accounts counted** (verified emails not on the current list: "2 accounts on this machine aren't
  covered yet"), and the waits (0/0 on this machine; unchanged on another machine). For "Switch
  back to asking first", the current list and waits, unchanged.
- What will still ask, from the blockers the page already holds: "1 of 6 accounts will still
  ask: needs a sign-in profile here".
- When unattended is chosen for this machine: "Repairs will run without asking, including
  accounts never repaired on this machine. Choosing this also lets a tap on another of this
  agent's machines keep this machine's account list up to date." If this machine currently has
  non-zero minimums: "This also removes the wait of N repairs / D days."
- **Finish restarting**: any row (this machine or another, any mode) whose `activationPending` is
  true shows this action, whatever the tick rules. It is a restart-only operation that never
  rewrites the setting: the fronting route takes `{ "action": "finish-restart", "targets": [ {
  "machineId", "expectedRevision" } ] }`; for a peer the mandate's `configDigest` binds
  `{ action: 'finish-restart', expectedRevision }`. The target verifies the mandate as in §3
  step 1 and consumes it immediately (single use, whatever the outcome), requires its current
  on-disk revision to equal `expectedRevision` (→ else `409 stale-config`) and
  `activationPending` to be true (→ else `200 { changed: false }`), then writes only the restart
  request. This is the recovery for a crash between the config write and
  the restart request, in any mode and with any waits.
- When a machine's waits are not zero: "Will still ask until N repairs / D days have passed on
  each account" (another machine's waits are never changed from here).
Ticks: a machine already unattended starts ticked. **The machine you are on** can be ticked in
any state (it is the owner's own dashboard), and starts unticked unless already unattended. Any
**other** machine that is not already unattended cannot be ticked and says "Turn this on from
that machine's own dashboard", linking to that machine when its address is known. An unreadable
or older machine cannot be ticked.

| Result codes | What the row says |
|---|---|
| ok | "On, repairs without asking" / "On, asks you first", plus "— restarting" while activation is pending |
| `route-missing`, `delivery-refused` | "This machine refused; it may need an Instar update" + link |
| `target-unreachable`, `delivery-failed` | "Couldn't reach this machine" + "Try again" |
| `stale-config` | "Its setting changed meanwhile; check the row and tap again" (the page re-reads) |
| `outcome-unknown` | "May have applied; checking again" (the page re-reads) |
| `owner-must-enable-here` | "Turn this on from that machine's own dashboard" + link |
| everything else | "Not changed: <one plain sentence for the code>" |

Buttons: "Turn on for ticked machines" (unattended) and "Switch ticked machines back to asking
first" (approval; enabled only when every ticked row is currently unattended). Both use
`askPin({ adapter: 'session' })` and the same 401 → `forgetOperatorSession()` → "tap again"
handling as repair. The tap opens a sheet that shows each row "Working…", then ✓ with the applied
mode ("On, repairs without asking — restarting" while `activationPending`) or ✗ with a plain
reason and a next step. The sheet keeps the results even while the fronting machine restarts;
after about 30 s it re-reads and shows a machine as confirmed when its revision equals the
`revision` the write returned **and** `activationPending` is false; a different revision is shown
as "Changed again since" (superseded).

Home's "needs you" count is not changed: an uncovered account is not stuck, its repair simply
asks for one tap, and that tap already appears on Home through the existing `accounts` need
source. The section is reached from the Accounts page and from the agent's link.

Deep link `#/capacity/accounts?s=auto-repair` scrolls to the section (a new `want ===
'auto-repair'` branch next to the existing `needs` one, using `arrivalScroll`).

Tick state survives the page's 30-second re-render: the section holds the ticks in page-module
state keyed by machine id, and marks itself `data-interaction-open` as soon as any tick differs
from its default, so the console's `refreshHeld` keeps the rebuild off it until the tap is sent
or the ticks are reset. The re-read after a tap happens 30 s later (the supervisor polls every
10 s and a restart takes about 15 s); a machine whose revision has not changed yet shows "Not
confirmed yet; checking again" and is re-read once more 30 s later, then left as "Not
confirmed" with the "Finish restarting" action.

### 7. Agent awareness, registries, migration

- CLAUDE.md template: edit the existing line that says a PIN unlock "can safely configure this
  on any machine with `POST /subscription-relogin/configure`" to point at the card, and add a
  "One-tap repair setting" entry next to "One-click repair across all machines": the section, what
  the rows mean, and the trigger "user wants repair on everywhere, or an account was added and its
  row shows it isn't covered → send the direct link (the console Accounts page with
  `?s=auto-repair`) to the section; never call the configure routes
  yourself". Mirrored by a content-sniffed `migrateClaudeMd` addition.
- State-coherence registry: `fleet-config`'s description names `subscriptionPool.assistedRelogin`
  as a per-machine field that must not be whole-file synced. The delivered-mandate store
  (`state/delivered-mandates.json`) already exists for repair-cell and is unregistered; it is not
  registered here, because the registry requires a retention policy and the store never prunes
  (listed under Left behind in the convergence report).
- No config defaults change. No hooks, scripts or skills change. After a revert the stored
  `generation` key is simply ignored (the runtime and the old validator read named fields only).
- The restart request never overwrites a pending update restart (one that carries a
  `targetVersion`); that restart applies the setting too.

## Decision points touched

| Decision point | Classification | Basis / floor |
|---|---|---|
| Who may start a change (fronting route guard) | invariant; basis: irreversible-consequence; evidence: turns on autonomous credential repair across machines; the existing configure route already reserves this for the session header, and the new route matches it (no weaker PIN-in-body path) | `verifyDashboardOperatorSession` |
| Peer accepts a configure mandate | invariant; basis: irreversible-consequence; evidence: a forged, replayed or retargeted mandate changes a machine's credential-repair policy; these checks bound what a signer can do (§ Honest scope), they do not prove a human | shape → active sender → registered key → R4a → expiry → target → digest → consume |
| Peer accepts only live unattended or live approval | invariant; basis: enumerable-domain; evidence: the card has exactly two actions | closed set |
| Identities must be the target's own verified pool emails | invariant; basis: enumerable-domain; evidence: the allow-list can only ever act on this machine's own accounts, which this machine enumerates itself | target-side subset check |
| Command ordering | invariant; basis: irreversible-consequence; evidence: without ordering a delayed "turn on" can undo a newer "switch back"; a content hash alone allows A→B→A | revision = closed metadata + monotonic generation, compare-and-set |
| Which machines change | judgment-candidate; floor: only ticked machines change, and another machine can only be turned to "without asking" remotely if its owner already chose that; arbiter: the operator; conservative default: only already-unattended machines start ticked; fallback: other machines not already unattended, unreadable or older machines cannot be ticked | operator choice + target-side owner-consent check |
| Remote "without asking" only on a machine already unattended | invariant; basis: irreversible-consequence; evidence: a machine left off, watch-only or "asks first" has not been opted into autonomous repair; escalating it remotely overrides that per-machine choice in a way no later undo restores | target-side mode check; the machine's own dashboard is the opt-in surface |
| Thresholds 0/0 on "turn on" | judgment-candidate; floor: the in-run identity verification and quarantine, the 3-failures-in-24h breaker, `maxAttempts`, and lifetime holds after any identity mismatch or unexpected origin; arbiter: the operator, with the row stating that never-repaired accounts will repair without asking and naming any wait being removed; fallback: that machine's own dashboard section, or "switch back to asking first" | Frontloaded decision 1 |
| Mandate expiry | invariant; basis: irreversible-consequence; evidence: issue, delivery and consume happen inside one request, so expiry never limits a legitimate use; it bounds how long an unconsumed mandate stays replayable. 15 minutes is the existing `repair-cell` lifetime on the same delivery path | reused constant |
| Peer fan-out concurrency 4, timeouts 15 s / 15 s, response deadline 90 s | invariant; basis: external-constraint; evidence: the Cloudflare tunnel cuts requests at ~100 s, so the response must come back inside it; 15 s per step matches repair-cell's apply timeout and the mesh delivery timeout; work not finished by the deadline is reported `outcome-unknown` and settled by the card's re-read, never claimed done | request execution bounds |


## Frontloaded Decisions

1. **"Turn on" sets thresholds to 0/0.** Leaving 10 repairs / 30 days would make the tap look done
   while repairs keep asking for a month. The real floor that remains is named in the decision
   table, and the card states plainly that never-repaired accounts will repair without asking and
   names any wait it removes. The Studio was configured 0/0 through the PIN route on 2026-09-23.
2. **The allow-list is the exact list on screen**, replacing the old list; removals are marked on
   the row. The target refuses any email it does not hold.
3. **Undo on the same card; full off stays local.** "Switch back to asking first" only applies to
   machines currently unattended. Disabling repair entirely stays on each machine's configure route.
4. **No consent flag; consent is the mode, set by the one operator principal.** See §3 step 4
   for the reasoning. A per-machine `acceptRemoteConfigure` switch, a recorded
   `remoteListRefresh` flag, a local "list follows this machine's pool" option, and pull-based
   desired-state reconciliation were all considered. The flags block the goal (other dashboards
   are not reachable from the phone) without guarding anything the agent-wide PIN does not
   already allow; "follow the pool" changes the parent spec's exact-email rule for every reader of
   it; reconciliation adds a replicated record for one action. The only new stored field is
   `generation`. A machine that receives no tap is unchanged. Rollback is a revert.
5. **Older peers** show "Needs an Instar update first" and cannot be ticked; the API maps their
   refusal to `route-missing`.
6. **The foundation's trust gaps are filed, not fixed here** (PIN-in-body without attempt limit on
   the existing relogin routes; any active peer counts as the operator machine; hard-coded
   `author: 'justin'` defaults). This change does not widen them: its own route is header-only and
   its peer path is bounded as described.

## Multi-machine posture

- The read: proxied-on-read through the existing `GET /subscription-relogin?scope=pool` fan-out.
- The write: fan-out from the fronting machine with one signed, exact, ordered, single-use
  authority per target.
- Each machine's repair setting stays in that machine's own config file (a unified setting
  would be infeasible, and would also erase per-machine owner consent: a remote tap can only set
  "without asking" on a machine whose owner already chose it there, §3 step 4, so Adriana's M5
  Pro, currently off, cannot be switched on from another machine at all).
  - machine-local-justification: physical-credential-locality impossible-because="the allow-list governs re-minting the login slots and sign-in browser profiles that exist only on this machine's disk, and a Claude or Codex login is re-minted per machine, never copied; the same email on another machine is a different credential with its own repair path" permanence=permanent
- Delivered configure mandates live in the target's `state/delivered-mandates.json`, the same
  store `repair-cell` uses.
  - machine-local-justification: physical-credential-locality impossible-because="a delivered mandate is a single-use authorization addressed to one machine; its spent marker must live where it is consumed, and a copy on another machine would let the same authorization be consumed twice" permanence=permanent
- One voice: the card is a dashboard surface on the machine the operator is using; no notices.

## Open questions

*(none)*

## Testing

- Unit: canonical digest (sorted identities, revision bound); revision of closed metadata;
  `acceptMandateDelivery` configure shape (accepted with follow-me and repair off; other target,
  bad digest, mixed authorities refused; follow-me path unchanged); `authorizeMandateDeliver`
  admits the configure-only shape; `verifyDeliveredConfigureMandate` (mismatch, expired,
  consumed); unversioned restart request; dashboard card render (default ticks, untickable rows,
  removals, missing count, still-ask lines, approval button enablement, sanitized names) in the
  console accounts model, and the tap flow (401 → forget session, per-row results kept).
- Integration: real `AgentServer` HTTP — `config` in `GET /subscription-relogin` (also with the
  runtime off); `configure-pool` refuses without the header and refuses a body PIN; self target
  writes config + generation + provenance audit + unversioned restart; `configure-with-mandate`
  refuses (mandate checked first) invalid-config, foreign identity, wrong digest, stale revision,
  approval-when-not-unattended, off/watch-only targets (`owner-must-enable-here`) and replays;
  applies once with a valid delivered mandate on a `developmentAgent: false` agent that is
  already unattended (list refresh, minimums unchanged), refuses a remote approval → unattended
  (`owner-must-enable-here`) and a remote minimums change (`invalid-config`); A→B→A with an outstanding mandate issued against A is refused `stale-config`; an
  identical re-tap with activation pending re-writes the restart request.
- E2E: production init path — `configure-pool` and `configure-with-mandate` are alive (not
  404/503), `GET /subscription-relogin` carries `config`, and the section ships in the console
  Accounts page.

## Maturation plan

- **test-agent-live:** a throwaway agent (`developmentAgent: false`) driven through the real
  console Accounts section: turn its own machine on from off, switch back to asking first, and
  finish a restart; plus the HTTP integration pair (a fronting server and a target server with a
  delivered mandate) for the remote list refresh, the stale-revision refusal and the
  off-machine refusal.
- **dev-agent-live:** live on the development agent (Echo's five machines) from the release that
  carries it; the operator gets one direct link to the section. Watch each machine's
  `logs/subscription-relogin-config.jsonl` for `via` lines and the section's confirmed rows.
- **fleet:** the same release; ungated. A machine that receives no tap is unchanged, so the
  fleet sees only a new read-only section until an operator taps.
- **graduation criterion:** on the development agent, one real tap that refreshes the list on at
  least two machines already set to "without asking", each shown as confirmed (revision matches
  and activation no longer pending), with a `via: mandate` audit line on the peer and
  `via: configure-pool-self` on the fronting machine; and a refused remote "turn on" on a machine
  that is not unattended (`owner-must-enable-here`) observed once. A zero count is not a pass.
- **dark-window:** none, it ships live. If the criterion is not met within 7 days of the
  release reaching the development agent, the reason and a new date go on the commitment
  tracking this build.
- **ladder:** not applicable: no flag, it ships live and is inert until an operator taps.

## Rollback

Revert the PR. Machines already switched keep the config the operator chose, reversible through
each machine's configure route. Stored configure mandates are ignored by the reverted code
(`readFollowMeBounds` returns null for them).
