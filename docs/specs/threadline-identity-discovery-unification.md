---
title: "Threadline Identity-Discovery Unification — advertise the routable relay identity"
slug: threadline-identity-discovery-unification
eli16-overview: threadline-identity-discovery-unification.eli16.md
status: converged
supervision: tier0
review-convergence: "Converged at iteration 2 (2026-05-28). Round 1: conformance gate (22 standards, 0 findings) + lessons-aware + adversarial/integration reviewers, all grounded against live code — folded 2 blocking (F1 resolution-source must be IdentityManager.get() not relayClient.fingerprint which is null pre-connect; #6 agent-info.json publicKey must be canonical so it's consistent with the new fingerprint) + 4 material (encrypted-identity boundary, no-fabrication via .get() not getOrCreate, multi-machine same-fingerprint hazard tracked, migrator reframed as narrow-window belt-and-suspenders) + 3 minor (cite recurrence, Agent Awareness, supervision tier). Round 2: conformance gate (0 findings) + convergence-check verified IdentityManager.get() exists (read-only, no-create) — the load-bearing dependency holds — no material new issues. Report: docs/specs/reports/threadline-identity-discovery-unification-convergence.md"
review-iterations: 2
review-completed-at: "2026-05-28T07:20:00Z"
review-report: "docs/specs/reports/threadline-identity-discovery-unification-convergence.md"
approved: true
approval-context: "Authorized by Justin 2026-05-28 (topic 12476): after I briefed the full diagnosis (discovery advertises a non-routable identity while the relay routes by the canonical identity.json fingerprint) and the fix plan (unify discovery onto the canonical identity + publish the fingerprint + PostUpdateMigrator), Justin said 'enter autonomous mode and fix this properly.' Convergence sharpened the SAME approach (named IdentityManager.get() as the source, made publicKey consistent, added no-fabrication + boundaries) without redirecting it, so the authorization holds per the autonomous-run guardrail. If a reviewer had redirected to a materially different design (e.g. merging the E2E keypair), this would instead be staged for Justin's morning review."
lessons-engaged:
  - "Recurrence of bug_threadline_identity_divergence_discovery (2026-05-28) — discovery advertised a non-routable identity; this is the structural fix, not a re-patch."
  - "Report VERIFIED not intended — the resolution source is named as the exact API the relay client uses (IdentityManager.get()), verified against ThreadlineClient.ts, not 'the canonical identity' in the abstract."
  - "Migration Parity — existing agents already carry a bad agent-info.json; the fix must reach them, not just new installs."
---

# Threadline Identity-Discovery Unification

## Problem (observed 2026-05-28)

Dawn stood up a Threadline node and pinged Echo. Her side showed `sent=true`; nothing landed
on Echo (`grep "Accepted message from" logs/server.log` had zero entries from her). Root
cause: **Echo advertised an identity its own relay does not answer to.**

The relay client (`ThreadlineClient`) loads its identity via `IdentityManager.getOrCreate()`
and registers with the cloud relay under the resulting **fingerprint** (Echo:
`Threadline: relay connected (fingerprint: 63b1dbb2…)`, 30× consistent). That fingerprint —
`computeFingerprint(publicKey)`, deterministic from the canonical `identity.json` key, NOT
relay-assigned — **is the address a peer must target to reach the agent over the relay.**

But discovery advertises a *different* identity:
- `discovery.announcePresence()` (ThreadlineBootstrap.ts:111-116) writes
  `agent-info.json.publicKey = loadOrCreateIdentityKeys().publicKey.toString('hex')` — the
  orphan `threadline/identity-keys.json` hex key (Echo: `64cab8bc…`). Nothing on the relay
  routing path reads that file.
- `/threadline/health` reports `identityPub` from the HandshakeManager keypair — on Echo
  currently **empty**.

So every discovery surface advertises the wrong-or-empty identity while only the relay
registration is correct. A peer who discovers an agent gets a non-routable hex key (or
nothing) and any message addressed to it is undeliverable. **Fleet-wide**: any agent whose
canonical `identity.json` was generated/regenerated independently of its legacy
`identity-keys.json` hands out a dead address.

### Identity inventory (verified against code, convergence round 1)

