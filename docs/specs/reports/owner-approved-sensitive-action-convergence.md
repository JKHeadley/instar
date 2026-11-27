# Convergence Report — Owner-approved sensitive action (SEC-018 primitive)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex-cli / gpt-6-astra) ran on the primitive spec.

## ELI10 Overview

A few of the agent's most sensitive actions — raising another agent's trust to
full, permanently deleting a conversation thread — were always meant to be the
owner's decision. Today a program running on the owner's computer can do them and
have it recorded as "the owner did this," because the check is merely "did this
come from this machine?" — and a remote agent's message spawns a local session
that passes that check. A PIN or API token can't fix it: a local program reads
both off disk. The only unforgeable proof is a signature from a key locked in the
owner's phone. This spec adds ONE shared way for those handlers to require that
proof — reusing the existing owner-presence mechanism (the same Face-ID phone
signature that already unlocks Remote Desktop and reveals the dashboard PIN),
adding two new "purposes" (trust-grant, thread-delete). It ships dark.

## Original vs Converged

The original SEC-018 approach proposed a dedicated device-signed approval built
from scratch, and earlier drafts leaned on a PIN step-up. Convergence found two
decisive things: (1) a PIN/bearer proof is **defeated** on this threat model (the
local session reads both), so the proof **must** be a phone-enclave signature with
per-signature Face-ID; and (2) that exact mechanism **already exists** as
owner-presence — so the primitive is a small, well-patterned extension (two new
purposes), not a new authenticator. The design was then split: this primitive
holds the shared approval mechanism; the per-action gates (trust elevation logic,
the delete confirm) live in consumer specs that cite it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| (inherited) | 5 internal + codex ×4 on the parent trust design | — | — | device-signed proof; owner-physical signer predicate; authority enforcement |
| 1 (primitive) | codex/gpt-6-astra | 3 (build-time protocol) | 0 | B1 Telegram-route trust boundary stated + condition-2 met by multi-phone; B2 immutable challenge record + card-from-record; B3 crash-journal ordering |

## Proportion

Primitive spec ~130 lines; derived from the 4-round-converged parent trust design
plus one primitive-specific external pass. Proportionate for a Tier-2 security
primitive reusing a shipped mechanism.

## Left behind

- **B1 (build-time verification):** the Telegram second route is accepted only
  after the build confirms the `ownerDM` approve callback is forge-resistant
  against a bot-token holder (genuine Telegram-attested `from.id`); until then the
  owner-phone presence route carries condition-2 (multi-phone). Stated in-spec.
- Precision: canonical encoding if action fields are signed directly vs via the
  opaque-challenge→immutable-record binding — a build choice, stated.

## Full Findings Catalog

- **codex R1 (parent, SERIOUS):** step-up must be transaction-bound; atomic
  compare-and-apply; provenance vs rollback. → folded into the trust consumer +
  this primitive's binding/atomicity.
- **codex R2 (parent):** PIN offline-guessable/readable → device-signed required;
  approval revision-binding + expiry; equal-level write handling. → device-signed
  proof is the core of this primitive; revision-binding in §Approval flow / §B2.
- **codex R3 (parent):** bearer also readable → no readable credential accepted;
  enrollment authority + per-sig UV. → resolved by owner-presence (Face-ID,
  phone-enrolled presence key; browser/dashboard-pin keys rejected).
- **codex primitive R1:** B1 Telegram trust boundary; B2 challenge immutability +
  card-from-record; B3 crash ordering. → all three addressed in-spec (B1 as a
  stated build-time verification with multi-phone carrying condition-2).

## Convergence verdict

Converged. The core design — reuse the owner-presence Face-ID phone-signature
mechanism as two new purposes, enforced at the authority, with an immutable
action-bound challenge, single-use + revision-bound approval, and crash-safe
journaled apply — is validated across the parent's 4 rounds plus one primitive
external pass whose findings are all addressed. One build-time verification (B1,
the Telegram route) is explicitly flagged; condition-2 holds regardless via
multiple enrolled owner phones. Ready for operator review (ELI16) and the first
build (primitive + delete gate).
