# Round-6 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `b62f562ae`
(round-6 revision).
**Report commit:** this file.
**Round-6 status: NOT CONVERGED.** 1 CRITICAL + 1 MAJOR + 4 MINOR + 2 LOW.

All round-5 folds LANDED and HELD their walks — the release-purge-grace and
notice_pending mechanics both survive their own re-walks, and a fresh
internal adversarial walk (hold-flap oscillation) closes via existing text
(the TTL-at-release check bounds any hold↔release cycling at 24h, loud).
The two blockers are once again compositions of the newest folds: the
`--max-time` pin (round-6's own R5-m3 fold) composes with same-id enqueue +
the <1s event kick into an in-flight same-id double-post race (pi's catch,
the round's best), and the new terminal notice sweep shipped without its own
retry discipline (found independently by BOTH externals).

---

## Fold verification (round-5 findings, walks re-executed)

| Round-5 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| R5-C1 (`released_at` grace) | column + `max(attempted_at, released_at)` base | flip → release N rows (`released_at` stamped) → restart at +10min → base is 10min old → EXEMPT → drain completes ✓; grace never extends deliverability (TTL anchored `attempted_at`; TTL-at-release check §5:888) ✓; schema/migration/rollback text consistent (six columns everywhere) ✓ | **HELD** — the "ample for the rate-capped drain" parenthetical is arithmetically wrong for large backlogs (R6-m4), and the SQL semantics of `max()` need a pin (R6-m1) |
| R5-M1 (notice mechanics) | column + dedicated terminal selector + episode key + clear-on-2xx + honest bound | the sweep CAN see terminal rows now ✓; episode key distinguishes later episodes ✓; crash windows bounded ✓ | **HELD** — the sweep lacks backoff/fairness/rate discipline (R6-M1) and "never zero" overclaims vs a down attention surface (R6-m2) |
| R5-m1 (property-1 bounds) | loud-bound qualification | ✓ | **HELD** |
| R5-m2 (repair direction) | fallback = `attempted_at`; second-NULL escalates | direction ✓ conservative | **HELD** — the second-NULL detector's state is unstated (R6-m3) |
| R5-m3 (TTL anchor) | `attempted_at` = pre-POST mint time + `--max-time` | clocks re-anchored at the send ✓; composes with R5-C1 ✓ (released_at orthogonal) | **HELD** — but `--max-time` itself opens R6-C1 |
| R5-L1 | 25h in §8 | ✓ | **HELD** |

**Spot-regressions:** R3-C1 lane-flip — HELD; R3-C2 release predicates —
HELD (release now also stamps `released_at`, additive); R2 stampede /
purge / teamId — HELD (`max()` base applies to previously-held rows only;
Telegram rows have `released_at` NULL → byte-identical). **New adversarial
walk closed by existing text:** hold-flap oscillation (a flapping
`non-owning` condition re-holding with a fresh `hold_started_at` each
cycle) cannot park a row unboundedly — every RELEASE runs the
TTL-at-release check (§5), so cycling escalates loudly at 24h age.

---

## Reviewers who ran this round

**Internal pass** (six lenses + fold re-walks + grounding): the
"ample"-arithmetic correction (R6-m4 — watchdog-only drain is ~48 rows/hour
against a 60-min grace), the stale index note (R6-L2), and the oscillation
walk above.

**External cross-model passes (one bounded pass each, neutral grounding
pack):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict:
  `1 CRITICAL + 3 MAJOR + 0 MINOR + 1 LOW`. Its #1 (in-flight same-id
  race) is adopted as R6-C1 — the round's decisive catch, a genuine
  composition of two of the ceremony's own fixes. Its #3 merges with
  gemini #1 into R6-M1. Its #2 and #4 are downgraded to R6-m1/R6-m2 (the
  `max()` NULL break is caught by any Telegram-parity purge test and the
  prose is already conditional; the "never zero" fix is a wording + status
  field). Its #5 is R6-L1.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed),
  prompt on stdin** — RAN (exit 0). Verdict: `0 CRITICAL + 1 MAJOR +
  1 MINOR + 0 LOW`. Its #1 (the sweep retries at tick frequency with no
  backoff and no breaker — a P19-class gap on the new loop) independently
  overlaps pi #3 → consolidated R6-M1 at MAJOR (two-external overlap +
  P19 precedent). Its #2 (second-NULL detector state) is adopted as R6-m3.
- **codex-cli** — NOT RUN: not installed on this machine (all rounds).

---

## CRITICAL findings (blocking)

