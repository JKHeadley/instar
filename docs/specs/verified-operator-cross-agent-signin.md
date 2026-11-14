# Verified operator approval for cross-agent subscription sign-in

Status: design record, 2026-10-27. Operator direction: Justin, authenticated Telegram uid 7812716706 in topic 33890.

## Scope

All Claude and Codex accounts designated for Echo are shared across Echo machines; there is no inferred “2.0-only” subset. An agent may prepare profiles and perform approved sign-in on its machine. A real Google challenge, absent credential, or unproven recovery method remains an observed limitation, not a policy ban.

An approval received in one agent's authenticated operator conversation should be usable by another agent only when Instar can prove the same human authorized the exact operation. Threadline and Witness identify agents; their ordinary messages are not operator approval. If proof cannot be verified, the target requires a direct authenticated operator action or a PIN-authored scoped mandate.

The trusted peer's report remains a strong lead: the target must use it to prepare the exact request, not discard it or make the person repeat the story. If direct approval is needed, the target agent initiates a phone-completable, prefilled request to the person in its own already authenticated operator conversation. A newly created or bound Threadline topic is a routing surface, not approval proof; the target must receive a fresh authenticated operator action there before authorizing anything. It then resumes the workflow after approval. The person should not have to find the agent, run commands, or perform agent-owned setup.

## Organizational approval hierarchy

An Instar agent operates as an employee with a defined role. The order is: (1) its own standing grant covers the work, so it acts; (2) another verified agent may approve in its own name only if an independently recorded delegation grants that peer the exact approval authority and its scope covers the action; (3) a peer may relay the operator's decision only with verifiable operator-origin proof bound to this request; (4) otherwise the target asks the operator directly using the smallest phone action. A trusted peer's report without one of those grants is useful context for preparing that request, not a veto or an authorization. Neither an agent nor a peer can expand its own grant, and the target verifies authority at the action doorway, not by trusting conversational prose. Current Instar does not yet provide the cross-agent receipt or a general delegated peer-approval verifier; those remain implementation work under issue #2413.

## Receipt contract

The signed cross-agent receipt is tracked in [Instar issue #2413](https://github.com/JKHeadley/instar/issues/2413). <!-- tracked: #2413 -->

1. The issuing server obtains the Telegram uid and message id from its authenticated ingress record, never from message text or an agent-supplied uid. It verifies the uid is the topic's bound operator.
2. A structured action request names target agent fingerprint, account id and canonical email, provider, target machine, action (start sign-in / approve repair / credential transfer), immutable repair digest when present, and a short expiry. The issuing server must derive that exact scope from the operator's authenticated selection or show it for explicit confirmation in the same authenticated operator flow; it must never bind an unrelated authenticated message to agent-supplied scope. Credential transfer is a separate action.
3. The server signs the receipt with its pinned agent identity key and carries the authenticated ingress reference. The target verifies the signature against its pinned peer, the authenticated sender, the operator principal link, exact bounds, expiry, and a one-time nonce. It must check revocation at use.
4. The target consumes the receipt atomically before external action and records an audit decision. No generic 'operator said yes' prose, copied Telegram message, or Witness note can satisfy this check.
5. The operator principal link may be established by the target's own authenticated inbound uid or a PIN-authored identity link. Replicated topic-operator data remains advisory and cannot establish the link.

## Sign-in and recovery outcomes

Approval authorizes the scoped sign-in workflow, not secret transfer. A one-time Google session can enable warm repair but does not prove unattended cold repair. Cold recovery requires a tested vault method, a tested passkey cell, or a new operator action. An unknown passkey state must remain unknown. Success requires the expected identity and real authenticated Claude/Codex use.

## Current implementation boundary

Instar currently has local verified topic-operator bindings and signed same-agent cross-machine mandates. It does not have this cross-agent operator receipt. A PIN-triggered passkey proof route exists, but Scout's passkey feature is disabled and production re-login does not inject `passkeyCellState`, so a `google-passkey` repair still reads `unknown` and refuses. In a 2026-10-27 Threadline read-only inventory, Scout reported that its exact-identity unattended repair policy covers all eight Claude accounts, Dawn's repair began under it, and six Google profiles have no sessions; these are peer-reported live-state observations, not repository facts or proof of human approval. Scout also reported an already authorized Bitwarden/Keychain path containing several passwords and TOTP seeds; using that path is distinct from copying secrets into Scout's Instar vault. The missing receipt matters for a new action outside standing policy, such as the two missing Codex enrollments. Credential transfer and consumption of single-use backup codes remain separately scoped.

## Acceptance

Unit: forged uid, agent assertion, wrong peer, wrong operator, wrong account/machine/action/digest, expired/replayed/revoked receipt all deny; valid same-person receipt allows one use. Integration: authenticated ingress mints, Threadline delivery verifies, repair route consumes. E2E: production initialization wires issuer/verifier and live target route; a valid receipt reaches the repair workflow while an unverified peer claim is refused. Existing-agent migration updates the sign-in skill and all framework shadow instructions.
