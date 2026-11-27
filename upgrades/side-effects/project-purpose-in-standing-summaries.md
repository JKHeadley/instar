# Side-effects review for project purpose in standing summaries

**Status** The independent reviewer concurred on the scoped reader, current Codex session proof, and retirement check. Production proposals are disabled.

## Summary

Standing summaries read the purpose from the project registry at session start and during recovery. The packet includes the exact source reference and labels a proposal as unconfirmed. Claude Code checks the staged packet against the current registry before reading it. Codex builds and verifies the packet when it seeds the next prompt.

The change affects recovery, source attribution, and session identity. It uses the Tier 2 review path. The focused test runs passed 57 unit tests, ten HTTP tests, and eight framework lifecycle tests. A seventh, narrowly scoped review approved by Chief of Staff closed with the Codex credential negative control. No runtime disclosure was found.

## Decision points

- The registry owns the conversation binding and determines which source is trusted and whether its purpose was confirmed.
- The summary assembler includes the registry purpose first if a current exact binding returns it.
- The summary verifier compares the rendered purpose and its fingerprint against the current registry result.
- The Claude recovery hook uses ordinary recovery when it cannot confirm the staged packet against the registry.

## 1. Over-block

A valid purpose can be omitted if its rendered block exceeds the existing packet allocation, the registry is unavailable, or a binding is missing or ambiguous. A restart racing a changed source can use ordinary recovery until the new packet is staged. The pilot must measure these outcomes.

## 2. Under-block

The renderer relies on the registry to verify source authority. If the registry admits the wrong conversation or owner, summary matching alone cannot detect it. The canonical reader must verify the association before it returns a proposal. Live verification must cover both the local Studio source and the trusted Mini lookup.

## 3. Level-of-abstraction fit

The registry owns source admission and confirmation. This release has no production grant. A future Studio grant requires direct, verified owner authorization for the exact disclosure and binds the machine, project, target, source and wording digest. The private file can activate only a grant the release already contains. The proposal reader verifies the original history once at boot. The summary and hook check that the exact designation still exists and the same operator still owns the Telegram source. They do not scan history in the recovery request. The existing packet stager manages refresh after registry changes.

## 4. Signal versus authority

The [signal versus authority standard](../../docs/signal-vs-authority.md) allows deterministic integrity checks. This change checks a bounded packet, exact current registry text and fingerprint. It leaves decisions about source authority and user intent with the registry and operator.

## 4b. Judgment points

No new heuristic arbitrates competing signals. A proposed source can be visible, but only the canonical approval record can confirm it.

## 5. Interactions

A registry update requests a packet refresh. Claude verifies whether the staged packet remains current when it reads it. Codex verifies its freshly built packet and the proposal requires the caller's bind token to match the live destination. Both use the existing recovery fallback if verification fails.

The Claude PreCompact file has no live registry check. It omits the project purpose and leaves current purpose delivery to recovery. Practice fold packets also omit it. The standing packet frames the owner wording as a bounded quote and verifies that exact range against the current registry. Derived summaries cannot supply their own purpose headings or source labels. Fixtures cover changed references, confirmation, missing proposals, a stale fingerprint, and quoted source labels and section headings inside the original owner message.

## 6. External surfaces

The summary includes the registry's purpose and source reference. The diagnostic route exposes integrity status without the purpose text. The local recovery endpoint returns a boolean. The Studio pilot can show only the cross-conversation quote in the immutable release grant. Other disclosure and all confirmation remain under the operator-session route. Jobs and Projects owns the separate phone-completable batch confirmation.

## 7. Multi-machine posture

The renderer uses its local authoritative registry read. A moved session can obtain the same purpose only when a trusted current registry record is available on its machine. The source writer owns trusted Mini history verification. Live fleet coverage is still pending.

## 8. Rollback

Removing the local designation pauses new proposal delivery. To retire it, first write the persistent retirement marker, which remains in place across application rollback. Then deploy a release with the grant removed. Granting versions check the marker before startup or delivery, even if the old designation is restored. A renderer rollback reverts the renderer and hook together and regenerates the installed hook. Ordinary recovery remains available. The registry records remain readable and require no data rollback.
