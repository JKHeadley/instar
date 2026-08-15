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
2. **PENDING — enrolment**: wire that resolver into the pool's verified-add path
   so Codex accounts can be enrolled at all.
3. **PENDING — latency/error swap trigger**: extend the proactive-swap monitor to
   fire on degradation, not only on quota. Dark + dry-run first.
4. **PENDING — failure-swap tail**: prefer the sibling Codex account before
   falling through to `claude-code`.

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

## Evidence (piece 1)

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
