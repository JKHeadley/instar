# Side-Effects Review — Codex pool enrolment + latency/error swap

**Version / slug:** `codex-pool-latency-swap`
**Date:** `2026-08-15`
**Author:** `Instar-echo`
**Charter:** Window 17 (operator-chartered, relayed by Observer 1)

## Summary of the change

Three related pieces, built in order. This artifact grows as each lands; the
sections below mark what is IN and what is still PENDING.

1. **IN — `codexSlotIdentity`**: reads which account is signed in at a Codex
   credential slot, offline, from the id_token already in `auth.json`.
2. **IN — enrolment**: `CompositeCredentialIdentityOracle` composes the Anthropic
   oracle so the pool's verified-add path accepts a Codex slot. All four
   production construction sites route through one factory.
3. **IN (foundation) — per-call account selection**: internal Codex calls can now
   target a specific pool account's credential slot. This was the missing layer
   under BOTH remaining items — see "The finding" below.
4. **IN (foundation) — per-account health**: `CodexAccountHealth` records how each
   account's calls actually went, and the provider feeds it. This is layer 2 of
   the three below.
5. **IN — the swap trigger**: `degradation` on `ProactiveSwapMonitor`. Reads (4),
   proposes a swap on latency OR error rate. Dark by default, dry-run first.
6. **PENDING — failure-swap tail**: prefer the sibling Codex account before
   falling through to `claude-code`. Also needs (3): `failureSwap` is a FRAMEWORK
   list with no account dimension.

## Why this exists (measured, not assumed)

Codex is the configured framework for 46 internal components. It is degrading:
a trivial prompt takes ~13s across three runs; `completion-claim-verify` and
`TopicIntentExtractor` sit at a 60s p50 — the ceiling, i.e. timing out rather
than erroring; the codex error rate ran 28.5% (72h) → 38.9% (24h) → 46.4% (6h) →
78.1% (1h). Quota is NOT the cause: 17% of the 5h window, no limit reached.

Two consequences make it more than background noise:

- `componentFrameworks.failureSwap` is literally `["claude-code"]`, so every
  Codex failure spends the subscription Codex exists to protect.
- Each stalled call holds one of 8 host spawn slots until timeout. Observed
  directly: operator-facing sends were refused 12 times in ~15 minutes during a
  live demo because the tone gate could not get a slot.

## Decision-point inventory

- **Slot identity resolution (piece 1)** — *new, read-only*. Produces an
  assertion about a local file. Feeds naming/de-duplication only.
- **Pool membership (piece 2)** — *widened*. Codex accounts become enrollable.
  The pool's existing duplicate + identity guards still gate every add.
- **Swap triggering (piece 3)** — *widened*. A new condition can propose a swap.
  Ships dark; when enabled, dry-run records the would-swap without moving anything.
- **Framework routing (piece 4)** — *reordered*, not widened. The same fallback
  set, tried in a different order.
- **Authorization** — *untouched throughout*. Nothing here grants a permission.

---

## 1. Over-block

Piece 1 can refuse to identify a slot (`unavailable` + a named reason). That
refusal only means "this slot cannot be enrolled yet" — it blocks no message, no
session, no existing account. It fails toward refusing to enrol rather than
enrolling something unverified, which is the safe direction for a guard whose
whole job is preventing two rows pointing at one login.

## 2. Under-block

- **The identity is asserted, not proven.** The id_token is decoded, not
  signature-verified. Stated plainly in the module: this is not authentication,
  and anyone able to edit `auth.json` can already use the credential itself. The
  result is used to label a row and never as a permission.
- **Enrolment does not prove the account is healthy** — only that it is signed
  in and distinct. A newly-enrolled account could be as degraded as the first.
  The latency trigger, not enrolment, is what notices that.
- **The latency trigger cannot fix a provider-wide outage.** If both Codex
  accounts are slow, swapping between them buys nothing; the failure tail is what
  covers that, and its last resort is still the main subscription.

## 3. Level-of-abstraction fit

Correct layers. Identity reading sits in the Codex adapter, which already owns
reading `auth.json` (for Rule-1 API-key detection). The trigger extends
`ProactiveSwapMonitor`, which already models exactly this shape — `loginLoss` is
a precedent trigger with the same enabled/dryRun structure, so this follows an
established pattern rather than inventing one.

