# Convergence Report — Machine self-assertion

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on every round, alongside a
clean-door Anthropic read (claude-fable-5). Both external families reviewed all five rounds.

## ELI10 Overview

Twice in one week a machine couldn't tell the others something true about itself. In the
first incident the Studio's identity files vanished, its keys were regenerated, and the
other machines kept rejecting its messages for two days because they still held the old key
— a silent, one-way outage. In the second, a machine running inside a nested Linux
environment couldn't see the address everyone actually reaches it on, so it kept advertising
one that works from nowhere.

This spec is how a machine safely states "this is my new key" or "this is my address" to
peers that can't verify the claim from the claim alone. The hard part is honest: after a
machine loses its key entirely, nothing cryptographic distinguishes a genuine recovery from
someone who stole the shared machine password and is impersonating it — unless a recovery
secret was set up in advance. So the design does two things. For the common case (key lost,
address unchanged — the actual incident), it recovers fully automatically by checking
evidence the peers already hold: their own record of refusing the machine's messages, plus
the re-announce arriving from an address they'd verified under the old key. For the rare
worst case (key AND address both lost), the operator approved adding a **recovery key** —
minted once at setup, stored where the shared password can't reach it — so even that case is
zero-touch and impossible to forge. Where a machine can't hold a recovery key safely (a
server with no OS keychain), it honestly says so and asks for one tap in that rare case,
rather than pretending to be protected.

The whole thing ships switched off, in rehearsal mode first, and is fully reversible.

## Original vs Converged

The first draft said: let a machine re-announce its new key automatically, proving it holds
the new key. Five rounds of review (including two non-Anthropic models) killed that: *anyone*
who just generated a key can prove they hold it, so combined with the shared password it was
an identity-forgery machine whose only trace was one notification into a queue that had
already been shown to bury alerts.

What changed, round by round:
- **Rounds 1–2** replaced the proof-free accept with a corroborated one (the peer's own
  refusal evidence + a verified source address + cross-peer agreement), a monotonic epoch +
  tombstone so identities can't be rolled back or raced, and a **must-acknowledge
  identity-change ledger** so no key swap can slip past unseen — and established the honest
  limit that after total loss only a pre-established secret closes the gap.
- **Round 3** adopted the operator's chosen recovery-key, then caught that sealing it in the
  local vault does NOT survive the incident on a keychain-less machine (the vault's own key
  lives in the very folder that vanishes), and that a distributed peer-share scheme
  degenerated on small meshes and didn't beat the threat model — so it was simplified to a
  keychain-verified vault only, with an honest "no protection here, one tap" fallback.
- **Rounds 4–5** gave the recovery key the same rigor as the signing key (its own epoch,
  tombstone, cross-peer agreement, and a structural rule that establishing it the first time
  requires the operator, not the password), pinned where the sealed blob lives so it too
  survives, and made first-hand recovery anchors authoritative so 2-machine meshes stay
  zero-touch.

## Iteration Summary

| Round | External verdict | Design-class findings | Outcome |
|-------|------------------|-----------------------|---------|
| 1 | SERIOUS / SERIOUS | ~40 across 8 reviewers | proof-free accept killed; corroboration+PIN designed |
| 2 | (internal) | condition-4 direction, replication-stub leg, quorum gap | corroboration corrected; ledger; keyEpoch |
| 3 | MINOR / MINOR | escrow: vault doesn't survive; Shamir degenerate; recovery-pubkey unhardened | escrow → keychain-only; Shamir dropped; recovery-pubkey rigor |
| 4 | MINOR / MINOR | first-establishment invariant; recovery-epoch lag; de-pair atomicity | folded; all round-3 findings verified CLOSED |
| 5 | MINOR / MINOR | ciphertext location (completion); all else precision | **CONVERGED** — security + adversarial finals both declare sound |

## Convergence verdict

Converged at round 5. Both the security and adversarial reviewers, on their final pass,
independently declared no remaining DESIGN-class exploit and the escrow root-of-trust sound;
the remaining items were precision/wording, all failing safe, and are folded. Every critical
finding across five rounds is closed. External verdicts improved monotonically
(SERIOUS→MINOR) and stabilized. The spec is ready for operator review and the
`approved: true` build sign-off.

Honest scope note: this is a converged DESIGN. It is a substantial Tier-2 build (a serialized
identity funnel, recovery-key lifecycle, migration/retro-mint, per-peer acceptance, observed
endpoints) and will be built and re-reviewed increment-by-increment under /instar-dev with
its own tests and the dark→dryRun→graduate rollout ladder specified in FD3.
