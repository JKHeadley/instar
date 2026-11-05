# Convergence Report — Approve a waiting phone instead of reading and retyping a code

## Cross-model review: codex-cli:gpt-6-astra

The external pass ran on round 1 through the agent's codex CLI, against the spec only (no repository access). It was not repeated on round 2's delta.

## ELI10 Overview

Adding a phone used to mean reading a code in one place and typing it into the app. Now the owner taps Approve in their private Telegram chat, on the pairing page, or on an already paired owner phone with Face ID. The code stays as the fallback.

A tap proves less than a typed code: it does not show that the person answering holds the phone. So the review was mostly about one question, whose phone is this tap for, and the design now answers it with a key to compare, a refusal when two phones wait, a contested mark when a link is used twice, and code-only for a phone meant for someone else. It does not answer it completely, and the spec says where.

## Original vs Converged

The first version relied on the single-use link and an optional key comparison, and said a session gained nothing. Reviewers showed that the DM arrives exactly when an owner expects one, that an MSP's phone has no binding at all without the code, that the two-waiting rule lapsed after one tap, and that a remote API-token holder gains something real. The converged version adds the contested mark, makes the key an explicit condition in the message, makes MSP phones code-only, and names the residuals.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security + adversarial (internal), codex | 6 | 3 | contested mark, MSP code-only, message wording, locality wording, §4 rewritten |
| 2 | security + adversarial (internal), delta only | 3 | 1 | one notice per link, status-aware notice, remote token holder named |

## Proportion

Tier 2, about 500 source LOC; 2 rounds against a cap of 6.

## Left behind

- Number matching (the phone shows two digits, the owner picks from three buttons). Would narrow the thief-first residual. Not built: the operator asked for plain Approve and Decline. Offered in the build report.
- A survivor of two waiting phones can be tapped after a wrong Decline or an expiry. Accepted, spec §4.
- Provenance: `telegram-dm` and `dashboard-pin` cover both a typed code and a tap. Kept: same proof, values the app and ledger know.
- Client work is the app session's (the requester builds it); `owner-phone` is only named when a phone there has a presence key, and is never the only choice listed.

## Full Findings Catalog

Round 1, internal: (1) High, a session turns its Bearer token into owner-phone power by asking for a tap: accepted residual, stated in §4. (2) Medium-high, the thief-first race arrives when the owner expects a DM: contested mark, stated residual. (3) Medium, MSP phones have no holder binding: code-only. (4) Medium, the two-waiting rule lapses after one tap: phones left waiting beside an activation are contested. Nits: provenance (kept), approval during DM wait undone by the failure branch (fixed), griefing bounded (holds), two machines (stated), spec named the wrong store (fixed).

Round 1, codex: (1) client work out of scope and `owner-phone` advertised regardless of the app build: the requester builds the app, and other paths are always listed. (2) the message did not state the key comparison as a condition: fixed on all surfaces. (3) locality wording circular: reworded, forwarding named as a scope decision.

Round 2, internal: (1) Medium-high, the remote API-token holder crosses a boundary that exists (mobile-device-keys §2.2): named in §4 for the operator. (2) Medium, a reuse notice told the owner to decline a phone already active: status-aware notice. (3) Low-medium, notice flood after the mark clears: tombstone removed on first reuse, one notice per link. (4) Low-medium, survivor can be tapped: accepted. Nit: no chat on the dashboard path: stated.

## Convergence verdict

Converged at round 2: the last round's findings were one wording of a residual, two small fixes and one accepted trade. One item needs the operator's knowing acceptance, the remote token holder residual in §4; the off switch restores today's boundary.
