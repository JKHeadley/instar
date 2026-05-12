# Side-Effects Review — project-scope Phase 1b PR 6 (Tone-gated round-complete message + delivery)

**Version / slug:** `project-scope-phase1b-pr6`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new outbound-message template + new disk-backed idempotency surface)`

## Summary of the change

Sixth PR of project-scope Phase 1b. Ships the two final primitives the
autonomous run loop will need to emit round-complete digests safely:

- `formatRoundCompleteMessage(input)` — pure template function. Enforces
  required-field PRESENCE (not non-emptiness, per spec § Phase 1.8 —
  the gate "never silently rejects on a legitimate halt"). Returns
  `{ok:true, message, idempotencyKey}` or `{ok:false, missingFields}`.
- `RoundCompleteDeliveryHelper` — retry + idempotency wrapper around
  a caller-provided send function. 3-attempt exponential backoff
  (1s, 2s, 4s defaults). Records the `(projectId, roundIndex,
  eventKind, projectVersion)` key in `.instar/local/round-complete-sent.json`
  after the first successful send so tone-gate retries don't produce
  duplicates. On permanent failure (all retries exhausted, or first
  non-transient response), the caller's `onPermanentFail` runs.

Nothing wires these up to an actual round-complete event yet — the
autonomous run loop is the consumer. PR 6 ships the primitives so the
run loop in a follow-up PR doesn't fork either of them.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.8.

New files:
- `src/core/ProjectRoundCompleteMessage.ts` (~290 lines) — the
  template + delivery helper described above. Pure ESM, no extra deps.
- `tests/unit/ProjectRoundCompleteMessage.test.ts` (20 cases) —
  template required-field gate (all 9 required + halt-flavor whatHalted),
  empty-string accepted, root-cause-default omitted, override link
  rendered, evidence-cap honoured, idempotency-key permutations,
  delivery first-attempt success, dedup short-circuit, transient retry
  to success, non-transient bail with fallback, all-transient exhaust
  with fallback, on-disk persistence across instances, no-record on
  total failure, template-reject suppresses send.

## Decision-point inventory

- **Template required-field gate** (`formatRoundCompleteMessage`) —
  **add** — rejects with `{ok:false, missingFields}` when any of the
  9 required fields is undefined / null / non-array (for `evidenceCited`)
  / non-integer (for `roundIndex`/`projectVersion`). Halt-flavor events
  additionally require `whatHalted` to be a string. Empty strings are
  ACCEPTED — the spec explicitly says presence is what matters.
- **Idempotency-key dedup** (`RoundCompleteDeliveryHelper.sendOnce`) —
  **add** — recorded only after a confirmed send. If all attempts
  failed, the key is NOT recorded, so a subsequent retry with the
  same input will be allowed to call `send` again. Bounded to 1000
  recent keys so the dedup file doesn't grow unbounded.
- **Fallback firing** (`onPermanentFail`) — **add** — fires once when
  all retries are exhausted OR a non-transient failure is reported.
  Caller decides whether the fallback path is attention-queue,
  audit-log, `awaitingUser` population, or all three. The PR 6
  delivery helper just signals "we couldn't deliver — your turn."

## Over-block vs under-block analysis

### Template gate
Over-block: an `evidenceCited: []` (empty array) is accepted —
required-field PRESENCE includes "array exists, possibly empty." The
gate would reject `evidenceCited: undefined`. Matches spec.

Under-block: there's no length cap on individual string fields. A
30,000-char `whatLanded` would render in full. Acceptable: outbound
content quality is the tone-gate's job (MessagingToneGate already
flags excessive verbosity). The template just builds the string.

### Delivery helper
Over-block: a non-transient failure bails immediately rather than
retrying. Matches the spec's implicit "permanent failure → fallback"
semantics — retrying a 401 / 400 won't help.

Under-block: dedup is keyed on `projectVersion`. If the project record
is mutated between send attempts (which it normally is — the
post-send tracker.update bumps version), a second attempt would have
a different key and re-send. This is intentional — the version bump
is what makes "same round, different state" distinguishable from
"same round, same state, duplicate send."

## Signal vs authority audit

The template is a pure function — no signal/authority overlap. The
delivery helper has authority only over its own idempotency ring; it
delegates transport entirely to the caller's `send` function.

## Interactions with existing systems

- **`MessagingToneGate`.** The caller (the autonomous run loop, not
  shipped yet) is responsible for routing the formatted message
  through the tone gate before calling `helper.sendOnce`. The helper
  does NOT call the tone gate directly — keeps the boundary clean
  and the helper unit-testable.
- **TelegramAdapter / Slack / WhatsApp.** None used here. The caller
  supplies the `send` function.
- **`.instar/local/`.** The dedup file lives at
  `.instar/local/round-complete-sent.json` — machine-local, NOT
  git-synced (same convention as the round-runner lock and the drift
  ledger lock). Two machines won't dedupe each other's sends, which
  is correct: each machine should make its own send decision and the
  recipient platforms (Telegram, Slack) handle their own dedup.
- **`SafeFsExecutor`.** Used for test cleanup; the in-class
  persistence uses tmp+rename atomic writes (matches the pattern in
  `MachineHeartbeat`).

## Rollback cost

Revert deletes `src/core/ProjectRoundCompleteMessage.ts` and the
test file. The on-disk dedup file becomes orphaned but harmless.
No schema migrations.

## What this PR explicitly defers (to PR 7+)

- **Wiring into the autonomous run loop.** The run loop is the
  intended consumer; it ships separately. Until then, no caller
  invokes `formatRoundCompleteMessage` or `sendOnce`.
- **Attention queue / audit log / `awaitingUser` integration.** The
  fallback callback is caller-provided; PR 6 only fires it. The
  concrete callback that wires those three downstream channels
  ships with the run loop.
- **MessagingToneGate routing.** Same — the caller threads the
  message through the gate; the helper accepts the formatted text
  as-is.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/ProjectRoundCompleteMessage.test.ts` —
  20/20 pass.
- Existing PR 1-5 invariants unaffected (no shared code touched
  outside the new file).