## 4. Signal vs authority

The identity reader is pure signal. The swap trigger *proposes*; the existing
anti-thrash engine, work gate, and revalidation still decide and can refuse. No
new authority is created — a new condition feeds an existing authority.

## 5. Interactions

- **Framework safety was verified before being relied on**: `SwapAntiThrash`
  filters swap targets to the source account's framework, so a Codex session
  structurally cannot be moved onto a Claude account. This is what makes widening
  the monitor's session filter safe.
- **The quota poller already supports Codex** (branches on `openai`/`codex-cli`,
  reads usage per config home), so enrolled Codex accounts get real quota
  readings with no further work.
- No interaction with the outbound message path.

## 6. Multi-machine posture

**Machine-local by design.** Credential slots are physical directories on one
machine; a login on the Mini is not a login on the laptop. Pool account metadata
already replicates through its own existing path (`subscription-account-meta`)
and this change adds no new replicated state. Nothing strands on topic transfer.

## 7. Failure modes

- Credential file missing / unreadable / not JSON / no id_token / malformed JWT /
  no email claim → a named `unavailable` reason. Never throws into the enrolment
  path (pinned by a test across six malformed shapes).
- Degraded-health readings unavailable → the trigger simply does not fire; the
  existing quota trigger is unaffected.

## 8. Rollback cost

Piece 1 is additive and inert until called. The trigger is behind a config flag
that ships off. Enrolment is reversible by removing the pool rows. No schema
change, no migration, no agent state to repair.

## Evidence (pieces 1-2)

7 unit tests: real-shaped read; the enrolment property (two logins must resolve
to DIFFERENT identities, else "swap to the other account" could be a swap to
itself); file-over-claim precedence; two security canaries; every named failure
reason; never-throws across six malformed shapes.

Both security canaries carry controls — the planted secret is asserted absent
from the result AND asserted present in the bytes being read, so a clean scan is
a measurement rather than a check that could not fail.

Verified against the REAL credentials, not only fixtures: `~/.codex` and
`~/.codex-followme-sagemindai` resolve to two distinct accounts, both `pro`, with
no token material in either result.

### Added by piece 2

6 further unit tests on the composite (Codex slot resolves without touching the
network; a CONTROL asserting a non-Codex slot still reaches the Anthropic oracle
verbatim; unavailable passthrough; a broken Codex slot reported honestly rather
than mislabelled; a throwing probe degrading to Anthropic; two slots resolving
differently).

5 INTEGRATION tests — the tier that would have caught the real defect, since unit
tests of a reader pass whether or not it is wired. They drive the REAL registrar
against a REAL pool and assert BOTH directions: the Anthropic-only oracle REJECTS
a Codex account (so the fix has something to be a fix of), and the composite
enrols the same one. The identity guard is shown still biting — a caller-supplied
email contradicting the slot is refused, and a slot with no credential is refused
— so a clean pass is not the guard being switched off.

**Tier declared 1, below the gate's suggested 2** (size-driven; risk floor 1). The
override is recorded with reasoning in the decisions ledger. Rationale: the change
composes rather than replaces, the pre-existing path is pinned unchanged by a
control, and it creates no new authority — it widens which accounts may be
enrolled while every existing guard still gates the add.

## The finding that reshaped items 2 and 4

The charter read as though only the swap TRIGGER needed changing — "the machinery
exists but triggers on QUOTA". Verified against the code, three layers were
missing, and the trigger is the top one:

1. **Internal Codex calls never chose an account.** `CodexCliIntelligenceProvider`
   called `buildCodexChildEnv()` with no options, so the child inherited the
   ambient `CODEX_HOME` — every internal call landed on the default login. The
   ability to point a call at a slot existed in `codexSpawn` and was honoured; it
   was simply never used by this path. (Control: only `QuotaPoller` and
   `structuredOneShot` passed `codexHome`.)
2. **Latency and errors are not attributed per account.** `attribution` carries
   component/category/gating — no account. `AccountQuotaSnapshot` carries quota
   only. (Control: the same searches DO find per-account quota, so the absence is
   a measurement.)
3. **`failureSwap` is a framework list** (`{ door: fw }`), with no account
   dimension — so "prefer the other Codex account" has nothing to name.

