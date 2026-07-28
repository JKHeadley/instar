# Side effects — opt-in candidate-body capture on the tone-gate provenance row

## The change

`buildToneDecisionContext()` gains an optional third parameter. When
`recordCandidateBody: true`, the decision-quality provenance context carries the
candidate message body — credential-scrubbed, length-clamped — alongside the
sha256/bytes/chars identity it has always carried. A `recordCandidateBody` knob is
added to `ToneGateConfig`, read live at the callsite via `getConfig()`.

Absent or false, behaviour is byte-identical to today. There is a test asserting
exactly that (`JSON.stringify` equality between omitted and explicitly-false), so
the no-op property cannot drift silently.

## Why this exists

The quality meter's purpose is to answer "was this block correct?" retrospectively,
in bulk, with a strong model. A sha256 cannot be re-read. An identity-only row hands
that judge nothing to judge, so the meter could measure timing and volume but never
correctness — the one thing it was built for.

The prior identity-only discipline was deliberate and documented; the operator
weighed the retention question directly (2026-07-23, topic 33368) and settled it:
the same text is already written to the session transcript on disk, so a second copy
in an operator-and-agent-only store crosses no new line.

## Blast radius

**Nil while the flag is off**, which is its shipped state — the key is OMIT-REQUIRED
and never seeded.

**When on**, the effect is bounded to what the provenance store holds. No gating
behaviour changes: `buildToneDecisionContext` is a pure context builder feeding an
observe-only side write. It cannot alter a block/allow verdict, cannot delay a send,
and the tone gate's fail-closed semantics are untouched.

Specifically NOT affected:
- The gate's verdict path, rule set, and fail-direction config.
- The served `decision` surface — context is machine-local, redaction-by-field-
  omission at `readRedacted` (an existing invariant, not modified here).
- Any other decision point's context builder.

## Content-safety properties, and why each is where it is

**Credential scrub.** Routed through `scrubForStore`, the same durable scrubber used
by every other content-bearing store. Redaction KINDS are recorded (`bodyRedactionKinds`,
deduped); offsets and matched text are not — knowing a credential was present helps a
judge, knowing where it sat helps nobody who should have it.

**Clamp before scrub, not after.** Load-bearing ordering. Scrubbing first and
truncating second can bisect a `[REDACTED:…]` marker and leave the tail of a real
secret past the cut — the failure mode being prevented, reintroduced by sequencing
two safe operations wrongly. Covered by a dedicated test placing a credential beyond
the clamp point and asserting its absence in every form.

**Ceiling, not default.** `maxBodyChars` is clamped DOWN to
`TONE_CANDIDATE_BODY_MAX_CHARS` (4000) and never up, so no config value can turn the
store into an unbounded archive. Truncated rows carry `bodyTruncated: true`.

**Withholding is distinguishable from cleanliness.** The scrubber replaces the whole
field on its error and oversize paths. Those set `bodyWithheld: 'scrub-error' |
'oversize'` rather than being conflated with "nothing sensitive found" — a judge must
be able to tell "this message was clean" from "the scrub failed and the body was
suppressed". Silently merging them would make every clean-looking row untrustworthy.

**Identity preserved, not replaced.** sha256/bytes/chars describe the WHOLE message
even when the stored body is a fragment, so rows written either side of a flag flip
remain correlatable and dedupable.

## Explicit non-authorization

This flag authorizes recording THIS install's own decisions for internal
benchmarking. It is not authorization for ingesting third-party scenarios, which the
operator has named as a future direction. That path needs an anonymisation layer that
does not exist:

- Identifier-stripping is not anonymisation. A conversation with names removed stays
  identifiable from its subject matter, and removing the subject matter destroys its
  value as a scenario.
- Externally-contributed scenarios are untrusted input — text a model will later
  read, from contributors who may wish to influence how it scores.

Neither risk applies to locally-generated rows. Both are stated in the code comment
so a future reader cannot mistake this flag for a green light on external ingest.

## Migration parity

None required, deliberately. `recordCandidateBody` is OMIT-REQUIRED: absent means
off, matching the `provenance.uniformSeam.enabled` precedent. It is NOT seeded by
`ConfigDefaults`/`migrateConfig`, because seeding it would write a decision about
content retention into every deployed agent's config file on update. Absence is the
correct and safe state, and an existing agent that never sets it behaves exactly as
it does today.

## Multi-machine posture

`unified` — no new state surface. The provenance store's existing posture
(machine-local `contextFull`, redaction-by-field-omission on read) is unchanged; this
adds a field to an existing context object rather than introducing a store, route, or
replicated record.

## Testing

12 new unit tests (`tests/unit/tone-decision-context-body.test.ts`) covering both
sides of the boundary: off-by-default (3, incl. byte-identical equivalence),
on-behaviour (2), credential scrubbing (2), length bounds (4, incl. clamp-before-scrub
ordering), and non-regression of the surrounding context (1).

Existing suites re-run green: `MessagingToneGate` (55), `messaging-tone-gate-b15` (9),
`messaging-tone-gate-b16` (9), `attention-route-tone-gate` (4) — 77 pre-existing plus
12 new, 89 total. `tsc --noEmit` clean.

## Rollback

Set the flag false, or revert the commit. No persisted schema, no migration, no
cleanup — rows already written keep their body and remain valid; rows written after
carry identity only.
