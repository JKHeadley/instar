# Side-Effects Review — attribution judge: balanced tier and clearer support rules

**Slug:** attribution-judge-tier-and-prompt
**Tier:** 1. Size: 2 code/test files plus a one-line spec correction. Effort: no new spec, one review pass.

## Summary of the change

`AttributionJudge.ask` moves from `model: 'fast'` to `model: 'balanced'`. `SUPPORT_RULES` gains three rules: what `strength` proves, that ownWords and faithful are separate, and that a report of a whole message is faithful while a part must keep the meaning of the whole. `EXTRACT_RULES` adds that disowning an earlier credit is not a credit. Prompt id bumps to `attribution-judge-v2`. Spec section 4 now says balanced tier.

## Decision-point inventory

- AttributionJudge extract and support (the LLM judgment behind the write gate and B23): modified. Authority is unchanged: it refuses only under `enforce`, which no agent runs.

## 1. Over-block

Improved, measured. True quotes refused: fast tier on Claude 11 of 32 decided; final prompt 0 of 40 on Claude, 0 of 39 decided on Codex. Labelled inferences: 9 of 10 pass on both; the tenth keeps the credit in place and is rightly refused. All 40 true quotes are whole messages, so true partial quotes are untested as a control; the new fragment rule could over-refuse them, and the record period will show it.

## 2. Under-block

Measured on the final prompt: Codex caught 72 of 72 bare credits, 23 of 23 decided cases of real words wrapped as a false standing rule (set E), and 12 of 12 decided fragments that reverse meaning (set F). Claude caught 29 of 29 and 13 of 13 decided on E and F. E and F pass the code's quote check, so these are the judge's own catches; the 50-case drifted set is not, since 45 of Claude's 47 and 37 of Codex's 38 refusals there were code's `quote-not-in-record`. Not rerun on the final prompt: Claude on bare credits (71 of 72 on the prior wording) and the drifted set (Claude 47 of 47 decided, Codex 38 of 39 on the prior wording); both misses on the prior wording were one "four-part rule" text, and the disowning rule may be why on Claude. Risk from the new rule: on a verified record, a pasted block with no visible sign of pasting reads as own words. The ASP classifier and the text are the only evidence there; the rule keeps "relayed" for text that shows it.

Tier against prompt, from one control run (balanced tier, old prompt, Codex only, on sets C, D, E and F): it caught every decided E and F case and refused no true quotes. On that evidence the tier does most of the work. The control has limits: no Claude control, no control on bare credits, no fast-tier baseline on E or F, and fast tier on Codex decided no true quotes because its budget ran out. The prompt changes turn the 4 unchecked true-quote rows into decisions, though the final Codex run still had one timeout, and they give the right reason: on F the old prompt said "relayed" 7 times where the fault is overstatement. A cost of "a plain message IS own": three of those four rows are not words at all (two image markers and one token-like string), and they now pass as his words. All 15 F cases use "Justin told us to"; the plain "said" form with a reversing fragment is untested.

## 3. Level-of-abstraction fit

Right layer: the fault is what the judge is told and which tier runs it. The structural proof stays in `recordEligibility`; the prompt now states what that proof means instead of re-deriving it.

## 4. Signal vs authority compliance

Complies. The exact facts remain code-measured; judgment stays with the model. No brittle check gains authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

Keeps this a judgment point. The rules give the judge facts it lacked and do not replace it with a static test.

## 5. Interactions

Latency did not rise: on matched sets the balanced tier was no slower than fast (bare credits on Claude 7.9s fast, 4.1s balanced; true quotes on Claude 11.2s, 8.1s). Two-call checks still run p50 about 10 to 17 seconds under sustained load at concurrency 2, against a 20-second route budget and 25-second hook limit. Timeouts in that load test on two-call sets: Claude 3 of 50 on the drifted set, Codex 11 of 50 on it, 10 of 45 on E and F, 1 of 40 on true quotes. A timeout passes unchecked, which on Codex is the largest remaining gap for `enforce`. Those loads are heavier than real single writes, and the 72-hour record period measures the real rate against the under-2% criterion. Budgets are unchanged; a marked claim costs two model calls, so 200 a day covers about 100 such checks. The `judgeErrors` counter also counts background audit calls pre-empted by the queue (seen 16 of 112 in a status read during the load test, from the live counter, not the result files), so it overstates model errors under load.

## 6. External surfaces

No new surface. Subscription use per check rises with the tier. The hook waits only in `enforce`; `record` does not wait.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unchanged. Stateless change to a prompt and tier. Ledger rows carry no prompt id today; grades by prompt use the provenance id, which is bumped.

## 8. Rollback cost

Plain revert. Ledger rows written under v2 stay valid.

## Conclusion

Clear to ship. Without it, Echo's record period would measure a judge that misses most false credits. Enforce stays off: the timeout rate on Codex still has to be read from real use.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, four reads
**Independent read of the artifact: concur**

The first read found an untested false-credit path through verbatim fragments, an overclaim that the judge itself made most catches, and no control run. Those led to the fragment rule, sets E and F, and the control. Later reads recomputed every number from the result files and corrected the claims on undecided rows, the limits of the control, and latency. The fourth read concurs.

## Evidence pointers

- `.instar/lanes/attribution-live-rung-1106/` (Echo's home): cases, runner and every result file. `invalid-overlap/` holds two runs spoiled by an overlap; the rerun replaced them.
- `tests/unit/attribution/AttributionJudge.test.ts`.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `prompt-parser-contract-drift`: the prompt handed the judge a `strength` signal without the contract for what it proves, so its answers drifted from what the code had established.
- **`closure`** — gap: ACT-605. The class-level guard is a labelled replay on real model calls in the LLM bench. Stub-model tests could not have caught this.
