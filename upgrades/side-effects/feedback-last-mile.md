# Side-Effects Review — the last stretch of the feedback pipeline

## Summary of the change
Files: `src/feedback-factory/execute/changeSet.ts`, `src/core/claudeChildAuth.ts`, `src/core/ClaudeCliIntelligenceProvider.ts`, `src/commands/server.ts`, `src/feedback-factory/execute/{independentReview,FeedbackExecutorService,buildFeedbackExecutor}.ts`, `scripts/safe-merge.mjs`, `site/src/content/docs/reference/cli.md`, tests. Measured: a hardened Claude reviewer call under the server's environment answers "Not logged in"; under a pool home it returned a verdict on PR #2771. 15 of 15 reviewed PRs refused; Claude degraded or unavailable on all.

## Decision-point inventory
Reviewer login selection (new source, no authority). Review prompt rules 3 and 5 (input to an LLM authority). Safe-merge check evaluation (narrow exception). Which merge script runs. Secret gate input (narrower text, same patterns and same hold authority).

## 1. Over-block
Rule 5 still refuses agent guidance with commands, which the Agent Awareness Standard may require; such a fix goes to the owner's approval. Measured probe: Codex under the new wording still called `removePending()` calls in shipped code Rule 3 file deletion; that stays conservative.

## 2. Under-block
Crafted test input could try to pass as inert; the prompt treats the diff as data, both models must pass. A Vercel status with the exact text on a fork can only hide Vercel, which tests nothing here; every other check still counts.

Secret check: a credential-shaped value already in the same file passes, wherever the fix places it. Both versions are scanned whole, so a new value under an old label is seen. Long JWTs over the chunk size stay uncovered, as before. A narrow miss remains: a known value ending in a label word, with the new value glued after it, is consumed as one match. Plain string concatenation already defeats this check, so it is not a new class.

## 3. Level-of-abstraction fit
Login: uses the session spawn resolver, so there is one account choice. Provider applies it only on hardened calls. Script: uses the running package, not a mutable checkout.

## 4. Signal vs authority compliance
Prompt rules feed an LLM authority (`docs/signal-vs-authority.md`), no new brittle block. The Vercel exception narrows a brittle block and fails closed on a read error.

## 5. Interactions
`buildEcosystemIdeas` also uses hardened calls and now spends pool quota when it was failing before. Spawn cap applies. A 429 from an account with a lagging reading can trip the account-global breaker for a while.

An old server runs the new merge script between an update's shadow swap and the restart; a missing file or changed flag maps to a merge refusal, and two of those park the item. It fails closed.

## 6. External surfaces
Published package behaviour for agents with pool accounts and Telegram or Slack. Agents with a key or inherited login are unchanged. Without the session resolver, the reviewer stays on the default login, as sessions do.

## 7. Multi-machine posture
Machine-local by design: the pool's config homes are per machine, and each machine picks its own login. Review and merge run on the machine that owns the executor.

## 8. Rollback cost
Revert and release. No state, config or data migration.

## Second-pass review
**Reviewer:** independent general-purpose subagent, two passes on 2026-11-07. Pass 1 concerns: Rule 3 "shipped code" dropped test and doc reach; Rule 5 and the draft clause let the untrusted brief establish need; account selection differed from new sessions. Pass 2 concerns: tests could still shell out or write outside their temp folder; Rule 5's list omitted suppressing a report; notes wrongly said Rule 3 covered more; wiring limits were not stated. All were changed before commit, and those notes now state the limits. Pass 2 also confirmed: the Vercel exception lets no real failure through and refuses on a failed read; the package ships the script and its imports. Secret check: a separate reviewer reproduced multi-line credentials passing an added-lines scan and a PEM across a chunk boundary passing even in an added file; the scan was replaced with a value comparison over both whole texts, and the overlap raised to 16 KB. Both cases are now tests. A further pass found the scrub dropping a new value that overlaps a known one; the comparison now uses raw per-pattern matches, tested. Final pass: Concur. The same reviewer confirmed the session cannot reach the publish clone and held re-publish is digest-bound to the operator's approval.

Rebase pass, 2026-11-12: after the rebase onto main (1.3.1742), a fresh independent general-purpose subagent reviewed the whole PR diff, including `scripts/safe-merge.mjs`, and ran safe-merge-hardening (72/72), claudeReviewerLogin (10/10), execute-independent-review (18/18) and execute-units (71/71). Concur: the Vercel exception applies only to cross-repository PRs whose every Vercel status is the authorization refusal, drops only failed workflow-less rows named exactly "Vercel", and a failed or garbled status read refuses; the rebase kept both `relatedInconclusive` and the publish-clone base reader in `gateAndPublish`. Two minor notes recorded, neither lets a failing check through: the non-`--auto` wait loop crashes (exit 1, never merges) instead of printing a refusal reason on a failed status read; a failed workflow-less check run named exactly "Vercel" on a fork would also be dropped, while the CI floor and E2E must still pass.
