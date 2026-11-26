# Side-Effects Review — Find existing pull requests before starting work

**Version / slug** `chief-of-staff-pr-discovery`
**Date** 2026-11-23
**Author** Echo
**Second-pass reviewer** Pending independent review of this artifact

## Summary of the change

Tier 2 due to the new authenticated API surface. The provider and HTTP route give the development Chief of Staff one lookup for open pull requests and the last 30 days of merged activity in the public Instar repository. The change touches the shared GitHub transport, a process-local cache and its route, the awareness registry and three proof tiers. Six specification review rounds and zero commit attempts. Review focused on source coverage, stale or contradictory evidence, credential controls and what the conversational replay can prove.

## Decision-point inventory

- Route admission adds an existing master bearer check, explicit denial for scoped devices and an existing development Chief of Staff enablement check.
- Provider validation adds cursor, payload, deadline and request scope checks. Credential denial evicts the affected cache generation. Identified rate limiting sets a retry cooldown.
- Search adds case-insensitive literal matching, ranked results and a snapshot-bound continuation. The conversational agent assesses overlap and decides what to answer or assign.
- The shared GraphQL adapter adds typed failures with existing message strings and an opt-in decoded-body limit. Its default body-reading contract stays in use for existing callers.

## 1. Over-block

A scoped dashboard or signed device cannot call this agent-only route, even for a public pull request. A caller without both a configured master bearer and a matching bearer is denied. GitHub GraphQL errors without a recognized throttle classification invalidate cached evidence. That choice can drop a useful lead after an ambiguous upstream error. A prior pull request already known by number remains reachable through its canonical GitHub link.

## 2. Under-block

An unchanged provider token can lose access remotely between cache refreshes. Existing fresh results can remain visible inside the stated two-minute cache window until the next refresh observes the denial. A literal-only search can miss paraphrases or work in another store. The advisory instruction can be missed. The route cannot stop a duplicate assignment and reports scoped coverage instead of broad absence.

## 3. Level-of-abstraction fit

The shared transport owns HTTPS, credentials, response size and provider failure shape. The provider derives a disposable GitHub view. The route enforces caller scope. The conversational agent weighs matches alongside other evidence and uses the existing request and assignment workflow.

## 4. Signal vs authority compliance

- [x] The retrieval result is an advisory signal.

The route enforces structured credential and request facts. Query terms and result ranking carry no authority over an answer, assignment or conversation delivery. [Signal vs. Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

A current or previous pull request may use the same words for different work. The implementation returns both when available, with observation bounds and a canonical URL. The conversational agent judges whether a match is relevant. Credential, cursor and continuation facts are deterministic floors.

## 5. Interactions

- The new read does not shadow Chief of Staff project status, evidence checks, or the path-based claim checker.
- Concurrent requests on one server share a refresh. Parallel state scans preserve separate quality statuses. Provider denial clears the active generation before its sibling can publish. Partial scans can expose earlier validated positives with their own observation times.
- A current row supersedes older evidence for the same number before searching. Validated merged evidence wins over contradictory open evidence. Continuation rejects changes to the source coverage, query, expiry and underlying revision.
- Requests trigger refreshes. No timer, write-back, notification or action dispatch starts from a search result.

## 6. External surfaces

The route calls the public GitHub repository with the existing server credential. It returns canonical URLs, bounded quoted excerpts and coverage. It sends no owner query to GitHub. It writes no new database or durable records. The conversation remains the operator-facing surface. There is no new approval or other operator action.

## 6b. Operator-surface quality

The existing conversational surface carries the answer and a phone-openable GitHub link. This change adds no dashboard page, approval action or form.

## 7. Multi-machine posture

Machine-local by design. Each machine rebuilds a short-lived GitHub view using its own server credential. The observed repository scope and times apply to that request's machine. A cold or unauthorized machine reports unavailable coverage. No durable state follows the conversation, and the canonical GitHub URLs work on other machines. The provider emits no notices.

## 8. Rollback cost

Revert the route, provider, opt-in transport extension and awareness entry, then deploy the patch. A restart drops the in-memory view. There are no records to migrate or repair. Callers temporarily lose the pull request lookup while the revert propagates.

## Conclusion

The provider and route passed the focused tests and cold authenticated source probe. Independent side-effects review and the owner-facing incident, assignment and unavailable-source replays still need evidence before release.

## Second-pass review

Independent review pending.

## Evidence pointers

- Unit `tests/unit/chief-of-staff-pr-search.test.ts` and `tests/unit/github-runtime.test.ts`.
- HTTP `tests/integration/chief-of-staff-pr-search.test.ts`, including captured public GitHub response bytes.
- Production AgentServer route lifecycle `tests/e2e/chief-of-staff-alive.test.ts`.
- TypeScript compiled successfully. The focused run passed 87 tests in five files, covering the provider, shared transport, awareness registry, HTTP route, and production AgentServer lifecycle.
- The compiled provider queried GitHub on November 23 after a direct check confirmed pull request 3342 was open. The open scan completed in 1.88 seconds. The merged scan completed with coverage from October 25 at 03:53 UTC. The cold query returned the open pull request in 8.30 seconds, and the repeat used the cache.
- The production AgentServer test proves that the HTTP route can return the link. The three normal owner-channel replays remain separate release evidence.

## Class-Closure Declaration

The change adds a read-through source for an information gap. It does not edit a defective existing agent-authored artifact or add an autonomous controller.

## Class-Closure Declaration

- `unbounded-self-action` is not applicable. The lookup starts on an authenticated request. Bounded pagination and in-flight sharing terminate each attempt. A cooldown limits a later request and schedules no future work.
