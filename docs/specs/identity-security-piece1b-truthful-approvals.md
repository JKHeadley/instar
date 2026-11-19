---
title: "Truthful approval records: the trust tool and MoltBridge"
slug: identity-security-piece1b-truthful-approvals
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1b-truthful-approvals.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Signal vs. Authority; Verify the State, Not Its Symbol"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §11 (bearer-only approvals recorded as agent-proposal) and §12 item 1"
split-from: "identity-security-piece1.md (rounds 1-5). Piece 1a: identity-security-piece1a-local-link.md (PR 3406)."
lessons-engaged: "operator-session-is-not-human-proof, fix-the-class-not-the-instance, spec-reviews-not-falling-means-cut"
review-convergence: "2026-11-18T09:05:00Z"
review-iterations: 2
review-completed-at: "2026-11-18T09:05:00Z"
review-report: "reports/identity-security-piece1b-truthful-approvals-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1-2; gemini-cli gemini-4-argon round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# Truthful approval records: the trust tool and MoltBridge

## Problem statement

Two of the identity gaps filed during the 2026-11-17 audit are records that claim a person approved something an agent did.

1. **fb-a6c5869f-f20:** `threadline_trust` records every grant and revoke as `user-granted` (`ThreadlineMCPServer.ts:1202-1246`). The tool is reached only by an agent session (stdio or the local `/mcp/threadline` transport, both treated as local), so the record says a person decided what the agent decided.
2. **fb-aaf6541f-b73:** MoltBridge `approve` writes `approvedBy: 'human'` for any bearer-token caller (`moltbridge/routes.ts:177-200`) and then publishes.

This spec was "Identity quick fixes" in its first two review rounds. Round 1 moved the no-token refusal, Telegram's empty allowlist and SMS rows to their own specs; round 2 moved the WhatsApp signature check to its own spec (the secret sits under `config.businessApi`, owner notices need an owner-visible surface, and a wrong secret must be detected). Every round-2 design finding was in the WhatsApp section; the label changes were reviewed clean.

## Proposed design

### 1. Trust records

- `threadline_trust` grants and revokes are recorded with a new source, `agent-proposal`, instead of `user-granted`. The tool's response says `source: 'agent-proposal'`.
- The four readers that accept `user-granted` for an upgrade or admission (`AgentTrustManager.ts` known sources and the upgrade rule, `TrustEvaluator.ts:124`, `httpPeerTrust.ts:67`, `users/peerPlaceAdmission.ts:18`) also accept `agent-proposal`. Behaviour at Basic is unchanged; only the record becomes honest (umbrella §11: bearer-only approvals "stay as they are at Basic and are recorded as `agent-proposal`; they become cards from Phone up"). `userInitiated` is false for `agent-proposal`.
- **No code may treat `user-granted` as proof that a person approved something.** The trust tool was the only writer of `user-granted`, so every stored `user-granted` record was made by an agent. Stored records are not rewritten. Later pieces that need a person's approval use a signed card, never this field. A unit ratchet fixes the set of files that mention `user-granted` to the four readers.
- Not here: removing the agent's ability to change trust. The tool is today the only way to grant agent trust; taking it away needs the approval card first (piece 5).

### 2. MoltBridge approval

- `approve` records `approvedBy: 'agent-proposal'` for a bearer call. `ProfileCompiler`'s rule (anything but `'auto'` resets the auto-publish count) is unchanged, so publishing behaves exactly as today.

## Decision points touched

- **Trust and MoltBridge provenance labels** — invariant; basis: enumerable-domain; evidence: the caller holds the agent's bearer or local transport, never a verified person.
- **`user-granted` is never proof of a person** — invariant; basis: irreversible-consequence; evidence: every stored record was agent-made.

No new block or allow decision; no model decides anything (Tier 0).

## Frontloaded Decisions

1. No switch: the labels change no behaviour.
2. Stored trust records are not migrated.

## Multi-machine posture

- Trust profiles and the trust audit are machine-local by design (machine-local-justification: per-machine trust store, never synced or git-synced; confirmed in round-2 integration review). Only the value written changes. A rollback to an older build on the same machine reads `agent-proposal` as an unknown source and refuses that peer until it is granted again; noted for rollback.
- MoltBridge drafts: posture unchanged.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Trust source | the caller reached the trust tool | an agent session decided | the tool is reachable only through agent transports | n/a |
| MoltBridge approver | a bearer-token request | an agent session approved | the route is behind the agent bearer | n/a |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway: grant and revoke trust through the real `/mcp/threadline` transport and read the stored source and audit; MoltBridge approve against a recording publisher (no real profile). | Discard. |
| dev-agent-live | Throughput installs on Echo; trust records written afterwards carry `agent-proposal`. | Revert. |
| fleet | Released with the merge. | Patch release. |

## Tests and evidence

- **Unit:** the trust manager accepts `agent-proposal` for an upgrade with `userInitiated: false` in the audit; the trust tool handler writes `agent-proposal` and never `user-granted`; the four readers accept it; the `user-granted` ratchet; MoltBridge approve writes `agent-proposal` and publishes once.
- **Before/after per filed item** recorded in the PR.

## Maturation plan

- **ladder:** not applicable: no switch; the labels change no behaviour.
- **test-agent-live:** the rollout row above.
- **dev-agent-live:** Echo's trust records after install.
- **fleet:** with the merge.

## Open questions

*(none)*

## Left behind

The rest of piece 1, each its own spec: the WhatsApp signature check with the secret at `config.businessApi.appSecret`, owner-visible notices and wrong-secret detection (1i); the no-token refusal with key provisioning that reaches the lifelines (1h); Telegram's empty allowlist and SMS rows with relay enforcement (1e); PIN policy (1c); PIN non-disclosure and Basic reset (1d); member conversations (1f); WSL gateway (1g). Removing the agent's ability to change trust or approve profiles: approval cards (piece 5).
