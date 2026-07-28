# Round-7 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `37b6056a0`
(round-7 revision).
**Report commit:** this file.
**Round-7 status: NOT CONVERGED.** 0 CRITICAL + 2 MAJOR + 5 MINOR + 0 LOW.

The round-7 convergence test held in one direction and taught in the other:
the fold added no new mechanisms, and correspondingly NO new failure CLASS
appeared — the second zero-CRITICAL round, and the only CRITICAL claimed this
round (pi's exit-28 walk) died under grounding. What remains are PRECISION
findings inside the two newest behaviors (the exit-28 classification's phase
blindness; the reservation TTL's relationship to the handler lifetime) plus
five pin-level minors. All older material is again finding-free.

---

## Fold verification (round-6 findings, walks re-executed)

| Round-6 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| R6-C1(a) (in-flight reservation) | short-TTL reservation before `sendToChannel`, typed 409, expiry restores retryability | reset-while-in-flight → redrive → 409 → backoff retry lands post-resolution ✓; crash-during-reservation → expiry restores retry, the crash-between-accept-and-record residual unchanged (already named) ✓ | **HELD** — two precision gaps: TTL vs a handler that outlives the route budget (R7-M2, grounded: the deployed budget 408s WITHOUT aborting the handler), and no explicit clear-on-failure (R7-m4) |
| R6-C1(b) (exit-28 → AMBIGUOUS) | 408-parity classification | no re-mint path ✓; the ambiguous guidance loop is coherent ✓ | **HELD as intent** — the classification is phase-BLIND (R7-M1): a connect-phase timeout is definitely-unposted and loses automated recovery |
| R6-M1 (sweep discipline) | due-predicate + oldest-due-first + 9-step/4h-floor on reused `next_attempt_at` | starvation ✓ closed (due-predicate); DoS ✓ bounded; no other reader of `next_attempt_at` touches terminal rows (claimable selector + purge both filter `queued/claimed`) ✓ | **HELD** — the schedule needs a step counter pin (R7-m1) and a permanent-failure class (R7-m3); the "fully served by the index" note overclaims (R7-m2) |
| R6-m1..m4, L1/L2 | folded | COALESCE pin ✓; clamp ✓; arithmetic ✓; detector ✓; counts ✓ | **HELD** |

**Spot-regressions:** all standing walks HELD (partition order, release
predicates + `released_at` grace, purge base, stampede, teamId, pre-POST
mint, lane-flip, notice episode key). The cores are five rounds
finding-free; the hold lifecycle four; the pre-POST mint three.

---

## Reviewers who ran this round

**Internal pass** (six lenses + fold re-walks + grounding): the
`delivery-in-flight` mapping-table gap (R7-m5 — the totality default would
raise a deduped attention item for a routine transient race); grounded
pi #1's live-proof arm to refutation and pi #2's premise to confirmation
(`OUTBOUND_MESSAGING_TIMEOUT_MS` 408s without aborting the in-flight
handler — `routes.ts:1965-1985` comment block; no adapter-level timeout
found in `SlackApiClient`).

**External cross-model passes (one bounded pass each, neutral grounding
pack):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict:
  `1 CRITICAL + 2 MAJOR + 1 MINOR + 0 LOW`. Its #1 is DOWNGRADED to R7-M1:
  the walk's live-proof arm is factually wrong (the script's curl targets
  the LOCAL server; the roadmap's network-kill scenario surfaces as a route
  5xx → recoverable enqueue, verified against `slack-reply.sh`'s target
  URL), and the residual loss class (server hangs past `--max-time`, then
  fails without posting) ends in LOUD verify-before-resend guidance — the
  deployed 408's accepted epistemics — not silence. The phase-blindness it
  identifies is real and adopted at MAJOR. Its #2 is adopted as R7-M2
  (premise grounded). Its #3 is downgraded to R7-m1 (a compliant minimal
  reading exists — a flat 4h push satisfies every stated guarantee — so
  the gap is a decision-pin, not non-function; distinct from the R3-M1
  class where no compliant reading existed). Its #4 is adopted as R7-m2.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed),
  prompt on stdin** — RAN (exit 0). Verdict: `0 CRITICAL + 1 MAJOR +
  1 MINOR + 0 LOW`. Its #2 (no permanent-failure class in the sweep retry
  discipline) is adopted DOWNGRADED as R7-m3 (bounded 4h-cadence
  pointless-retry, no loss — but the permanent/transient split is the
  house discipline everywhere else). Its #1 (clear-on-failure) is adopted
  as R7-m4 — the spurious-409 walk burns real recovery attempts
  (`attempts` feeds MAX_ATTEMPTS), which the internal pass had noted and
  wrongly skipped as noise.
- **codex-cli** — NOT RUN: not installed on this machine (all rounds).

---

## MAJOR findings (blocking)

