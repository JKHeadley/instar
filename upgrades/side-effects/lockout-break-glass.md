# Account lockout safety side-effects review

## Summary
Tier 1 declared as a reversible, narrowly requested guard patch; the credential/authority risk signal is acknowledged rather than hidden. This is below the heuristic risk floor: a revert fully undoes the shipped helper/rule changes, no live config is changed, and operator review occurs on the PR. User supplies the concrete acceptance criteria and explicitly limits local tests and prohibits merge. Size and final verification effort are recorded below after validation.

## 1. Over-block
Unknown JavaScript is treated as an action; common DOM inspection expressions are exempt. A warning page can therefore hold an unusual read expression. Account-warning heuristics can match unrelated account-warning prose. Ordinary pages still execute normally; normal credential names, passkeys, passwords, OAuth and tokens are unchanged. Native tools refuse when full text is unavailable rather than acting on a cut read. Approval remains available for an exact action.

## 2. Under-block
English matching is bounded, not semantic understanding. A new language or unrecognized warning wording may escape it. Windows/Linux read and act in separate native driver calls under the wrapper lock; page navigation or a popup can race that boundary. macOS reads and acts in one browser task. Direct driver calls, arbitrary vault scripts and a caller editing scripts are outside this guard-against-mistakes boundary. The skills explicitly forbid switching tools to bypass a refusal. This does not claim to make malicious shell use or every conceivable lockout impossible.

## 3. Level-of-abstraction fit
The shipped browser and credential helpers are the relevant boundary. Full text is inspected at execution, not in a truncated model transcript. One shared implementation supplies the browser detector, credential-name detector and approval client. The server owns issuance/consumption, not agent-controlled local grant files or an environment boolean.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md, “Safety guards on irreversible actions” exception. A multi-day publishing hold is the irreversible external effect being guarded. This is an explicitly requested deterministic safety floor, not a competing-signals judgment controller. The approval authority is the existing operator PIN gate. A caller-supplied approval id alone grants nothing.

## 4b. Judgment-point check
No new competing-signals judgment point. Named emergency credentials and account-lockout warning matches enforce the operator's requested hard safety invariant. No LLM call is added to normal sign-ins.

The non-TypeScript blocking inventory explicitly adds these seven account-safety surfaces and raises its reviewed ceiling from 12 to 19. The lint now includes .cjs, with an undeclared-CJS regression test; the new guard cannot hide outside its population. This deliberate inventory expansion is needed for the user-requested shipped browser/credential safety boundary.

## 5. Interactions
Origin and nonce envelopes still surround the macOS evaluation. Main-world actions use the caller's original code for binding and read classification; the injection envelope runs only after the guard. Native reads hold the wrapper's existing serialization lock and retain timeout handling. Unknown approval ids are rejected before the shared PIN attempt gate. Approval consumption is synchronous in one server event-loop turn, preventing concurrent replay. Restart drops all approvals.

## 6. External surfaces
New routes: Bearer-authenticated POST /lockout/request and /lockout/consume; opaque-id GET/POST /lockout/approve/:id, with approval POST requiring the existing rate-limited dashboard PIN. This is the existing trusted-agent PIN boundary, not protection against an agent intentionally reading config.dashboardPin and self-approving. The scripts never read the PIN. Requests/grants are bounded in memory, expire after five minutes, and contain action digests, not secret values or page text. No normal action adds a server round trip. No live agent state changed.

## 6b. Operator-surface quality
The phone page leads with the approval and a full-width PIN form/button. It explains the potential hold, one-action scope and expiry in plain language. The digest is in a collapsed support detail. No revoke/delete action competes with approval. CSS has a viewport tag, bounded content width, border-box fields, readable 18px text and wide tap targets. No raw code or credential appears in primary content. Operator reviews the exact action with the agent before tapping.

## 7. Multi-machine posture
Machine-local BY DESIGN: approval binds a browser profile or a credential on that machine (physical-credential-locality). It cannot approve a peer's action; request links use that server's existing tunnel URL. An agent moving machines must request a new approval. No notices are emitted automatically, so no duplicate notification controller is introduced. There is no durable state to strand on topic transfer. No status/health/capabilities answer changes.

## 8. Rollback cost
Revert and ship an update. Built-in browser/custody scripts refresh on update; skill safety paragraphs are idempotent and may remain as conservative guidance. No persisted schema, migration repair, credential rotation or live agent mutation is introduced.

## Class-Closure Declaration
This fixes a tool safety boundary rather than an agent-authored-artifact defect. No self-triggered controller is added. Not applicable to that registry lane.

## Second-pass review
Reviewer: /root/lockout_review. Concur with the review after resolving effective-target rebinding: ndrive now includes either ND_USER_DATA_DIR or the SHA-256 of the actual target.json contents in its action binding, so an attach to another account invalidates the approval. The review also caught and corrected the credential-store dependency/metadata gaps, literal suspension/locking matching, unsafe environment-based mainworld classification, and unknown-id PIN-budget charging.

## Evidence
Validation: 171 related unit tests across six files (169 in the bounded combined run, plus the final break-glass-name and receiver-option regression additions), 9 integration tests across two files, and 2 E2E lifecycle tests. All pass. The final two changed unit files were re-run individually after their additions. The E2E exercises the production AgentServer boot, a real HTTP listener, installed secret-get and browser approval clients, PIN approval, single-use consumption, a normal Bitwarden custom-field/local-writer handoff, and recovery-field refusal. Fresh init and repeated updates are also exercised. TypeScript noEmit, blocking-surface lint and diff whitespace checks pass. Only related test files were run, one worker at a time; no full suite.

Proportion: one implementation review round plus final independent concurrence; first commit-gate attempt. Final file/LOC totals are recorded in the PR. Tier 1 declaration and its below-floor reasoning are auditable in the instar-dev trace/decision audit. The supplied Echo-local reference hook was absent at the requested path; matching boundaries are explicit in tests instead of claiming to have read it.
