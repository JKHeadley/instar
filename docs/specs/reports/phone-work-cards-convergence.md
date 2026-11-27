# Convergence Report — Work cards from the owner's phone

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, gpt-6-astra) ran in all six rounds. The Anthropic clean-door second read (claude-code, a same-family read, not cross-model) ran in rounds 2–5; it timed out in round 1 and had not answered by the end of round 6.

## ELI10 Overview

The owner's phone can now do two things the dashboard already does: open one work card by itself, and turn a message into a work card. Making a card is a decision by the owner, so it uses the same Face ID approval the phone uses for every other decision: the phone asks the agent for a one-time code tied to exactly this card, the owner confirms with Face ID, and the phone signs it with a key the agent never has. The card remembers which conversation and message it came from, exactly as the dashboard's "Make a card" records it.

If the phone's network drops the answer and it tries again, it gets the same card back, not a second one, because the card's identity is worked out from the owner and a request number the phone picked. Anything the agent can tell is wrong before Face ID (the conversation is unknown, the text is too long, it contains a password, the card was already made with different text) is answered before the owner is asked for Face ID.

The trade-offs: a retry after a lost answer asks for Face ID again (deliberately, so the approval is never weaker than for card taps), and the conversation must be one the phone's machine knows, which is the same rule the phone uses for sending messages into it.

## Original vs Converged

- **What is stored is what was signed.** Originally extra fields were "ignored" only at the top level; a done item could carry a hidden setting that lets the agent certify its own work. Now the server rebuilds the card from exactly the signed fields.
- **Refusals before Face ID.** Originally the conversation check happened before the proof but length limits and the password check happened after it. Now a dry run of the real write and a preflight mode catch all of these before Face ID, and a card already made with different text is refused before Face ID too.
- **Cross-machine retries.** Round 1 found that two machines writing the same card could reorder its history; round 2 proposed changing the board's merge rule. Round 3 removed that change after confirming that a phone's approval key exists only on the machine it paired with, so a retry can only reach that one machine.
- **Lost-answer recovery.** A replay now finishes the after-create steps and is accepted even if the source conversation was deleted since.
- **App contract.** The preflight returns the server's own rebuilt draft and hash, so the apps need no hand-written JSON encoder; the retry rules list exactly which answers are final.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons, codex | 8 | 9 | projection of signed fields; POST allowlist row; plain messages; preflight; replay re-runs after-create; E2E/awareness/release note; first-created-wins proposed |
| 2 | integration (internal), codex, claude-code | 5 | 6 | preflight includes dry run; owner check before proof; replay skips source check; first-created-wins removed (machine-local writes) |
| 3 | claude-code | 1 (+1 rejected: card id grammar holds for all ids) | 8 | existing-card refusals before Face ID; shared shape function; retry contract; more hash vectors |
| 4 | codex, claude-code | 3 | 6 | terminal answers listed; preflight returns rebuilt draft; after-create failure stated; switch wording; Face ID rationale |
| 5 | claude-code | 3 (app-contract wording; owner-key and byte-storage claims verified against code) | 7 | retention after a signed send, owner-initiated retries, drop pending; owner-key wording |
| 6 | codex | 1 (app persistence ordering) | 6 | persist before dispatch (one paragraph); internal reviewer: 0 design |

Standards-Conformance Gate: round 1 ran (3 flags: limit evidence, multi-machine source check — both addressed); round 2 ran (0 flags); round 3 ran (2 flags: limit evidence, live-user proof — addressed by inheriting existing limits and naming the app builders' live proof); rounds 4–6 not re-run (the spec's governing claims did not change).

## Proportion

Tier 2; ~9 source files, ~330 LOC source plus ~450 LOC tests; 6 of 6 rounds. The later rounds' design findings were almost all about the app-side retry contract, not the server design.

## Left behind

- Owner key changing between a send and its retry (a team record created in between) derives a new card id; accepted edge, near-unreachable.
- `bad-target` / `bad-proposal-hash` from the action builder are unreachable after the parse.
- Preflight on a true replay answers 200 without the card id (the replay itself answers it after Face ID); Frontloaded Decision 2.
- The challenge's bare `challenge-invalid` / `presence-invalid` codes are shared with card taps; the app words them.
- Lone UTF-16 surrogates in pasted text: `JSON.stringify` escapes them; clients using the preflight's returned hash are unaffected.
- A server update tightening a shape rule between an attempt and its retry (shape 400s treated as terminal).
- The checks-1 503 (not wired) is not audited, as for card taps.

## Full Findings Catalog

Round 1: unsigned `certify` on done items (high, fixed); cross-machine `created` collision (med, resolved in round 3 by machine-local proof); missing POST allowlist row (fixed); bare refusal codes (fixed with messages); missing E2E/awareness/release note (fixed); replay leaves after-create incomplete (fixed); preflight claim overstated (fixed with preflight mode); status-table sample path (fixed).
Round 2: limits/credential refusals after Face ID (fixed: dry run); fold-change rollback unsafe (fixed: change removed); no-team-owner after proof (moved before); replay blocked by deleted source (fixed); E2E fixture switch (fixed).
Round 3: existing-card refusals after Face ID (fixed); card id grammar (verified, no change).
Round 4: retry terminal answers (fixed); client canonicalization burden (fixed: preflight returns rebuilt draft); after-create failure status (stated).
Round 5: retry exit (fixed); solo-owner key (verified: resolves to `owner`); byte-for-byte storage (verified + test).
Round 6: persist before dispatch (fixed).

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final internal round found nothing that changes what gets built; the final external finding was a one-paragraph app-contract ordering fix applied in place. Seven items left behind. Spec is ready for approval.
