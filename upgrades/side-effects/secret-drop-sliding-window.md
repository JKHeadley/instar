# Side-effects review — Secret Drop Sliding Window + Atomic Use-and-Consume

**Spec:** `docs/specs/secret-drop-sliding-window.md`
**Files:** `src/server/SecretDrop.ts`, `src/templates/scripts/secret-drop-retrieve.mjs`, `tests/unit/SecretDrop.test.ts`, `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing new is rejected. Submission validation (CSRF, required fields, R1a signature)
is unchanged. The sliding window only affects how long an accepted submission is
*retained*; it never rejects a submission or a retrieve. `--run` adds a code path but
the default retrieve/`--names`/`--consume` behaviors are byte-for-byte unchanged.

## 2. Under-block — what failure modes does this still miss?

- **Server restart loses an unconsumed secret.** Explicitly out of scope (in-memory by
  design); contract documented in the spec; encrypted-at-rest tracked as follow-up
  (`fb-391a4a30-de9`).
- **An agent that uses the destructive `consumeReceived`/`--consume` mid-flow can still
  drop a secret.** The `--run` mode + CLAUDE.md guidance steer away from this, but the
  standalone `--consume` is retained for back-compat and is still misusable. Mitigated,
  not eliminated. Accepted: removing `--consume` outright would be a breaking change to
  any caller already using it.

## 3. Level-of-abstraction fit

Correct layer. Lifetime management belongs in `SecretDrop` (it owns the store and the
timers). The atomic use-and-consume belongs in the consumer helper (it owns the
hand-off to the command). No higher/lower layer is a better owner, and no smarter gate
exists that this should feed instead.

## 4. Signal vs authority compliance

Compliant. This adds no decision point that gates information flow or blocks actions.
The `--run` "consume only on exit 0" is a success gate on a local subprocess, not an
authority over agent behavior. No brittle-check-with-blocking-authority is introduced.
(Ref: `docs/signal-vs-authority.md`.)

## 5. Interactions

- **Stuck-consumer timer:** still fires at 60s; `minutesUntilCleanup` now derives from
  `receivedDeadline` (true purge time) — more accurate, not less. The stuck timer is
  NOT re-armed on peek (deliberate: it's a "nobody has consumed this yet" nudge, and
  the absolute deadline it reports is fixed at submit). No double-fire, no race.
- **Cleanup timer:** centralized in `armReceivedCleanup`; each re-arm clears the prior
  timer first (no timer leak). `consumeReceived`/`shutdown` clear the timer, the stuck
  timer, AND the new `receivedDeadline` map (no map leak).
- **`--consume` flag and `--run`:** mutually independent; `--run` consumes via the same
  `?consume=true` endpoint after success. No shadowing.

## 6. External surfaces

- **Other agents:** the helper template change reaches every agent via the
  always-overwrite relay-script refresh; the server change ships via npm. CLAUDE.md
  awareness reaches new agents (scaffold) and existing agents (idempotent migrator
  block, tested). No external API shape change — `/secrets/retrieve/:token` and
  `?consume=true` are unchanged.
- **Timing/runtime dependence:** the window is wall-clock based (setTimeout); fake-timer
  tests cover the boundaries deterministically. No dependence on conversation state.

## 7. Rollback cost

Pure code revert — no data migration, no agent-state repair. Reverting restores the
fixed 5-min window and removes `--run`; the standalone `--consume` path is untouched
throughout, so nothing depends on the new behavior to function. The migrator block is
idempotent and additive (a revert simply stops adding the bullet; already-migrated
CLAUDE.md files keep a harmless accurate bullet).

## Tier

**Tier 2.** Risk floor 2 (safety-invariant proximity: SecretDrop / never-on-disk).
Declared at the floor — not below it. Full ceremony: converged + approved spec, ELI16,
this artifact, second-pass review, trace.

## Second-pass review (independent)

An independent reviewer audited this artifact against the code and verified each
claim: (1) no timer/`receivedDeadline` map leak — every add has a matching clear on
consume/shutdown/re-arm; (2) the sliding window cannot exceed the 30-min cap (the
`Math.min(IDLE, deadline−now)` clamp enforces it); (3) `--run` consumes only on exit
0, never on launch error or non-zero exit, and the value reaches the subprocess via
stdin only — never stdout/argv; (4) signal-vs-authority compliant (no brittle gate
with blocking authority); (5) the stuck-consumer timer is correctly NOT re-armed on
peek. **Verdict: "Concur with the review."**