1. **The `--max-time` pin composes with same-id enqueue + the <1s event kick
   into an in-flight same-id double-post race the record-after-success
   ledger cannot see** `[pi-ext #1]`. Walk: the script POSTs id `D`; curl
   times out (`--max-time`, the round-6 R5-m3 pin — deployed scripts have
   NO client timeout, so this abandon-while-in-flight class is NEW) while
   the server handler is still awaiting a slow Slack API; the script
   classifies recoverable (curl exit → 000), enqueues `D`, and event-kicks;
   the sentinel redrives `D` within seconds; the route's ledger check
   misses (`D` is recorded only AFTER the first `sendToChannel` returns)
   → second post. Both content dedup and the id-ledger are
   record-after-success, so neither sees the in-flight first call; the E1
   funnel intent doesn't exist for the script's direct send. Not one of the
   three named residuals — a normal timeout race, widest exactly when Slack
   is slow (which is when curl times out). **Fix (both arms):** (a)
   single-flight at the route — the durable ledger takes a short-TTL
   IN-FLIGHT reservation for the delivery-id BEFORE `sendToChannel`; a
   concurrent same-id POST during the reservation gets a typed 409
   `delivery-in-flight`, which the funnel surfaces as transient → the
   policy retries at backoff (≥30s), by which time the first call has
   resolved (recorded → `idempotent:true`, or failed → the retry
   proceeds); the reservation expires at the route budget so a crashed
   handler never wedges the id. (b) epistemic parity at the script — a
   curl TIMEOUT (exit 28) is the client-side twin of HTTP 408 (the
   outcome is UNKNOWN, the send may still complete): classify it AMBIGUOUS
   (exit 0, the deployed 408 verify-before-resend guidance), never
   recoverable-enqueue. Conn-refused/reset keep the recoverable class —
   and arm (a) covers the reset-while-handler-in-flight variant. §7 pins
   the race shape both ways (in-flight second POST → 409 → exactly one
   post; timeout at the script → no enqueue, ambiguous guidance).

## MAJOR findings (blocking)

1. **The terminal notice sweep has no retry discipline — no backoff, no
   fairness ordering, no rate bound** `[pi-ext #3 + gemini-ext #1,
   independent — the round's strongest overlap]`. Failed raises keep
   `notice_pending=1` and the sweep re-selects at tick frequency: a
   persistent attention-surface failure retries the same LIMIT-window rows
   every 5 minutes forever (gemini's P19/DoS arm — the path deliberately
   bypasses the per-channel breaker and got nothing in its place), and a
   stable oldest-first ordering lets poison rows starve later episodes
   indefinitely (pi's fairness arm). **Fix:** reuse `next_attempt_at` on
   the terminal row (free — terminals don't use it) as the per-notice
   backoff anchor: on a failed raise, push it per the existing 9-step
   schedule, then hold a 4h floor cadence (never give up silently — the
   marker plus the §4.1 pending count are the record); the sweep selector
   adds the due-predicate (`next_attempt_at IS NULL OR due`) with
   oldest-due-first ordering, so failed rows back off while fresh episodes
   get attempts — fairness, rate-bounding, and the never-forgotten
   guarantee all from one reused column. §7 pins the poison-row shape (one
   failing notice never starves a later episode) and the outage shape
   (raises back off; on recovery all pending notices land).

## MINOR findings (batch)

1. **`max(attempted_at, released_at)` needs pinned SQL semantics + a clamp**
   `[pi-ext #2, downgraded]`. SQLite scalar `max()` returns NULL when any
   argument is NULL — a naive translation disables the staleness predicate
   for every never-held row (a Telegram-lane behavior regression the spec
   forbids). Pin `max(attempted_at, COALESCE(released_at, attempted_at))`
   (or CASE-equivalent), give `released_at` the same far-future corruption
   clamp `next_attempt_at` has, and add the §7 Telegram-parity regression
   case (a never-held row >60min old still purges at boot).
2. **"NEVER ZERO" overclaims against an unavailable attention surface**
   `[pi-ext #4, downgraded]`. While the surface is down there is no
   delivered notice — the honest property is "never silently forgotten:
   retried until accepted, pending surfaced". Reword, and add the
   `notice_pending` count to the §4.1 status surface.
3. **The second-NULL-anchor detector's state is unstated** `[gemini-ext
   #2]`. Pin: no separate memory — the detector IS the durable repair
   write's absence (the repair wrote `attempted_at` into
   `hold_started_at`; observing NULL again proves the write did not stick
   → storage corruption → escalate); an in-cycle repair-transaction
   failure escalates immediately.
4. **The "ample for the rate-capped drain" parenthetical is arithmetically
   false for large backlogs** `[internal]`. Watchdog-only cadence drains ~4
   rows/5min ≈ 48/hour; a released backlog beyond ~48 rows cannot clear
   inside the 60-min grace, so a restart >60min after a flip purges the
   tail loudly. Correct the arithmetic and state the bound as a decision
   (realistic soak backlogs are ≤ dozens; a mass backlog's tail-purge is
   loud, P18, and preferable to hours-late delivery per the staleness
   philosophy).

## LOW findings (batch)

1. **Stale column counts** `[pi-ext #5]`: §2.0 still says "three additive
   columns" (now six). Sweep all count language against the SQL block.
2. **Stale index note** `[internal]`: §2.2's "New index: none required"
   predates the terminal sweep; state that the sweep is served by the
   existing `(state, next_attempt_at)` index prefix (which the R6-M1
   due-predicate makes fully index-shaped).

---

## Convergence recommendation

**NOT CONVERGED.** 1 CRITICAL + 1 MAJOR block.

Trajectory: 3C+6M → 2C+3M → 2C+2M → 0C+1M → 1C+1M → 1C+1M. The plateau is
not stagnation — each round's blockers live exclusively in that round's own
newest material (R6-C1 is a composition of the round-5/6 fixes `--max-time`
× same-id enqueue; R6-M1 is discipline on the round-6 sweep), while
everything older keeps surviving re-walks: the cores are now four rounds
finding-free, the hold lifecycle three, the pre-POST mint two. The two
fixes are small and mechanical (a reservation state + a reused-column
backoff). One process note for the next round: both blockers were
introduced by folds that added NEW moving parts — round 7 should bias
toward the smallest possible mechanical closure.

**Verdict: NOT CONVERGED** (1 CRITICAL + 1 MAJOR + 4 MINOR + 2 LOW).
