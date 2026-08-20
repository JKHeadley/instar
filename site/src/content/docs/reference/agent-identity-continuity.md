---
title: Agent Identity Continuity
description: Why an agent that expands onto a new machine can silently become two agents sharing one name, and what carries the identity across — AgentIdentityHandover, AgentIdentityDivergenceDetector, AgentIdentityReconciler, and the mint refusal.
---

An agent is found by an address derived from its identity. One agent should present one address
wherever it runs.

Until this change, expanding onto a new machine broke that — silently.

## What went wrong

Joining a mesh provisions a clone of the shared repo, a machine-local `config.json`, a **machine**
identity (machine id, signing key, encryption key), and a pairing exchange that registers the
joiner. None of those is the **agent** identity: it is gitignored because it holds a private key,
absent from the scaffolded config, absent from the pairing response, and absent from the
cross-machine secret-sync key set.

So on first boot the agent looks for its identity, finds none, and `IdentityManager.getOrCreate()`
mints a fresh keypair.

**The design error in one sentence: the agent's identity was treated as a per-machine secret,
when it is a shared-agent secret.** Machine keys are correctly per-machine — the agent is not.

Observed live on 2026-08-19 and unreported for four days. A **plain-text** message signed on the
diverged machine verified there and was rejected as `bad-signature` by both peers, so
agent-signature provenance was inoperative from that machine. It failed safe — `rejected`, never
silently `human` — but the guarantee the feature exists to provide was absent.

## The four pieces

### `JoinedMeshDetector` — did this home join an existing mesh?

The discriminator is an on-disk fact: a machine registry naming at least one machine other than
this one, written by the pairing flow before the server ever starts. Not a heuristic.

**Every uncertain reading resolves toward minting** — no registry, an unreadable registry, a
registry listing only this machine, a missing self machine-id. An unrelated filesystem problem
must never deny a legitimate standalone agent its identity. The residual risk (a joined machine
with a corrupt registry can still mint) is what the divergence detector catches.

### The mint refusal

`getOrCreate()` refuses to mint when this home joined a mesh, throwing
`IdentityNotProvisionedError` rather than inventing an identity.

Enforced at the minting **site** rather than at its callers — guarding callers leaves the next
caller free to reintroduce it. A joined machine that cannot obtain the identity fails loudly
instead of becoming a silent twin.

### `AgentIdentityHandover` — carrying the identity across

The identity is sealed to the joining machine's X25519 encryption key over the pairing exchange
that already carries that key (it was validated and used for nothing), and returned in the same
response. Sealing reuses the in-production secret-sync primitive rather than inventing a second
scheme.

The envelope is bound to a **transcript** — pairing session id, joiner machine id, joiner
encryption key, agent name, expiry — and the joiner checks every field against what it sent.

**What authenticates the responder is the pairing code, not a signature.** An attacker who
controls the response supplies its own signing key alongside it, so the signature verifies
perfectly against the key it shipped with. The code was minted by the intended machine and
carried out-of-band by the operator; that is what identifies it. The joiner additionally pins the
agent fingerprint from the pairing artefact and refuses any identity that does not hash to it, so
a listener that merely collects a code cannot hand back a fabricated identity.

Retry is bound to the first joiner that redeems a session: the same machine may re-request until
expiry, any other machine is refused.

### `AgentIdentityDivergenceDetector` — noticing a split at all

A boot-time comparison of what each machine publishes, wired delayed and unref'd so it can never
block or fail a boot.

**Every machine observes.** An earlier design had only the lease holder look, which fails in the
two cases that matter most: the holder may *be* the diverged machine, and it may be the isolated
one. The single-notice property comes from deduping on the `(agent, fingerprint-set)` episode key,
not from restricting who is allowed to look.

Three states: `agree`, `disagree`, `cannot-tell`. **`cannot-tell` never renders as agreement** — an
unreachable peer means the check did not run, and a detector that reports those identically is how
a silent split survives. It pages on `disagree` only, but reports all three.

Signal only: it raises one Attention item and repairs nothing.

### `AgentIdentityReconciler` — repairing without guessing

Returns a **decision**; performs nothing, so a caller cannot act on an unresolved one.

Where every candidate carries post-guard provenance, canonical is the identity whose lineage
terminates in a `minted-standalone` root. Deliberately **not** used as tiebreakers, though each
looks persuasive:

- **durable prevalence** — a long-running wrong identity accumulates the same weight;
- **peer majority** — two machines cloned from one mistake outvote the correct one;
- **the lease holder** — it may be the diverged machine.

**Lineage is operational evidence, not cryptographic authority.** A compromised host or an older
binary can self-sign a false claim, so any candidate that is unattested — including every identity
predating the record — routes to an operator decision.

That decision is a choice between plain-language descriptions ("the identity used by your Mini and
Laptop since May"), not a comparison of hex strings; the fingerprints live in the audit record.
Cancellation or a mismatch changes nothing on any machine.

## Known limits

- **An existing split cannot be repaired automatically.** Lineage only applies to identities
  created after this ships.
- **Stale relay registrations are not retired.** That is a relay-side operation with its own
  authorization model, which does not exist yet. The sender-side resolver fix mitigates it; it does
  not remove it.
- **Every machine holds the same key.** One compromised host compromises the agent's identity
  everywhere, and removing a machine from the mesh does **not** revoke its copy — only rotating the
  identity fleet-wide does. This is a compatibility bridge, taken because the alternative changes
  what a routing fingerprint means for every peer holding one. New capabilities should prefer an
  account identity plus per-device keys rather than building further on it.

Spec: `docs/specs/agent-identity-continuity-on-expansion.md`.
