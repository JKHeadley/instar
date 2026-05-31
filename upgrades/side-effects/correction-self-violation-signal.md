# Side-Effects Review — Correction & Preference Learning: Self-Violation Signal

**Version / slug:** `correction-self-violation-signal`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required — observe-only + dark by default; the detector holds no blocking authority and cannot alter/delay/block any outbound message`

## Summary of the change

Extends the shipped Correction & Preference Learning Sentinel so a stored-but-violated
preference becomes a learning signal instead of evaporating. A learned preference can
carry an OPTIONAL `violationPattern` (regex or keyword set). When the agent sends an
outbound message that contradicts that pattern, the contradiction is recorded as a
self-violation in the `CorrectionLedger` (a recurrence-reinforcing `user-preference`
occurrence keyed on the violated lesson), so the preference's salience grows for the
next session-start injection.

Files: new `src/monitoring/SelfViolationDetector.ts` (pure `detectSelfViolation`);
`src/core/PreferencesManager.ts` (+optional `violationPattern` on `PreferenceEntry`
and `RecordPreferencePayload`, persisted/round-tripped, upsert-preserving); the
outbound seam in `src/server/routes.ts` (a new OBSERVE-ONLY `observeSelfViolation`
fire-and-forget branch inside `checkOutboundMessage`, structurally independent of the
tone-gate verdict); config `monitoring.correctionLearning.selfViolationSignal`
(types.ts + ConfigDefaults.ts); Agent-Awareness (templates.ts) + Migration-Parity
backfill (PostUpdateMigrator migrateClaudeMd).

## Decision-point inventory

- `detectSelfViolation(text, prefs)` (new) — add — pure, deterministic, returns the
  list of violated preferences. No authority; precision-biased (lone weak match never
  fires); never throws.
- `observeSelfViolation` seam branch (new) — add — records a matched violation to the
  ledger + an audit line. Fire-and-forget VOID; cannot influence delivery.
- `PreferenceEntry.violationPattern` (new optional field) — add — absent ≡ never
  checked (back-compat).
- Tone-gate / `checkOutboundMessage` block-decision — UNCHANGED — the observe branch
  runs before the gate-availability early-return and never feeds the gate or the
  return value.

---

## 1. Over-block

Not applicable. The feature has NO block/allow surface. The observe branch runs as a
fire-and-forget `void observeSelfViolation(...).catch(...)` that is structurally
incapable of returning a block verdict, throwing into the delivery frame, or mutating
the message. The wiring-integrity + E2E tests assert the message is delivered
byte-for-byte unchanged whether or not a violation is detected.

## 2. Under-block

There is nothing to under-block — the feature never blocks. The "miss" direction
(a real self-violation going unrecorded) is the deliberately-chosen safe direction:
precision over recall. A lone/weak keyword never fires, an unparseable pattern is a
no-check, and a preference without a `violationPattern` is skipped. A false
self-violation that nags is the bad direction, so the matcher is conservative. A
missed recording costs only a slightly weaker recurrence signal next session.

## 3. Level-of-abstraction fit

Correct. The detector is a pure, exhaustively-tested function (mirrors the
deterministic `scrubSecrets` / Layer-0 classifier discipline of the same sentinel).
The recording reuses the shipped `CorrectionLedger.record()` dedupe-upsert and its
`toApiView()` raw-text-stripping discipline; the occurrence is a `user-preference`
record at the code-determined `LEARNING_DETERMINISTIC_THRESHOLD` so it feeds the
existing 3-pronged recurrence gate exactly like any other distilled correction. No
new persistence layer, no new gate, no new authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — this change produces a SIGNAL (a ledger occurrence + an audit line) and
  holds ZERO authority over any message. The user's explicit hard rule ("we've been
  bitten by guards that block messages having too much power") is honored structurally:
  the observe call is a separate VOID branch that runs regardless of the
  `MessagingToneGate`'s verdict and never influences it. The single authority for
  outbound delivery remains the `MessagingToneGate` (rules B1–B17), entirely unchanged.

## 5. Interactions

- **Shadowing:** none. The observe branch is additive at the top of
  `checkOutboundMessage`; it does not read or alter the signals, the gate result, or
  the 422 path. With the tone gate null, the observe branch still runs (it precedes
  the gate-availability early-return) and the message still passes through.
- **Double-fire:** the ledger dedupe-upserts on `kind:normalizedLearningHash`, so
  repeated self-violations of the same preference collapse to ONE record with an
  incrementing `occurrenceCount` (asserted by the integration test) — never a pile.
- **Races:** the observe call is fire-and-forget and lazy-imports its modules; the
  ledger is the shipped WAL SQLite store (single-writer-safe, fail-open on any error).
  Two concurrent sends recording the same preference are both safely upserted.
- **Feedback loops:** none. The detector reads `.instar/preferences.json` (written by
  `recordPreference`) and writes the ledger; it never writes preferences, so it cannot
  amplify its own pattern. The CorrectionAnalyzer that consumes the ledger is
  off-hot-path (weekly cron) and only ROUTES via the existing by-construction
  authority-bounded driver.

## 6. External surfaces

- **Other agents / install base:** pure additive source + a default-OFF config
  sub-flag (auto-applied via ConfigDefaults; code reads `cl?.selfViolationSignal !==
  true` so an agent whose config lacks the field behaves identically — OFF). The
  optional `violationPattern` is fully back-compatible: shipped `.instar/preferences.json`
  files have no such field and are simply never self-violation-checked (unit-tested
  with a legacy-shaped file). Agent-Awareness + Migration-Parity are handled
  (templates.ts bullet for new agents; idempotent content-sniffed migrateClaudeMd
  backfill for existing agents).
- **External systems:** none. The detector is local + deterministic; no LLM call, no
  network. (Distinct from the capture/distill loop, which is a separate, already-shipped
  surface.)
- **Persistent state:** existing `correction-ledger.db` only (one extra occurrence
  row per matched violation, bounded by the shipped per-key occurrence cap). Plus a
  best-effort `[self-violation]` stderr audit line. No new files.
- **Timing:** none. No timers; the observe call is one bounded synchronous detect plus
  one ledger write, off the delivery path.

## 7. Rollback cost

Pure additive code + a default-off config sub-flag. Revert the commits → the detector,
the seam branch, the schema field, the config flag, and the awareness text disappear;
nothing else changes. Any ledger occurrences already recorded are inert and indexed
exactly like every other correction record (no schema change to the ledger). No
migration, no state repair, no user-visible behavior change (it never acted on a
message).

## Conclusion

This review confirmed the change is observe-only: a tested, precision-biased,
never-throwing decision function plus a fire-and-forget recording branch that is
structurally incapable of blocking, delaying, or altering any outbound message. It
ships dark behind both `correctionLearning.enabled` and the new `selfViolationSignal`
sub-flag, is fully back-compatible with existing preference files, and reuses the
shipped ledger's privacy + dedupe discipline. Clear to ship.
