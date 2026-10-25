---
audit: truncated-judgment-input
target-pattern: >
  A size bound applied to data that then becomes the INPUT to a judgment (an LLM
  prompt, a gate decision, a comparison), where the bound can remove information
  the decision depends on. Bounds on OUTPUT — a log line, an error string, a
  display summary, a stored record — are OUT of scope; those belong to
  "Expected Capacity Enforcement Is an Outcome, Not a Degradation".
search-surface: >
  src/**/*.ts and scripts/**/*.mjs, restricted to files that call a model
  (.evaluate / IntelligenceProvider). Surface grew during Round 1: Round 1's
  first angle assumed the bounded value is always given a NAME before use, and
  Round 1 angle B/E proved that assumption false.
standing-guard: scripts/lint-bounded-judgment-input.mjs
blind-spot-class: detector-shape-assumption
standard-response-kind: created
standard-response-ref: docs/STANDARDS-REGISTRY.md
standard-response-article-id: never-silently-cut-the-data-a-decision-depends-on
standard-response-article: Never Silently Cut the Data a Decision Depends On
standard-response-rationale: "No existing article governed the FITNESS of a bound on judgment input. The nearest one, Expected Capacity Enforcement, governs the storage side and actively blesses this failure: a budget applied exactly as designed is a success. True for a record you are keeping; wrong for data a decision is about to be made from. So the response is a new sibling with an explicit boundary field, not an amendment."
converged: "2026-08-22T18:55:49.154Z"
rounds: "2"
standard-response-digest: "7ec1f4201ef29fe57b70bb0cf17ac8f1a448bdc594b200ed1e4d3bb71416a734"
meta-artifact-at: "2026-08-22T18:55:49.154Z"
meta-artifact-digest: "3e7e5f51dcff9b13ab7bf82c230472c82c82b73500e747051e329856c2450040"
---

# Audit — truncation of judgment input

## Meta-insight

How it arose: Bounding a value is one keystroke — `text.slice(0, N)` — while every property that makes the bound safe (deriving N from what the consumer accepts, keeping the end rather than the start, telling the consumer it got a fragment, refusing when the fragment is missing the load-bearing part) costs more code, and none of them are visible in review as absent. The unsafe form is not chosen over the safe one; it is the one that comes to hand, and nothing downstream ever contradicts it.

Why prior controls missed it: The nearest standard pointed the other way (Expected Capacity Enforcement says a budget applied as designed is a success — true for storage, licensing for input); the vocabulary concealed the magnitude ("truncated to fit" describes partial loss and was reporting 100% loss); and, decisively, the disclosure layer was already correct and did not help — it named every dropped document in the prompt and six rounds of review were conducted on top of it anyway, because nothing refused.

## Background — the three reasons, at length

**The nearest standard pointed the other way.** *Expected Capacity Enforcement*
says a budget applied exactly as designed is a SUCCESS and must not be filed as a
fault. That is true for a record you are keeping. Read at the input side it
licenses the defect, which is why the new article carries an explicit boundary
field rather than leaving the two to be cited against each other.

**The vocabulary concealed the size of the loss.** The cross-model reviewer's
note said "context was TRUNCATED to fit". "Truncated" describes partial loss. The
actual loss was 100%, on every round, for the life of the machinery — a budget of
60 KB against a spec of ~200 KB could never admit anything else. The word read as
reassurance while describing total loss, which is why six rounds of review passed
under it without anyone acting on the line. The operator named the general
pattern independently: *"you tend to default to truncating data in an effort to
be more data efficient — however, often it just cuts off very critical
information."*

**Disclosure was already correct, and it did not help.** This is the finding that
changed the shape of the standard. The assembler ordered docs by value, kept the
most important first, named every dropped document in the prompt, and told the
reviewer its view was partial. All of that worked. Six rounds of review were
conducted and reported as review anyway, because **nothing refused**. A control
that informs a reader depends on someone reading; a control that refuses does
not. The standard's third obligation exists because its second was demonstrably
insufficient here.

## Round 1

**Search angles run** (one angle is blind to what the others catch):

- **A — by-structure (named):** a bare truncation bound to a `const`/`let`, that
  name later interpolated into a template literal, in a model-calling file.
- **B — by-content (inline):** a truncation written directly inside a template
  literal, with no intermediate name. Explicitly run to test angle A's declared
  assumption.
- **E — by-callsite:** from every prompt-shaped template literal backwards to
  what it interpolates.
- **F — union over model-calling files:** every truncation of bound >= 20 in a
  file that calls a model, inline or named, classified by hand.

**Surface delta.** Angle A alone reported 18 sites and I was one commit away from
registering that as the population. Angle B found the assumption behind it was
false — and not harmlessly: two of the sites only angle B could see were live
direction bugs. Angle F raised 120 raw candidates across the model-calling files,
most of which classify OUT (they bound output, not judgment input).

**Findings**