So the charter's exit test — make one account artificially slow and watch a
would-swap — could not pass, not because the trigger was missing but because
nothing measured or selected the thing it would act on. Building the trigger alone
would have produced a dial wired to a dead gauge.

Piece 3 supplies layer 1. Reported to the charter author before building further.

### Added by piece 3

`resolveAccount?: () => CodexCallAccount | null` — a per-call CLOSURE, matching
`resolveExecJson`'s established pattern in the same file, because the router caches
built providers and a construction-time value would freeze the first answer.

**The load-bearing property is the null case, not the selection.** Absent or null
resolver ⇒ no `CODEX_HOME` override ⇒ byte-identical to before. Nothing is wired in
production, so adding the capability changes nothing until a later, deliberate act.
A throwing or malformed resolver also degrades to ambient: losing account selection
is a small loss, losing every internal Codex call is not.

8 unit tests, including the safety property (no resolver ⇒ no override), two
accounts genuinely distinguishable (without which "swap to the other account" has
no mechanism), per-call rather than per-construction resolution, all three
degradation paths, and a CONTROL that env scrubbing still holds when an account IS
selected — so account selection cannot become a way to smuggle the parent env into
the child. 45 pre-existing codex provider/env tests still pass.

### Added by piece 4 (layer 2 — the gauge)

`CodexAccountHealth`: a bounded, in-memory, time-windowed record of how each
account's calls went, exposing p50 latency and error rate per account.

**The load-bearing rule is honest-unknown.** `read()` returns `null` when it cannot
responsibly answer — no samples, or too few to tell degradation from variance. It
never returns a zero or an optimistic default, because a trigger acting on two
samples would move live sessions on noise, and a too-eager swap (thrash) is a worse
failure than a late one (a slow account stays slow a little longer). Deliberately
not persisted: health is a claim about the last few minutes, and a reading
resurrected across a restart would be a confident answer about a world that no
longer exists.

The provider feeds it via an optional `onCallObserved`, and the account is now
resolved ONCE and threaded down the call chain rather than re-read at each spawn
site — so the account RECORDED is provably the account USED. A gauge that can
disagree with reality is worse than no gauge, because a trigger acts on it with
confidence.

22 tests. Health store (10): median/error-rate from real samples; the
honest-unknown rule WITH a control (one more sample and it answers, so null was the
guard and not a broken store); unknown account; window expiry returning to
not-knowing rather than stale good news; accounts measured independently; readAll
omitting unanswerable accounts; bounded memory; never-throws on junk. Provider (12,
up from 8): successful AND failed calls both observed — a gauge that only sees
successes would read 0% errors however bad things got — nothing observed when no
account was named, and a throwing observer never breaking the call it measures.

35 pre-existing/adjacent codex tests still pass.

### Added by piece 5 (the trigger — the charter's deliverable)

`degradation` on `ProactiveSwapMonitor`, mirroring the existing `loginLoss`
extension exactly (enabled/dryRun, dark by default). A degrading account becomes a
swap candidate REGARDLESS of how full it is — which is the point, since quota was
never the problem (17% used while p50 sat at the 60s ceiling). It bypasses only
SOURCE pressure; target freshness, per-target ceilings, anti-thrash dwell and
execution-time revalidation all still apply, and `SwapAntiThrash` still refuses to
cross frameworks, so a Codex session can only ever land on another Codex account.

**Two safety properties carry this:**

*Unknown is not degraded.* `readHealth` returning null — too few samples, no data,
or a throwing gauge — means UNKNOWN and never selects a session. Acting on an
unknown is how a trigger starts thrashing.

*Rehearsal must not move anything.* The monitor has TWO pipelines: the braked one
(only when anti-thrash brakes are live) and the legacy one (everywhere else — i.e.
exactly where this ships). Wiring only the braked path would have left the trigger
silently inert where it actually runs; wiring the legacy path without its own
dry-run guard would have moved a live conversation on the trigger's FIRST firing,
the opposite of what dry-run means. Both paths are wired, and both rehearse.