1. **The exit-28 → AMBIGUOUS classification is phase-blind — a
   connect-phase timeout is DEFINITELY-unposted, and treating it ambiguous
   forfeits automated recovery for exactly the class the queue exists for**
   `[pi-ext #1, downgraded from CRITICAL — grounding in the reviewers
   section]`. curl exit 28 fires on `--max-time` regardless of phase: a
   timeout during CONNECT (server process wedged, port hanging) means the
   request was never sent — zero chance the message posted — yet the
   round-7 text exits 0 with verify-guidance and NO queue row. **Fix
   (phase-aware, one flag):** the script adds `-w '%{time_connect}'` (curl
   writes trailers even on failure): exit 28 with an empty/zero
   `time_connect` → the connection was never established → RECOVERABLE
   enqueue (the definitely-unposted class keeps its automated recovery);
   exit 28 with a nonzero `time_connect` → the request may have been
   accepted → AMBIGUOUS (the 408 twin, unchanged). §7 pins both arms.
2. **The reservation TTL is not pinned against the handler's maximum
   lifetime — a handler that outlives its reservation reopens the same-id
   race the reservation exists to close** `[pi-ext #2; premise grounded:
   the deployed route budget produces a 408 RESPONSE without aborting the
   in-flight handler, and the Slack adapter call carries no explicit
   timeout]`. Walk: POST A reserves, enters a slow Slack call; the
   reservation expires at the route budget while A is still in flight;
   retry B proceeds and posts; A then also completes → two posts. **Fix:**
   the adapter call made UNDER a reservation carries an explicit timeout
   strictly less than the reservation TTL (pinned values: adapter-call
   timeout 30s < reservation TTL 60s < first sentinel backoff step
   compositions); a handler that somehow exceeds its adapter timeout
   treats its OWN outcome as ambiguous — it must NOT record the id or
   claim success (its reservation is presumed lost). §7 pins the
   handler-outlives-TTL shape (B posts exactly once; A's late completion
   records nothing).

## MINOR findings (batch)

1. **The sweep backoff needs its step-counter pin** `[pi-ext #3,
   downgraded]`. Decision: REUSE the terminal row's `attempts` column —
   frozen at escalation time, incremented per failed raise from there; the
   schedule indexes `min(attempts, 8)` and converges to the 4h floor
   naturally; the hold-lifecycle ledger rows disambiguate the field's
   dual meaning on terminal rows.
2. **The sweep selector needs a partial index** `[pi-ext #4]`. Escalated
   rows accumulate (no terminal retention in the deployed store);
   `notice_pending` is a post-filter on the `(state, next_attempt_at)`
   prefix, so months of terminals force broad scans per tick. Pin:
   `CREATE INDEX ... ON entries(state, next_attempt_at) WHERE
   notice_pending = 1` (partial; corrects the round-7 "fully served"
   note).
3. **The sweep retry discipline needs the permanent/transient split the
   house applies everywhere else** `[gemini-ext #2, downgraded]`. A
   permanent-shaped raise rejection (4xx excluding 408/429) must not
   retry forever at the 4h floor: mark `notice_pending = 0` with a P18
   ledger row `notice-failed-permanent` + one loud DegradationReporter
   line + the §4.1 status gains a failed-notice count — never silent,
   never infinite.
4. **A definitive send failure explicitly DELETES its reservation**
   `[gemini-ext #1]`. Relying on TTL expiry makes the sentinel's ≥30s
   retry eat a spurious `409 delivery-in-flight` — which BURNS a real
   recovery attempt (attempts feed MAX_ATTEMPTS = 9) and inflates the
   backoff. The handler is alive on the failure path; it clears its own
   reservation.
5. **The §2.3 mapping table needs the `delivery-in-flight` row**
   `[internal]`. As written the typed 409 falls to the totality DEFAULT
   (transient + ONE deduped attention item) — an attention item for a
   routine transient race is noise. Pin the explicit row: transient retry,
   NO attention item, NO attempt-classification surprise.

---

## Convergence recommendation

**NOT CONVERGED.** 2 MAJOR block (0 CRITICAL — second zero-CRITICAL round,
and the only CRITICAL claimed died under grounding).

**Plateau read (requested by the coordinator):** genuinely NARROWING, with
a structural tail. Evidence for narrowing: severity is monotone-ish down
(3C+6M → … → 0C+1M → 1C+1M → 1C+1M → 0C+2M with the round-7 "critical"
refuted); every blocker for four consecutive rounds has lived exclusively
inside the immediately-previous fold's deltas; all settled material is
finding-free for 4-6 rounds. The structural tail: ANY fold that touches
mechanical behavior — even column reuse — reliably draws 1-2 precision
pins the next round, and the remaining finding CLASS is implementation-
grade pinning (timeout phases, TTL orderings, counter choices, index
shapes, failure-class splits) — exactly the material the build phase's
Testing Integrity gates also enforce via §7. Recommendation: round 8 folds
these seven as PURE precision edits (every fix is a parameter pin, a
classification split, an index, or a mapping row — zero new mechanisms).
If round-8 externals return 0C+0M → tag. If round 8 again produces a MAJOR
inside pure precision edits, STOP and surface this plateau analysis to the
operator with the explicit option of accepting remaining pin-class risk
into the build phase, where §7 is the enforcement surface.

**Verdict: NOT CONVERGED** (0 CRITICAL + 2 MAJOR + 5 MINOR + 0 LOW).