| File | Loader | Used by | Encoding |
|------|--------|---------|----------|
| `{stateDir}/identity.json` (canonical) | `IdentityManager` | **relay client (routing)** | base64 + `fingerprint` |
| `{stateDir}/threadline/identity.json` (legacy) | `IdentityManager` fallback | relay client fallback | base64 + `fingerprint` |
| `{stateDir}/threadline/identity-keys.json` | `loadOrCreateIdentityKeys` | `announcePresence` only (orphan to routing) | hex |
| HandshakeManager key | `HandshakeManager.getIdentityKey()` | local E2E handshake + `/threadline/health` | hex |

The **routing identity** (what fixes the bug) is `IdentityManager`'s. The handshake/E2E key
is a separate layer (see Non-goals).

## Fix

**Invariant:** what an agent advertises in discovery == the identity its relay answers to.

1. **Single resolution source.** Resolve the routing identity via the SAME API the relay
   client uses: `new IdentityManager(stateDir).get()` (the read-only variant — see §"No
   fabrication"). This yields `{ fingerprint, publicKey }` deterministically from disk, with
   no network call, so it is available *before* the relay client is constructed. **Do NOT
   read `relayClient.fingerprint`** — it is `null` until `connect()` runs, which is after
   `announcePresence`. Resolve up front and feed the result to both the relay client path
   and discovery.

2. **`agent-info.json` advertises the routing identity, internally consistent.** Add a
   first-class `fingerprint` field (the routable relay address) AND set `publicKey` to the
   canonical identity's public key — so `publicKey` and `fingerprint` correspond
   (`fingerprint === computeFingerprint(publicKey)`). This corrects the round-1 hazard where
   `publicKey` (legacy hex) and a new `fingerprint` (canonical) would describe two different
   identities. `announcePresence` sources both from the resolved identity, not from
   `loadOrCreateIdentityKeys`.

3. **`/threadline/health` reports `fingerprint` + a valid `identityPub`** from the same
   resolved routing identity (never empty when a routing identity exists). `verifyAgent` /
   `pingThreadlineHealth` then store the consistent pair. (Note: `verifyAgent` does not
   currently perform a real cryptographic challenge — the nonce is generated but never
   exchanged — so switching the stored key to the canonical identity is safe; it only
   changes which public key is recorded, and that key now matches the fingerprint.)

4. **`machine` field is set** in `announcePresence` (currently unset) so multi-machine
   advertisements are distinguishable (see Multi-machine below).

## No fabrication (relay-disabled / encrypted-identity boundaries)

- Use `IdentityManager.get()` (read-only), **NOT `getOrCreate()`** — `getOrCreate` would
  *generate and persist a new keypair* when none exists, so a relay-never-enabled agent would
  start advertising a fingerprint for an identity that is on no relay (a well-formed but dead
  address). If `get()` returns null (no identity on disk, or `identity.json` is
  passphrase-**encrypted** and locked at boot — `IdentityManager.loadFromCanonical()` returns
  null in that case), discovery **omits** the `fingerprint`/`publicKey` advertisement entirely.
  An agent with no resolvable routing identity is simply not relay-discoverable until it has
  one — which is correct, not a regression.
- The resolver must be the exact same call the relay client makes, so an encrypted/locked
  identity yields the same (null) result on both paths — they cannot re-diverge.

## Migration Parity

New installs get the correct `agent-info.json` from the fixed `announcePresence` on first
boot. For existing agents: `announcePresence` atomic-writes `agent-info.json` on **every**
boot, and instar's update path restarts the server — so the common case self-heals on the
post-update restart. The residual gap is an agent that updates the package but whose server
does not restart before a peer tries to discover it. To close that narrow window:

- Add an idempotent `PostUpdateMigrator` step (`migrateThreadlineAgentInfoIdentity`) that
  resolves `IdentityManager.get()` and, if it yields an identity whose fingerprint differs
  from (or is absent in) `agent-info.json`, rewrites `agent-info.json` with the consistent
  `{ fingerprint, publicKey }`. **Skip (no-op)** if `get()` is null (no/locked identity — do
  not fabricate) or if `agent-info.json` already matches. Atomic write; last-writer-wins with
  a concurrent boot announce is safe (both write the same correct value).
- This is belt-and-suspenders, not the primary mechanism — the in-`announcePresence` fix is.

## Multi-machine (hazard documented; full coordination tracked)

The same agent identity can run on >1 machine; both would advertise the same routing
fingerprint. Relay routing to a shared fingerprint across machines is an ambiguity that
**pre-exists this fix** (the relay already registers the same fingerprint from each machine)
— this change does not worsen it. This fix sets the `machine` field so advertisements are
attributable, and defers full awake/standby coordination (only the lease-holding machine
advertises, or machine-scoped routing) to the cross-machine-seamlessness work.
<!-- tracked: project_cross_machine_seamlessness_spec --> The fix is correct for the
single-machine case (the actual Dawn↔Echo failure) and neutral for multi-machine.

## Non-goals

- **NOT** merging the routing identity (`identity.json`) with the E2E handshake keypair
  (HandshakeManager) or the orphan `identity-keys.json`. Those serve a separate local-handshake
  layer; collapsing them could break established E2E trust relationships (a peer that trusted
  the old handshake key would see a different key). This spec advertises the *routing* identity
  (which fixes cross-machine reach via the relay — the observed failure) and leaves the
  handshake layer alone.
- Retiring the now-unused `identity-keys.json` / consolidating the 3–4 identity keypairs is a
  separate cleanup. <!-- tracked: bug_threadline_identity_divergence_discovery --> This fix
  stops *advertising* the orphan; it does not delete it (deleting risks the handshake path and
  needs its own spec).
- NOT changing relay registration (already correct).
- NOT the Echo↔Dawn round-trip itself (blocked on Dawn re-pinging the corrected fingerprint;
  operational, separate from this structural fix).

## Testing (all three tiers + wiring + both-sides — non-negotiable)

- **Unit (resolver + announce):** resolved identity == `IdentityManager.get()` result;
  `agent-info.json.fingerprint === computeFingerprint(agent-info.json.publicKey)` (internal
  consistency). Both-sides: (a) identity present → fingerprint+publicKey advertised and
  consistent; (b) no identity / locked-encrypted → both fields OMITTED (not fabricated, no
  throw); (c) legacy `identity-keys.json` present but canonical identity different → the
  CANONICAL identity is advertised, never the legacy hex.
- **Migrator:** diverged fixture (agent-info.json carrying stale hex; identity.json carrying
  canonical) → after migration agent-info.json carries the canonical consistent pair;
  already-aligned fixture → no-op; no-identity fixture → no-op (no throw); idempotent across
  repeated runs.
- **Integration:** `/threadline/health` returns non-empty `identityPub` + a `fingerprint`
  equal to the relay registration fingerprint; consistency `fingerprint ===
  computeFingerprint(identityPub)`.
- **E2E / wiring:** boot the Threadline stack with relay enabled; assert the fingerprint
  advertised in `agent-info.json` == the relay client's registered fingerprint (the address
  the relay actually answers to). With relay disabled / no identity, assert the fields are
  omitted and boot does not throw.