9 tests, including the charter's own exit test — a degrading account produces a
dry-run would-swap and moves nothing. A CONTROL proves quota alone would NOT have
selected that account (17%), so the pass is attributable to the new trigger rather
than to ordinary pressure. A second control runs with `dryRun:false` and asserts a
real swap happens, so "nothing moved" is a deliberate choice rather than an
incapacity. Latency-alone and error-rate-alone both trigger; dark changes nothing;
a throwing gauge is unknown. 43 pre-existing swap-monitor/continuity tests pass.

### Added by piece 6 (item 4 — the failure tail prefers the sibling account)

The charter's first-flagged item, and the one closest to the money: the shipped
failure tail's LAST door is `claude-code`. So a failing Codex call ended its tail on
the main subscription — the cheaper door degrades and its failures land on exactly
the account that door exists to protect.

Piece 6 gives the tail an ACCOUNT dimension (layer 3 of the finding above): a
position may now name a same-door, different-account attempt, and those positions
are tried BEFORE any door change.

**Prepended, never substituted.** If every sibling also fails, the original door
tail runs exactly as before. This can only ADD an attempt ahead of the fall-through;
it can never remove the fall-through. A test pins the whole ordering
(`codex → codex-sibling → pi → claude`) precisely so a future edit cannot quietly
turn the enhancement into a replacement.

**The `target === framework` carve-out.** The loop skipped any position whose door
was the door that just failed. A sibling position IS that door, so without a
carve-out every sibling would be skipped and the tail would go straight to the next
door. The rule's purpose is "don't repeat the attempt that just failed", and
same-door-other-account is not that attempt — different login, quota window and
rate-limit state. The carve-out is scoped to positions carrying an account.

#### The defect a test found: identifying the account that failed

The first version excluded the failing account by id, and treated a null id
(an ambient call) as "excludes nothing". A test asserting a single-account agent
gets no siblings FAILED — correctly.

Internal Codex calls run on the ambient login, so `failedAccountId` is null in
production essentially always. Under the first version a single-account agent would
have been offered its own only account as a "sibling", buying one guaranteed-failing
retry against a gating deadline on every failure — and reporting it as a swap. The
logs would have claimed a move that never happened.

The fix identifies the ambient account by its HOME rather than its id, using the
derivation already verified in production (`ThreadlineBootstrap`:
`process.env['CODEX_HOME'] || ~/.codex`). Where neither identifier is available the
resolver returns nothing rather than guess. An ambient home matching no enrolled
account still yields a sibling — the primary ran on an unenrolled login, so every
enrolled account is genuinely different.

#### Over-block / under-block

*Over-block:* a `warming` sibling is refused even though it might work. Deliberate —
the tail is spending a gate's deadline, so a maybe is worse than the next door.

*Under-block:* eligibility reads `status`, which is as fresh as the pool's last
quota poll. A sibling that became unwell seconds ago can still be selected; it
simply fails and the tail continues. The cost is one bounded attempt, and the
existing per-target cap and total budget already bound it.

#### Signal vs authority

The router holds no eligibility opinion — it consumes an ordered list. Which
accounts qualify is decided by `eligibleSiblingAccounts`, pool-side, where account
state actually lives. The router's only judgment is ordering (siblings first).

#### Rollback

Delete the `resolveSiblingAccounts` line at the construction site. The option is
optional; absent ⇒ no sibling positions ⇒ the shipped tail byte-for-byte. No state,
no migration, no persisted field. A single-account agent is already a no-op.

#### Multi-machine posture

Machine-local BY DESIGN. A sibling attempt runs a local child process against a
local credential home, so only accounts with a real local login on THIS machine are
eligible (the empty-`configHome` exclusion is exactly the meta-only, replicated-from-
a-peer case). Nothing replicates and nothing is proxied.

#### Evidence

20 policy + wiring tests and 12 router tests. Both mechanisms were shown capable of
failing INDEPENDENTLY: reverting the carve-out fails 4 behaviour tests while the 8
controls keep passing; breaking only the account threading fails 3 — including
"the sibling attempt actually RUNS on the sibling account", which is the test that
separates a real move from a logged one. Removing the ambient-home exclusion fails
the single-account and production-case tests; removing the refuse-to-guess rule
fails its two. A CONTROL proves the headline result is attributable: with no
resolver the same failure walks the tail to Claude, so "never reaches Claude" is
caused by the sibling position rather than by an unreachable harness. 57 pre-existing
router/swap tests and 51 pool/swap tests pass.
