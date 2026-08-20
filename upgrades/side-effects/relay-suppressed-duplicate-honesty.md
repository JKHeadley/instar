# Side-Effects Review — relay reports a suppressed duplicate as NOT SENT

**Version / slug:** `relay-suppressed-duplicate-honesty`
**Date:** `2026-08-20`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (see reasoning under §4)

## Summary of the change

The outbound Telegram relay reported messages as delivered that the user never
saw. When the server drops an exact repeat of a message already sent to a topic
recently, it answers **HTTP 200** with `{ suppressedDuplicate: true }`
(`src/server/routes.ts`, four call sites). `src/templates/scripts/telegram-reply.sh`
read only the status line, discarded the body, printed `Sent N chars to topic N`
and exited **0**. The exit status is the only delivery signal most callers check,
so a suppressed send was indistinguishable from a successful one — the agent
moved on believing it had answered.

Three changes:

1. `src/templates/scripts/telegram-reply.sh` — seven lines inside the existing
   `HTTP 200` arm: if the body carries `suppressedDuplicate: true`, print
   `NOT SENT — suppressed duplicate for topic <id>…` (naming the delivery id when
   the server supplied one) and exit **1**.
2. `src/core/PostUpdateMigrator.ts` — register the pre-fix template's sha256
   (`4464581188f5c736…`) in `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`. Instar agents
   update in place, so a template-only change reaches only newly created agents.
   Without this entry the SHA-history migrator classifies every deployed copy as
   locally-modified, writes a `.new` candidate beside it, and every existing agent
   keeps the mis-reporting script. **The registration is the deliverable, not an
   extra** — `tests/integration/…-migration.test.ts` fails without it.
3. Tests at all three tiers (unit / integration / e2e).

## Decision-point inventory

The suppression decision itself is **not** touched. It is made server-side and
already exists; this change only reports it.

- `src/server/routes.ts` duplicate suppression — **pass-through** — unchanged; the
  server still decides what to suppress and still answers 200.
- `telegram-reply.sh` outcome rendering — **modify** — a reporting branch, not a
  gate. It renders an outcome the server already chose.

---

## 1. Over-block

**No block/allow surface — the script blocks nothing.** By the time this branch
runs, the send has already happened or already been dropped by the server.

The analogous risk is a **false NOT SENT**: if the branch claimed suppression on a
message that was genuinely delivered, an agent would re-send text the user already
has. Three properties bound this, each pinned by a test:

- The check is Python's `is True`, not a truthiness test. `"suppressedDuplicate":
  "true"` (a string) does **not** trigger it.
- A missing key, an explicit `false`, or a non-JSON 200 body fails toward
  `Sent …` — the status quo — because an unparseable body is not evidence of
  suppression.
- If `python3` is absent, `2>/dev/null` makes the `if` false and the script falls
  through to the old behavior. `python3` is already a hard dependency of this
  script (31 pre-existing uses, documented at line ~311), so this adds none.

Every uncertain input therefore resolves to the pre-change behavior, never to a
false refusal.

---

## 2. Under-block

Honest gaps that remain after this change:

- **A caller that ignores the exit status still learns nothing.** The signal is
  stdout plus exit 1; anything discarding both is unaffected.
- **Only the `suppressedDuplicate` shape is covered.** Other ways a send can end
  without reaching the user (a tone-gate hold, the 408 ambiguous path) keep their
  existing separate branches; this change neither improves nor degrades them.
- **`.claude/scripts/` and `.instar/scripts/` are the two copies migrated.** A copy
  an operator placed elsewhere is not reached, by the same rule that has always
  governed this migrator.
- **A locally-customised script is deliberately not fixed.** It gets a `.new`
  candidate and a degradation event; the operator reconciles it. Preserving
  customisation is the existing contract and is worth the residual dishonesty on
  those installs.

---

## 3. Level-of-abstraction fit

This is at the **reporting** layer, which is exactly where the information was
being destroyed. The server already computed and transmitted the correct verdict;
the script threw it away. Moving the fix lower (into the server) would mean
changing the response status code away from 200 — a wider blast radius touching
every other caller of `/telegram/reply`, to fix a defect that lives entirely in
one consumer. Moving it higher (an LLM gate) would be absurd for reading a boolean
the server already decided.

It re-uses the primitive already present: `BODY` is captured two lines above and
was simply unread. No new parsing machinery, no new dependency, no new state.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface.**

The branch holds no authority: it cannot cause or prevent a send. It transcribes a
verdict an existing authority (the server's suppression logic) already reached and
already put in the response body. This is the opposite of the anti-pattern the
principle guards against — rather than a brittle detector acquiring blocking power,
an existing authority's decision stops being silently discarded.

Because there is no block/allow surface and no gate/sentinel/watchdog behavior, the
Phase-5 second-pass trigger list does not apply. Recorded as `not-required` rather
than skipped: the change modifies outbound-messaging *reporting*, which is adjacent
to the trigger list, so the reasoning is stated explicitly here for review.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** There are no
competing signals to weigh: exactly one authority (the server) produces exactly one
unambiguous boolean, transmitted in the same response. Reading a field is not a
judgment; the domain is enumerable and the invariant is "report what the server
said."

---

## 5. Interactions

- **Shadowing:** the branch is the first statement inside the `HTTP 200` arm and
  can shadow only the `Sent …` line in that arm — which is precisely the
  intent, and only when the server says the message was suppressed. It cannot
  shadow the `408`, `409`, `422` or transport-ambiguity branches, which are
  `elif`/earlier arms. A test asserts a 408 response still renders `AMBIGUOUS`.
- **Double-fire:** none. It emits at most one line and then exits; it enqueues
  nothing and posts no delivery-failure event.
- **Races:** none. It reads a local shell variable already captured from a
  completed HTTP response, and shares no state with concurrent code.
- **Feedback loops:** exit 1 is the intended new input to the caller. The relevant
  question is whether it could provoke a retry storm: it cannot, because the
  condition is *this exact text was already delivered to this topic recently* — a
  retry of the same text hits the same suppression and reports the same honest
  refusal, rather than being silently absorbed. That is strictly better than the
  prior behavior, where the agent believed the first send had landed.

---

## 6. External surfaces

- **Other agents / install base:** every agent that updates receives the new script.
  The user-visible change is that a previously-silent failure now announces itself.
- **Callers parsing stdout:** the `Sent N chars` line is unchanged on the success
  path. The new line appears only on suppression, where the old output was a false
  success.
- **Exit-status contract:** this is the one genuine behavioral change — a case that
  used to exit 0 now exits 1. That is the fix. Wrappers treating any non-zero exit
  as "relay broken" will now surface a suppressed duplicate as a relay error, which
  is a truthful, if blunt, improvement over reporting it as sent.
- **External systems:** none. No Telegram API change, no new endpoint, no network
  call added.
- **Persistent state:** the migrator writes one backup under
  `.instar/backups/telegram-reply.sh.<ts>` on upgrade — the pre-existing behavior of
  this migrator, not new.
- **Operator surface (Mobile-Complete):** no operator-facing action is added or
  touched. Nothing to complete from a phone.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, approval page, or
grant/revoke/secret-drop form is staged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with the reason: the relay script is a file on each
machine's own disk, executed by that machine's sessions, and the duplicate
suppression it reports is a decision made by *that machine's* server about *that
machine's* recent sends. There is no shared state to replicate and no merged read
that would be meaningful — "which machines have the fixed script?" is answered by
each machine running its own `PostUpdateMigrator` on its own update, which is the
existing distribution path for every shipped script.

- **User-facing notices:** none emitted by this change. The line goes to the
  calling session's stdout, not to a user channel, so no one-voice gating applies.
- **Durable state:** the only durable artifact is the machine-local backup file,
  which is not conversation state and cannot strand on topic transfer.
- **Generated URLs:** none.

A second machine changes nothing about this feature's correctness: each machine
independently updates and independently reports its own suppressions.

---

## 8. Rollback cost

- **Hot-fix release:** revert both source changes and ship as the next patch. Pure
  code and template; no data migration, no agent state repair.
- **Honest rollback asymmetry worth knowing:** agents that already migrated keep the
  fixed script. On a revert their on-disk copy would no longer match any registered
  SHA, so the migrator would leave it in place and drop a `.new` candidate beside
  it. The practical effect is that a rollback stops *new* agents from getting the
  fix but does not un-fix already-updated ones. That is the safe direction (nobody
  regresses to being lied to), and it costs one stray `.new` file per agent, which
  the existing degradation event already surfaces.
- **User visibility during rollback:** none — no user-facing surface changes.

---

## Conclusion

The review found no over-block surface, because the change adds no authority: it
reports a decision the server had already made and the script had been discarding.
The one genuine behavioral change is the exit status on a previously-silent failure
path, which is the point of the fix. The review's substantive contribution was
forcing the fail-open direction to be checked explicitly — a false `NOT SENT` is
the only way this could harm a user, and it is bounded by an `is True` identity
test plus fail-through on unparseable, missing, and non-boolean values, each pinned
by a test.

The second finding worth recording is that the migration, not the script edit, is
the load-bearing half. This was verified rather than asserted: removing only the
registered SHA and re-running the integration tier fails four tests, including the
one asserting a deployed pre-fix script is actually patched. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required — see §4. The change adds no block/allow decision, no
session-lifecycle behavior, and no gate, sentinel, guard, or watchdog. The Phase-5
trigger list does not match.

---

## Evidence pointers

- The fix is byte-identical to a version proven in live operation on the authoring
  machine before being carried upstream; the patched template matches that running
  script exactly (`diff` clean).
- `tests/unit/telegram-reply-suppressed-duplicate.test.ts` — 8 tests. Verified to
  fail for the right reason: against the pre-fix template the 3 detection tests
  fail while the 5 no-regression guards pass in both directions.
- `tests/integration/telegram-reply-suppressed-duplicate-migration.test.ts` —
  8 tests. Verified load-bearing: removing only the registered SHA fails 4.
- `tests/e2e/telegram-reply-suppressed-duplicate-alive.test.ts` — 8 tests. Captures
  the defect on a pre-existing agent, runs the real public `migrate()`, then
  executes that agent's own migrated script and asserts it now reports honestly.

---

## Class-Closure Declaration (display-only mirror)

**Not applicable — no agent-authored-artifact defect.** The defect is in a shipped
shell template's handling of an HTTP response body, not in an LLM prompt, hook,
config, skill, or standards text. The registry at `docs/defect-classes.json` was
read and carries no class matching a shell consumer discarding a response field.

Explicitly on the `unbounded-self-action` class: **not applicable.** This change
adds and modifies no self-triggered controller — no loop, monitor, sentinel,
reaper, scheduler, or recovery path, and it fires no restart, swap, respawn, spawn,
notify, retry, re-drive, or kill. It is a synchronous report of an
already-completed request, executed only when a caller invokes the script.
