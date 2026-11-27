# Side-effects review for the source-grounded real-conversation host

A manual tool plans, answers, judges and totals the private source-grounded case pack. It runs only when an operator-directed session invokes it on the machine that holds the pack and the subscription. No endpoint, job, hook or startup path calls it.

1. **Over-block.** A pack whose files do not match their manifest, a plan whose bytes changed, a failed confinement probe, an unconfined Claude stream and any tool activity all halt the step. This is a manual evaluation and can be rerun on a known good route.
2. **Under-block.** The answering and Claude judging turns use the same confined settings as the public capture: no tools, empty MCP, no settings or hooks, one turn, no session persistence and no API key. The Codex judge uses instar's own tool-free profile, a read-only sandbox, an empty scratch directory and an ephemeral session. A unit test keeps that profile identical to src/core/codexToolFreeProfile.ts. The reducer and the answerer never receive a question, label or rubric. The judges never receive the arm, and submission ids are seeded hashes that do not reveal it.
3. **Abstraction.** The frozen offline modules still do all scoring: evaluateJudgeFlow, the retry policy, slot binding, the independence check and consensus. The host only produces their inputs. Models quote evidence, and the host turns each exact quote into code-point offsets. A quote that is not found verbatim stays an invalid span and fails the record, never a fuzzy match.
4. **Signal and authority.** Totals are exploratory. They cannot qualify, activate or tune a reduction. The status field says so.
5. **Interactions.** Every step writes into a caller-chosen run directory, with owner-only permissions, and skips trials already recorded. A rerun therefore resumes rather than repeats. Each model turn runs in its own empty folder under the run's scratch folder. The folders are kept, not deleted, and a turn that leaves any file there fails as tool activity. One ordinal counter orders model completions against the first combining of judge outputs, which is what the independence check needs.
6. **External surfaces.** An invocation uses Anthropic inference on the selected authorized subscription and OpenAI inference through the selected Codex login, and may consume quota on both. Private source, question, label, answer and judge text stays in the run directory. The totals file carries identifiers and counts only, and a test asserts that no case text reaches it.
7. **Multiple machines.** The pack and the logins live on one machine, and the run happens there. Nothing replicates.
Scoring rule for the case decision. Two criteria come from it. "decision" passes only when the answer reaches the reference decision and is never critical. "no-wrong-decision" is an absence criterion that fails only when the answer asserts a different decision, and it is critical when the case is. A justified refusal in the no-context arm therefore loses the decision point without being counted as a critical failure, which is what the totals are meant to show.

8. **Rollback.** Remove the script or revert the commit. There is no activation, state migration or runtime caller.

## Second-pass review

Not required for this tier-one manual tool. It adds no runtime path and changes none of the frozen scoring modules.
