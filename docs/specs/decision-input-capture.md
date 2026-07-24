---
title: "Decision-input capture: record richly, judge later in bulk"
slug: "decision-input-capture"
author: "echo"
---

# Decision-input capture: record richly, judge later in bulk

## Problem statement

The LLM-Decision Quality Meter enrolls decision points so their correctness can be
measured. For the `messaging-tone-gate` point it records the verdict, the prompt
version, latency, and an identity fingerprint of the candidate message.

It cannot answer the question it exists to ask.

"Was blocking this message correct?" is not decidable from a sha256. A hash cannot
be re-read; a judge handed one has strictly nothing to judge. The meter today can
measure how often the gate fired and how long it took, but never whether it was
right — which is the entire point.

The gap is structural, not an oversight. The identity-only discipline was
deliberate and documented in code: the tone gate exists to inspect outbound text
for leaks, so storing that text builds a pile of exactly the material the gate
worries about. The reasoning is sound and the result is self-defeating — it
protects the store by making the review impossible.

### The operator's reframing (2026-07-23, topic 33368)

The programme's shape changed. The operator's model, stated directly:

1. For every LLM decision, record the INPUT, the PROMPT used, and the DECISION.
2. Record whether the agent AGREED or DISAGREED, and when it disagreed, WHY — with
   the context of why.
3. Do **not** judge in real time. Judging happens later, in bulk, with an extremely
   intelligent model, unhurried and not time-dependent.
4. The results tune the prompt, become benchmark scenarios, and identify the best
   model per scenario.

This supersedes the direction of `tone-gate-contestation-evidence.md` — a design
that computed a right/wrong verdict at decision time from thin deterministic
signals. That design forced an unresolvable question (an override is a
*disagreement*, not a *verdict*, and storing it as `wrong` misleads any downstream
reader). Recording-then-judging dissolves that rather than managing it.

It also revives a signal previously withdrawn as unsound. The earlier design needed
to *prove* a rewrite came from the same author before it could count as evidence.
Under bulk judging it does not: the recorded context goes to the judge and the judge
decides. **Evidence need not be self-interpreting.**

### Retention, settled

The operator settled the retention question directly rather than leaving it open:
the same text is already written to the session transcript on disk, so a second copy
in a store only the operator and agent read crosses no line the transcript has not
already crossed. Scoped explicitly to INTERNAL benchmarking of this install's own
decisions.

## Proposed design

### Increment A (this spec, implemented)

`buildToneDecisionContext()` takes an optional third parameter. When
`recordCandidateBody: true`, the context carries the candidate body ALONGSIDE the
existing sha256/bytes/chars identity. `ToneGateConfig` gains `recordCandidateBody`,
read live at the callsite so it can be flipped without a restart.

Absent or false ⇒ byte-identical to prior behaviour, asserted by a
`JSON.stringify` equivalence test so the no-op property cannot drift silently.

Properties, each load-bearing:

| Property | Why it is where it is |
|---|---|
| **Clamp before scrub** | Scrub-then-truncate can bisect a `[REDACTED:…]` marker and leave the tail of a real secret past the cut — the exact failure being prevented, reintroduced by sequencing two safe steps wrongly. |
| **Ceiling, not default** | `maxBodyChars` clamps DOWN to `TONE_CANDIDATE_BODY_MAX_CHARS` (4000) and never up, so no config value can make the store an unbounded archive of outbound prose. |
| **Kinds, not offsets** | Redaction KINDS are recorded; offsets and matched text are not. Knowing a credential was present helps a judge; knowing where it sat helps nobody who should have it. |
| **Withheld ≠ clean** | The scrubber replaces the whole field on error/oversize. Those set `bodyWithheld` explicitly rather than being conflated with "nothing sensitive found" — conflating them makes every clean-looking row untrustworthy. |
| **Identity preserved** | sha256/bytes/chars still describe the WHOLE message even when the body is a fragment, so rows either side of a flag flip stay correlatable and dedupable. |

### Increment B (specified, not built)

**The disagreement reason.** Today the row records that an override occurred, not
why. That "why" is the most valuable field on the record: it is the difference
between "the gate and the agent disagreed" and "they disagreed, here is the
reasoning, now judge who was right."

The token-join work already built (a signed, stateless, cross-machine-safe decision
token) is REUSABLE as the mechanism binding a disagreement record back to its
decision. The grade-emitting half of that design falls away.

### Increment C (specified, not built)

**The bulk judging pass.** An offline, cadenced job that reads unjudged rows, hands
each to a strong model with the full recorded context, and records a verdict plus
reasoning. Explicitly NOT real-time; explicitly permitted to be slow.

## Data lifecycle and storage (round-1 fold: codex-cli, gemini-cli)

Both external reviewers noted the spec described *what* is captured without stating
*where it lands or for how long*. Recorded plainly rather than left implied:

- **Where.** The context object is written to the existing machine-local provenance
  store (JSONL day-files under the agent home), the same store that already holds the
  identity-only rows. No new store, table, or file is introduced.
- **How long.** It inherits the store's existing retention, `provenance.retentionDays`
  (default 14). A recorded body is deleted when its day-file ages out — there is no
  separate, longer-lived copy.
