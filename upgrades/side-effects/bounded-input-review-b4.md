# Side-Effects Review — bounded-input derivation review, batch 4

**Version / slug:** `bounded-input-review-b4`
**Date:** `2026-11-18`
**Author:** `Echo (M5)`
**Second-pass reviewer:** `independent reviewer subagent (concur, round 2)`

## Summary of the change

This is batch 4 of 4 (the last) for `STD-SUBCOUNTDOWN-bounded-input-derivation-review`. It covers 12 baseline entries in `messaging/`, `permissions/`, `scheduler/` and `threadline/`. On this branch the baseline goes from 43 to 31. Batches 1-3 (#3424, #3427 and batch 3) remove the other 31 entries, disjoint from these. Once all four land, the baseline is empty and its ceiling is 0. Tier 1. Per-site readings are in `docs/audits/bounded-input-review/batch-4.md`.

Behaviour changes:
- **WarrantsReplyGate (refuses on a partial view).** The reply-necessity classifier can only suppress a reply to another agent. A message over 2,000 characters is no longer classified; it is replied to, the gate's documented "fail toward responsive" direction. Before, the classifier judged the first 2,000 characters and could suppress a reply to a question asked later in the message.
- **Disclosed cuts, same content kept:**
  - Slack intent classifier: 2000.
  - Ambient-contribution gate: 2000.
  - Hub-intent context turns: configured, default 400.
  - Conversation-brief prompt: 800.
- **Mentor Stage-B forensics** (outside the baseline; the lint cannot see it): the 12,000-character signal cut is now disclosed.
- **Attention-hub post body:** a cut now says so in-band and points to the full attention item. The post also lands in topic history that sessions read.
- **Exempt, with reasons:** an operator snippet (now ending in "…" when cut), an already-disclosed Slack file cut, a platform title limit, an array cap, and two model-output clamps.

## Decision-point inventory

- **WarrantsReplyGate classifier** (can suppress a peer reply): modify input and add a refusal. A long message skips the classifier and is replied to under a new, distinct signal, `too-long-to-classify`. No other module reads the signal union.
- **Mentor Stage-B forensics:** modify input; the cut is disclosed.
- **LlmIntentClassifier** (feeds the Slack permission gate; can only escalate a tier): modify input; the cut is disclosed.
- **AmbientContributionGate** (speak / react / silent on overheard chatter): modify input; the cut is disclosed.
- **HubIntentClassifier** (open a hub topic?): modify input; context-turn cuts are disclosed.
- **Conversation brief** (orientation text for the operator): modify input; the cut is disclosed.

---

## 1. Over-block

No new block. The reply gate can now only reply MORE: a long, purely acknowledging message from a peer gets a reply where the classifier might have suppressed it. That is its stated safe direction, and the gate's soft cap and other paths still bound reply loops.

## 2. Under-block

- **Intent classifier:** for a Slack message over 2,000 characters, the model still reads only the head (now disclosed). An escalation cue in the tail is caught only by the deterministic full-text floor read, as before.
- **Hub-intent context:** turns stay cut at their configured size.

## 3. Level-of-abstraction fit

The refusal lives inside the gate's own classify step, next to its existing "classifier absent or failing → reply" behaviour, so there is still one fail direction. Each bound sits beside its prompt.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The reply classifier's suppression authority shrinks for inputs it cannot see whole. Nothing gains authority. The intent classifier's never-widen rule is untouched.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The length check is a precondition for asking the classifier, not a judgment about the message.

## 5. Interactions

- **Reply-gate provenance:** `messageWasTruncated` is now always false, because a message that would need cutting is never classified. The refused path writes no provenance record (no judgment ran) and is labelled `too-long-to-classify` with its own reason, so anything counting classifier verdicts is not misled.
- **Intent classifier side effect:** the model's action label from a partial view still reaches the permission ledger and observer history, which feed the anomaly scorer's relationship history. Acceptable: the label never widens access.
- **Hub-intent provenance:** `maxContextCharsPerTurn` now records the effective per-turn bound (content plus disclosure room).
- **Reply-loop guards:** the soft cap, control-message detection and pure-ack vocabulary run BEFORE the classifier and are unchanged. The refusal applies only on the ambiguous path that used to reach the classifier.
- **Prompt sizes:**
  - Each disclosed field grows by the marker only when cut.
  - Hub context: at most `maxTurns` markers.
  - Brief: at most 10 markers.
- **Hub-intent context:** the marker's newline is folded so each turn stays one `who: body` line.
- **Imports:** four files newly import `boundedInput.ts`, which imports nothing, so there is no cycle. The Stage-B fingerprint check passes.

## 6. External surfaces

- Peer agents may receive replies to long ambiguous messages that were suppressed before.
- The operator's conversation brief snippet ends in "…" when cut.
- There are no routes, config keys or new operator strings.

## 6b. Operator-surface quality

Two operator-visible changes:
- A cut snippet in the conversation brief now ends in "…".
- A long attention-item description in the Telegram hub post now ends with "… [description cut at N of M characters; the full text is in the attention item]". Before, it was cut silently. The note is short, plain, and points to where the whole text is.

## 7. Multi-machine posture

Machine-local by design: in-process prompt assembly and decisions on the machine that handles the message.

## 8. Rollback cost

Revert the PR. Nothing is stored or migrated.

## Conclusion

Twelve entries cleared:
- one refusal (reply gate),
- four conversions,
- seven exempt with reasons.

Two real defects were found and fixed:
- the reply gate could suppress a reply to a long message while seeing only its start;
- the forensics model read a silent cut of its signals, a site the lint could not see.

With batches 1-3, this takes the baseline to zero. The second pass also corrected three rationales (`dSliced` is not display-only; the intent-classifier comment's reasoning; the snippet), a mislabelled refusal signal, and this artifact's closing claim.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5, fresh context, read-only), two rounds
**Independent read of the artifact: concur**

Round 1 raised CONCERN:
1. The `dSliced` exemption was false: the hub post lands in session-read topic history, and the caps are not the Telegram limit.
2. The lint missed a silent 12,000-character cut in MentorStageBForensics, which made this artifact's "the lint refuses ANY new bare truncation" claim false.
3. The reply-gate refusal was mislabelled as a classifier verdict.
4. The intent-classifier comment's reasoning was wrong (a model tier of 4 falls back to the deterministic read).
5. The snippet rationale and the hub provenance bound were off.
6. Tests were missing: the boundary, the signal, the ambient gate, the hub context.

All were fixed. The cut is now marked with a pointer, the forensics bound is converted, and the lint gap is filed as fb-5f1a0347-64b with closure recorded as `gap`. The reply gate has a distinct `too-long-to-classify` signal, the comment is corrected, and the tests are added.

Round 2: CONCUR. The one remaining limit is the detector gap, which is stated in the Class-Closure section.

---

## Evidence pointers

- `tests/unit/bounded-input-review-batch4.test.ts`:
  - a short ambiguous message is still classified and can be suppressed;
  - a message over the bound is not classified, is replied to, and carries `too-long-to-classify`;
  - at the boundary, exactly 2000 characters is classified and 2001 is not;
  - the intent classifier, ambient gate, hub context, brief prompt and forensics prompt all disclose cuts.
  - The original three behaviour cases fail when only the changed lines are reverted.
- `tests/unit/attention-single-topic-routing.test.ts`: a cut hub description carries the marker and pointer; an uncut one is unchanged.
- `tests/unit/MentorStageBForensics.test.ts`: the signal bound holds and is disclosed.
- Existing suites pass: `WarrantsReplyGate`, `HubIntentClassifier`, `hub-intent-discrimination`, `slack-ambient-contribution-gate`, `slack-llm-intent-classifier` (126 passed, 1 skipped).
- `lint-bounded-judgment-input`: clean at 31 on this branch.

---

## Class-Closure Declaration (display-only mirror)

The defects fixed are instances of silently cut judgment input. The standing guard for that class is `scripts/lint-bounded-judgment-input.mjs`, a shrink-only baseline with a ceiling. With all four batches merged its population is zero, so from then on the lint refuses any new bare truncation **of the shapes it detects**.

It is NOT a complete guard. The detector misses an unnamed slice inside an array literal joined into a prompt (the Mentor forensics site was one), and it skips files that render prompt text without calling a model (the TopicMemory cuts in batch 2). That gap is filed as feedback fb-5f1a0347-64b for a detector extension, so this class is recorded as `closure: gap`, not `guard`, until the extension lands.
