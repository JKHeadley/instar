# Convergence Report — Owner-approved actions over the stdio MCP transport

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex-cli, `gpt-6-astra`) ran through the agent's own codex CLI on all three rounds and materially shaped the design — it caught the cross-process-resurrection question and the consume/execute atomicity split that the Claude-family reviewers did not surface first. Clean RAN state.

## ELI10 Overview

The companion PR #3218 makes deleting a Threadline conversation require a one-tap Face-ID approval on the owner's phone — but only for one of the two ways a session's `threadline_*` tools are served. The *default* way (a small per-session "stdio" helper process) was left unguarded, so once the feature is switched on it would protect only the opt-in minority. This spec closes that gap before anyone flips the switch.

The hard part is that the stdio helper is a **separate process** from the agent server that holds the owner's approval. The first design tried to add the gate inside the helper and have it phone the server to "consume" an approval. Three rounds of review (five Claude-family reviewers + a non-Claude GPT reviewer, reading the actual merged code) tore that apart: making the gate's method asynchronous would have silently turned the check into a no-op and let deletes through unapproved; the helper doesn't even hold the credential the first design assumed; and exposing the "register/clear a pending card" operations to callers would let a hostile local process *delete the owner's own approval request* so they could never approve. The design was rebuilt around a single idea: do the **whole** gated delete — check the switch, consume the approval, delete the thread — in one place on the server, and have **both** transports call that one operation. That removes the no-op risk, the wrong-credential bug, and the lock-out, all at once.

What changes for a user: nothing until the feature is switched on, and even then nothing on normal use. When on, deleting a conversation shows one Face-ID card; approve and it's gone. The one honest trade-off: a delete now needs the agent server reachable (it already does for every other action), and if the server can't be reached the delete reports "outcome unknown — check the conversation" instead of silently happening or silently failing.

## Original vs Converged

**Originally (Option A):** a loopback `/mcp/owner-approval` route exposing `consume`/`register-pending`/`clear-pending`/`enabled` actions, authenticated by the local-mcp-secret, with the gate kept in the stdio handler and the `OwnerApprovalGate` interface made asynchronous.

**After review (Option C):** one server-side `performApprovedDelete(threadId)` that atomically checks the live `enabled` flag, consumes the device-signed approval (revision-validated), and performs the deletion — exposed as a single `POST /threadline/approved-delete` route (body `{threadId}` only, agent-token + an extracted loopback guard, no caller-facing consume/register/clear/enabled actions). Both transports call it: the HTTP handler in-process, the stdio helper over the route. The async gate interface is deleted. The change that mattered most: moving the *entire* operation server-side instead of just the check — it dissolved the fail-open, the wrong-auth-boundary, the enablement fail-open, and the one-call owner-approval lock-out together, and it keeps the irreversible mutation at the authority.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, integration, decision-completeness, codex | 9 (async fail-open; enabled fail-open; not-at-authority; wrong auth boundary; owner-approval lock-out; caller-composed card; false DoS bound; split consume/execute atomicity; sync-interface contradiction) | 3 | Full redesign to Option C (server-side atomic `performApprovedDelete`, both transports) |
| 2 | security, integration, codex | 2 (FIFO-eviction residual + false "lock-out eliminated" claim; admission mechanism factual error) + crash-safety, outcome-unknown, revision-binding | 4 | existence-check-before-register + dedupe; corrected residual disclosure; agent-token + extracted loopback guard; outcome-unknown on transport failure; crash-safe consume-then-mutate; shared handler does no local mutation |
| 3 | internal: CONVERGED (0 design); codex: 1 (cross-process resurrection) | 0 build-changing (codex's item resolved to a documented existing `ConversationStore` guarantee) | 5 | precision: documented the reload-per-op/CAS/atomic-rename cross-process guarantee; corrected build-check 5c wording; sustained-flood self-heal nuance; shared-registry forward note; parent delete-exception note |

Standards-Conformance Gate: ran each round (0 flags).

## Proportion

Tier 2 (security-sensitive auth gate on an irreversible action). 3 rounds of a 6-round cap. Proportionate — each round changed the build until round 3, which found nothing that does.

## Left behind

- **Per-caller rate cap on `/threadline/approved-delete`** (closes the sustained-flood re-eviction case for agents with >128 real threads). PRECISION/hardening → recorded as a build follow-up, not required for this dark change. The core invariant (no unapproved deletion) holds without it.
- **One-line note in the primitive spec** recording (a) the delete-specific exception to the resource-state-binding + journal contract and (b) the requirement that every future shared-registry purpose keeps an existence/enumerability check. → a small parent-spec edit, tracked.
- **`OwnerApprovedActionStore.consume()` JSDoc "deletes first" → deletes last** (comment-only; code is correct). → build-check 5e.

## Full Findings Catalog

All findings and their resolutions are recorded in `scratchpad/stdio-transport-round1-findings.md` (rounds 1–3, per reviewer). Headlines: every Round-1 critical (async fail-open, enabled fail-open, enforcement-at-authority, wrong auth boundary, one-call lock-out, caller-composed card) is **closed at the mechanism level** by Option C, verified against the merged code by the code-reading Round-3 reviewer. The Round-2 FIFO-eviction residual and admission-mechanism errors are closed (existence-check + dedupe; agent-token + extracted loopback guard). codex's Round-3 cross-process-resurrection concern is resolved by the existing `ConversationStore` reload-per-op + per-record CAS + atomic-rename design (a helper write to a different thread reloads the latest file and cannot resurrect a server-deleted thread), now documented in the spec.

## Convergence verdict

Converged at round 3. The code-reading internal reviewer found zero DESIGN-class issues; codex's single DESIGN-labelled item resolved to a documented guarantee the existing foundation already provides, not a build change. The remaining items are precision/forward-notes recorded in `## Left behind`. The design is sound, verified against the merged code, and ready for operator review and approval. Nothing flips the live switch without the live phone-tap proof regardless.
