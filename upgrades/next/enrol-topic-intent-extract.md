## What Changed

`TopicIntentExtractor` — which reads each substantive conversation turn and
decides whether it introduces, re-references, affirms or contradicts a topic
signal — is now enrolled in the LLM-Decision Quality Meter.

At ~733 calls / 7 days it was the highest-volume unenrolled decision point
remaining after the stop gate, and nothing recorded what it concluded. The meter
can only answer "is this judgment any good?" for points that record.

**Identity only, and the leak surface here is unusually wide.** This extractor
reads a raw user turn *and* a rolling conversational summary — both untrusted,
and a summary leak republishes far more than one message. Neither is stored. The
context is an explicit allowlist of derived values:

- `messageSha256` + `messageChars` — distinguishes turns without reproducing one
- `topicId`, `arcId`, `messageId`, `fromUser`, `turn`
- `existingRefCount` — how many threads it had to anchor against
- `hasRollingSummary` + `rollingSummaryChars` — presence and size, never content

An allowlist rather than a filter, so a future field on the extractor's input
cannot leak by default. Tests plant a fake API key and password in the message
*and* a fake token and file path in the summary, asserting none of the four
reach the row.

**Declared `measurement-only`**, with an argued reason. Grading an extraction
needs a downstream fact — was the signal later affirmed, contradicted, or
silently dropped — and joining those transitions to a decision row is real
plumbing. The census reports recorded-not-graded rather than implying
measurement that doesn't exist.

**Degrade-safety preserved.** The extractor's core guarantee is that it returns
nothing rather than breaking the conversation it's attached to. Three tests cover
provider-throws, provider-missing, and the degrade callback still firing.

Volume valved at `budget:200`/day; the decision_quality row is written for every
settlement regardless, so counts stay complete.

## Evidence

- `tests/unit/topic-intent-extractor-provenance-enrollment.test.ts` (11): census
  posture; typed decision point and the four options presented; **planted
  secrets in both the message and the summary never reach the context**; the
  hash distinguishes different messages; absent summary handled without
  invention; attribution survives; and all three degrade paths still return
  empty.
- Census ratchet: pending baseline shrinks by exactly one; typed-registration
  check verifies the source imports `DP_TOPIC_INTENT_EXTRACT`.
- 42 green across affected suites.

## What to Tell Your User

Nothing changes in behaviour. The part of the agent that works out what a
conversation is *about* now records the calls it makes, so their quality can
eventually be measured rather than assumed.

None of your conversation is stored — only a fingerprint of each message and
counts describing the decision's shape. The rolling summary in particular is
recorded only as "present, this many characters," never its content.

As with the previous one: recorded, not yet graded. Knowing whether a given call
was right needs a later fact that isn't connected up yet, and the record says so
rather than implying otherwise.

## Summary of New Capabilities

- The conversation-intent extractor records every decision it makes.
- Recording is identity-only by construction and tested against planted secrets
  in both of its untrusted inputs.
- Enrollment cannot break the extractor's degrade-safe guarantee.
