# Round 4 — Security and Integration/Deployment

Reviewed the updated agent-home `docs/specs/telegram-message-origin.md`, its recording-outage notification contract, explicit Justin approval, the recorded fresh-main grounding, and `conformance-round-4.json`. Rechecked the hard-invariant exception in `docs/signal-vs-authority.md`. Current-source notification observations from worktree commit `77df8be42a24a09d991b044027161c95eb9322a5` informed this review. This is still a design review; no implementation or deployment is asserted.

## SECURITY perspective

**DESIGN findings: 0. PRECISION findings: 0.**

The earlier human-authority interval is closed by contract 16: operator-account forms require same-message proof, and incompatible forms are refused before content dispatch. This removes the post-content companion protocol rather than leaving its classification race unresolved. Scoped session credentials, origin attestation, browser write isolation, current destination authorization, audit-read authorization and key lifecycle remain intact.

The outage notice is a pre-recorded, sealed bot-automation operation, not permission to send arbitrary unrecorded prose. Its capability is single-use, consumed before awaiting, and remains subject to present ownership and permission checks. The exact body cannot be changed during the outage. The display snapshot and automation origin are captured while storage is healthy. A failed notice cannot recursively create another notice.

The single reservation is interpreted consistently with its stated process binding: one process owns the callable capability; the lifeline does not obtain a duplicate independently consumable permit. The contract explicitly accepts that process restart during an outage can prevent notification. Implementation must preserve that already-specified boundary.

## INTEGRATION/DEPLOYMENT perspective

**DESIGN findings: 0. PRECISION findings: 0.**

Contract 19 closes the earlier sealed-plan versus late-materialization ambiguity: narrowly authorized derivations produce immutable persisted child versions, preserve parent identity and budgets, and precede dispatch claims. The credential-owner's sole outbox and inert audit mirrors continue to avoid competing execution authorities. ASP freshness remains unchanged, with explicit renewal-or-hold behavior.

The notification contract incorporates the concrete current-source hazards: it expressly excludes retrying `sendToTopic`/`apiCall`, ordinary claim reclamation, redrive and stampede handling; consumes its permit before asynchronous work; does not restore an old permit after restart; and distinguishes notification attempts from confirmed outcomes. Dashboard/health held-state reporting provides the specified additional visibility without claiming it proves the Telegram user saw a notice. Newly encountered conversations, lost permits, revoked permissions and transport failures remain honestly disclosed limits.

Migration, legacy queued work, explicit incompatible-writer activation refusal, immutable recovery bytes, distinct-origin dedup and retained-audit cleanup boundaries remain adequately specified. Fresh-main grounding is recorded at the concrete worktree commit; tests and runtime wiring remain implementation work, not evidence already earned.

## Conformance finding disposition

`conformance-round-4.json` reports a possible reachability violation because recording failure can hold Telegram sends. Justin explicitly selected hold with notification and approved implementation. That instruction takes precedence over the general reachability preference. The draft implements the choice with durable fallback, a previously recorded one-shot notice, and live held-state visibility; it does not add a speculative unrecorded-send bypass. Therefore the automated finding is not an unresolved DESIGN issue in this approved contract. Its report remains preserved rather than rewritten as a clean automated result.

The hard binding, receipt and idempotency validators address explicit structural invariants. The bounded diagnostic consult does not gain send permission or receipt-classification authority. No signal-versus-authority violation was identified.

## Result

**Total: 0 DESIGN, 0 PRECISION.** This is one quiet review round for these two perspectives. It is not a declaration of two quiet rounds, overall convergence, implemented behavior or completed tests. No source/runtime files were changed.