| Location | Behavior | Bucket | Disposition |
|---|---|---|---|
| `src/core/crossModelReviewer.ts` (`CONTEXT_BUDGET_BYTES`) | 60 KB budget, no recorded derivation, smaller than a single spec — referenced context dropped in FULL on every review ever run | judgment-input, structurally-total-loss | fixed: derived from the transport (256 KB), derivation recorded in place |
| `src/core/crossModelReviewer.ts` (`runCrossModelReview`) | returned a verdict on a view missing the docs the review exists to check against | judgment-input, no-refusal | fixed: `omittedLoadBearing` + `context-incomplete` degrade before the model call |
| `src/core/ResumeValidator.ts:216` | first 1,500 chars of an oldest-first history — discarded the most recent messages, no marker, fail-safe MISMATCH | judgment-input, wrong-direction + undisclosed | fixed: `boundedTail`, bound re-derived to 4,000 from what the caller emits |
| `src/core/InputGuard.ts:314` | first 500 chars of an untagged message fed to an injection check — a payload past the cut is never seen | judgment-input, undisclosed + evasion-route | fixed: `boundedHead` at 8,000, derived from the Telegram 4,096 message cap |
| `src/threadline/PipeSessionSpawner.ts:220` | `history.slice(-20)` then `.slice(0, 4000)` — selected the newest 20 messages then kept the oldest of them | judgment-input, wrong-direction | fixed: `boundedTail`, bound derived from the 20-message window. **CORRECTED 2026-08-22 (independent review, C9): this is NOT a live bug.** `summarizeThreadHistory` is imported at `src/commands/server.ts:17624` and never invoked, so the defect was real in the code and unreachable in production. Round 1 below called it one of "two live direction bugs"; only one of the two was live. The fix stands (the function is exported and reachable by a future caller), the CLAIM about its impact was overstated. |
| `src/threadline/PipeSessionSpawner.ts:145` | inline `${messageText.slice(0, 2000)}` into a classifier prompt, undisclosed | judgment-input, undisclosed | fixed: `boundedHead`. **CORRECTED 2026-08-22 (independent review, C10): the first fix bounded at 8,000 with a derivation naming a relay limit that is nowhere checked** — while `shouldUsePipeMode` refuses anything over 2,000 in the same file, before the classifier is ever called. So the number was 4x the real ceiling and the "derivation" named the wrong constraint: obligation (1) violated inside the change's own evidence. Now derived from `PIPE_MODE_MAX_MESSAGE_CHARS`, the actual gate. |
| `src/monitoring/PromptGate.ts:621` | `lines.slice(-20).join().slice(0, 3000)` — took the terminal's newest lines then cut from the top, able to discard the very blocking prompt it exists to find | judgment-input, wrong-direction | fixed: `boundedTail` at 6,000 |
| `src/threadline/TopicLinkageHandler.ts:580` | per-message body capped at 240 chars in a thread-history block | judgment-input, disclosed-by-design | accepted: a deliberate security cap with a written rationale in place (bounding what a hostile peer can inject into surrounding prompt scaffolding). The bound IS derived and the reason IS recorded — this is the article being satisfied, not violated |
| 26 further sites | bare truncation in a model-calling file; a mix of genuine judgment input and output-shaped strings the detector cannot distinguish | mixed | deferred: `STD-SUBCOUNTDOWN-bounded-input-derivation-review` (2026-11-22) — held in `docs/bounded-judgment-input-baseline.json`, shrink-only |
| ~95 further candidates from angle F | log lines, error strings, ids, channel names, display summaries, stored records | out-of-scope | accepted: these bound OUTPUT (logs, errors, ids, display), not judgment input — *Expected Capacity Enforcement* is the governing article for them |

**New findings this round: 10** — 7 fixed, 1 accepted with a written reason, 1 deferred population (26 sites) and 1 accepted out-of-scope population (~95 candidates).

## Round 2

**Search angles run.** All four re-run against the FULL surface after the fixes,
not only the touched files — angle A, angle B, angle E, angle F.

**Surface delta.** None. The standing guard now implements angles A and B
together, so the detector's own population and the audit's agree by construction;
angles E and F were re-run by hand against the whole tree.

**Findings.** None. The re-sweep returned only rows already in the Round 1
ledger — the fixed sites now bound through the helper, the accepted site is
unchanged and still carries its rationale, and the deferred population matches
the baseline exactly (the ratchet fails if it does not).

**New findings this round: 0.**

## Convergence

Converged after 2 rounds; round 2 found nothing new.

Ledger: 9 findings — 7 fixed, 1 accepted with a written reason, 26 baselined as a
shrink-only review list under a dated sub-obligation, ~95 classified out of scope.

**What convergence does and does not claim here, stated plainly.** It claims the
search is converged: four angles over the full surface return nothing the ledger
does not already hold. It does NOT claim the code is clean — 26 sites remain
unconverted by deliberate decision, because converting them at speed would mean
picking bounds by resemblance, which is the defect performed faster. And it does
not claim the detector is complete: it reads a syntactic shape, so a truncation
written in a form it has never seen is outside the population by construction —
the same class of blind spot this audit was created by. That is why the standard
registers as PARTIALLY enforced, and why the honest number is on the article.