## Agent Awareness

If `/threadline/health` gains a `fingerprint` field, note the canonical-fingerprint discovery
behavior in the CLAUDE.md template diagnosis/Threadline section so agents know the authoritative
"what address reaches me" source is the relay registration / health fingerprint, not the
legacy publicKey.

## test-as-self

Deploy the built dist into a throwaway agent home, boot with relay enabled, and confirm its
`agent-info.json` + `/threadline/health` publish the canonical `identity.json` fingerprint
(consistent with publicKey) — a peer discovering it would obtain the address the relay answers
to. Then a no-identity boot: confirm fields omitted, no throw. Restore.

## Rollback

Additive at the field level (`fingerprint` is new; `publicKey` changes source to the canonical
identity). Reverting removes the field + migrator; `agent-info.json` is regenerated on boot
regardless, so no data loss. The one behavioral change to flag: consumers that previously read
`agent-info.json.publicKey` as the legacy hex handshake key now get the canonical routing key —
verified safe because `verifyAgent` does not do real crypto verification and the E2E handshake
exchanges keys inline (does not read agent-info.json).

## Deferrals <!-- tracked: project_cross_machine_seamlessness_spec -->

None blocking. Two items explicitly TRACKED as separate specs (not deferred parts of this fix):
multi-machine awake/standby advertisement coordination
<!-- tracked: project_cross_machine_seamlessness_spec --> and retiring the orphan identity
keypairs <!-- tracked: bug_threadline_identity_divergence_discovery -->. This fix is complete
and correct on its own for the observed failure.