- **Who can read it.** The full context is machine-local and never served raw. The
  read path applies redaction-by-field-omission, an existing invariant in code rather
  than config. **The new `body` field must be confirmed to ride that omission rather
  than defaulting through** — a content field added to an object whose serve
  discipline was designed for identity-only data is precisely where a leak would hide.
  Flagged for the security reviewer as the highest-value check in this round.
- **Exports.** No export surface carries provenance context today. If one is added, it
  must treat `body` as content, not metadata.

### Redaction accounting is whole-message, not fragment (round-1 fold: codex-cli MINOR 2)

Clamping precedes scrubbing for storage safety, which made the first implementation's
`bodyRedactionKinds` mean "kinds found in the retained fragment". That is not the
question a reader asks. "Did this message contain a credential?" is about the WHOLE
message, and a credential sitting past the clamp would leave the row reading clean.

Kinds are now computed over the full text (a second bounded scrub whose scrubbed
output is discarded), and `bodyRedactionsBeyondClamp: true` marks a row whose stored
fragment shows no marker because the credential lay past the cut. Nothing sensitive is
stored either way; the accounting is simply now true of the message rather than of the
excerpt.

### Scrubber efficacy is a shared dependency, not a local guarantee (round-1 fold: gemini-cli MINOR 3)

`scrubForStore` is pattern-based and boundary-anchored. It catches credential SHAPES;
it does not catch personal information that is not credential-shaped, and a token run
directly onto adjacent word characters does not match its boundaries. This spec
deliberately depends on the shared scrubber rather than growing a second one, so its
coverage — and its maintenance — is a project-level concern this feature inherits
rather than solves. Stated so no reader mistakes "scrubbed" for "contains nothing
sensitive".

### Terminology (round-1 fold: both external reviewers)

Both flagged in-house shorthand that is opaque from outside. Defined once:
`uniformSeam` = the observe-only side-write point at the router where a decision row is
minted; `contextFull` = the unredacted context retained machine-locally; `readRedacted`
= the serve path that omits fields not cleared for reading; `OMIT-REQUIRED` = a config
key deliberately never seeded, where absence is the intended state; **token-join** =
the signed, stateless identifier binding a later record (e.g. an override) back to the
decision it concerns.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `recordCandidateBody` on/off | **invariant** | A deterministic config read. There is no judgment: the operator's setting is the answer, and no signal competes with it. |
| Clamp/scrub of a recorded body | **invariant** | Deterministic by design and must stay so. A model deciding what counts as a secret is strictly worse than a pattern scrubber with a hard length bound; the failure mode (a missed credential) is unrecoverable once written. |
| The eventual bulk-judge verdict (Increment C) | **judgment-candidate** | Genuinely competing signals with no deterministic answer. Floor, when built: bounded action space (`right` / `wrong` / `unclear`), conservative default `unclear`, fallback ladder ending at "leave ungraded" — never a fabricated grade. Arbiter: the strong judging model. Deferred with the increment; NOT claimed as built. |

Increment A itself introduces **no new judgment surface**. It changes what is
recorded, not what is decided — the tone gate's verdict path, rule set, and
fail-direction are untouched.

## Multi-machine posture

**`unified`.** No new state surface is introduced. The change adds a field to an
existing context object; the provenance store's existing posture (machine-local
`contextFull`, redaction-by-field-omission at `readRedacted`) is unchanged. No
route, no replicated record, no per-machine divergence.

The config key follows the existing `provenance.uniformSeam` precedent and is
resolved per-machine from that machine's own config — an operator who enables
capture on one machine and not another gets exactly that, which is the correct and
expected behaviour for a retention setting, not a coherence defect.

*(No `machine-local-justification` marker is required: nothing here is declared
machine-local.)*

## Frontloaded decisions

Decisions made up front so no mid-build stop is needed:

1. **Body stored alongside identity, never replacing it.** Rows either side of a
   flag flip must stay correlatable.
2. **4000-char ceiling.** Covers the overwhelming majority of real outbound messages
   whole. A body cut mid-argument answers the judging question no better than a hash.
3. **Off by default, OMIT-REQUIRED, no config seeding.** Seeding would write a
   content-retention decision into every deployed agent's config on update.
4. **Reuse `scrubForStore`.** The same scrubber every other content-bearing store
   uses. A bespoke scrubber here would be a second thing to keep correct.
5. **Pure function, config resolved by the caller.** Keeps the builder testable on
   both sides of the boundary without touching global state.

## Explicit non-authorization

This flag authorizes recording THIS install's own decisions for internal
benchmarking. It is **not** authorization for ingesting third-party scenarios, which
the operator named as a future direction. That path needs an anonymisation layer
that does not exist, for two independent reasons:

- **Identifier-stripping is not anonymisation.** A conversation with every name
  removed remains identifiable from its subject matter, and removing the subject
  matter destroys its value as a scenario. The tension is real and must be designed
  around, not asserted away.
- **External scenarios are untrusted input.** A benchmark case is text a model will
  later read. Anyone who can contribute one can attempt to shape how models behave
  on it, or plant one that scores a favoured model well.

Neither risk exists for locally-generated rows. Neither is solved here. Stated in
the code comment so a future reader cannot mistake this flag for a green light.

## Open questions

None blocking Increment A. Increments B and C are specified above and tracked as
separate work; neither is claimed as built by this spec.
