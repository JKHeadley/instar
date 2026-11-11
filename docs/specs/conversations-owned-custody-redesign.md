# Conversations: owned machines by default, external custody optional

Status: implementation in progress, not release accepted. The new product requirement is authoritative; the implementation below was proposed to and is being implemented by the existing source and custody owners. Focused functional and independent checks exist, but the full proof checklist below has not passed. The earlier v3 approval and its provenance remain historical and are not rewritten.

## Requirement and provenance

The VM hub136110 forwarded Justin's09:50 ruling: “we should never ever ever require anything that forces the user to purchase a third-party service”. This reached the coordinator in the10:30 compact handoff. The same handoff explicitly requires the feature to work on owned machines by default; a read-only “Sync setup needed” screen without an outside witness is insufficient. The original VM ledger retrieval was temporarily unavailable at this checkpoint; no independent Telegram message ID or extra approval is invented.

All witness purchases and creation remain held. A paid provider, external account, cloud token, external auditor or outside hosting must never gate ordinary Conversations use. An external custody copy is an optional robustness enhancement. Its authorization and provider policy are relevant only if the owner chooses that enhancement.

## Plain-language answer

Yes: the Pending copy can live on the agent's own machines. Keep the existing durable custody engine, but run it automatically on an enrolled owned machine. A single-machine installation must create, move, name, read and erase locally without external configuration or enrollment. Multiple owned machines use the same signed membership, source replication and final receipts.

What changes is the failure guarantee. A source and custody database on the same disk are one copy for machine-loss purposes. They cannot promise recovery if that machine is lost. Another owned machine can provide a genuinely separate copy; an optional outside host protects against a wider fleet failure. None of those stronger guarantees permits claiming a copy exists before its durable receipt arrives.

A sleeping peer can delay shared commitment, but must not disable local editing. Show the owner's local Pending overlay and named waiting machines while retaining the last agreed shared tree. Waking an owned machine can finish synchronization. Buying a service is never the remedy required to use the feature.

## One engine and three distinct outcomes

Reuse GraphWitnessService, Source, Intake, CoherenceJournal, encrypted bundles, native fencing, exact immutable packets, activation/transfer and final-certificate machinery. Do not create a second graph store or replace receipts with booleans.

1. **Recorded here:** an owner-admitted sealed intent is durably queued on this machine. It is not remotely recoverable Saved, has no canonical effect, and may be lost if this is its only copy and the machine is destroyed.
2. **Copied independently:** actual signed durable custody on a different verified machine establishes survival of the recording writer's loss. An owned peer and an optional external host have different scopes. A same-disk prepare never establishes this state.
3. **Shared commitment:** the existing all-installed source, terminal certificate, certificate-persistence and proof-delivery requirements pass. Only then does the canonical shared tree change. With exactly one installed member, the complete local fsync/certificate protocol satisfies all-member=1; it does not imply off-device recovery.

The response must identify actual custody scope instead of inferring remote durability from any witness-shaped signature. Owner-visible language should say where the pending copy is and what is still waiting.

## Local intent admission before global allocation

Changing only the witness URL does not satisfy this requirement. The current runtime requires fresh witness readiness and allocates a global source sequence before preparation. Independently allocating that sequence while its accepted prefix is unknown can fork the history.

Extend the existing Intake with a bounded, sealed **pre-admission queued-intent** state. It stores the exact logical request identity, immutable owner intent, observed heads/version and verified admission snapshot. It allocates no global sequence, grants no source receipt, and enters neither the metadata journal nor the canonical reducer. Sensitive text remains encrypted and subject to priority erasure; ordinary state stores no PIN/session token or plaintext content key.

The current native writer promotes this same intent only after it can validate the actual current profile and prefix. It rechecks owner/key/person revocation, project scope, observed heads/version, erasure fences and actual WriteAdmission/native lease. It then uses the existing serialized allocator and source/custody/all-member protocol. Already-frozen packets retain their exact original sequence, core, signature and authority: no resequencing to conceal a missing predecessor.

A stale or revoked queued intent gets an explicit refusal. It is never silently changed into a different request. Cross-machine retries use the same logical idempotency identity and body binding; forwarding cannot allocate two graph operations. Cancellation of a purely local queued intent is a durable local terminal outcome, distinct from a witnessed cancellation of an already admitted operation.

Owner correction capability must reflect the ability to record a valid local intent, separately from immediate shared-commit readiness. Followers and an unavailable custody host must not force all correction controls off merely because global allocation is temporarily unavailable. The implementation now separates actual local intake from canonical readiness; a configuration switch alone is not proof that local sealing/intake can open.

## Default boot and identity

- External configuration is optional. On normal first use, compose the existing custody engine on a designated enrolled machine with role keys in the existing SecretStore. No extra public port, third-party account or paid service is needed.
- Standalone installation must compose the actual one-member native lease, WriteAdmission, registry and journal classes even when multi-machine configuration is absent. Do not replace them with a test-only holdsLease=true callback. Ordinary process restart must rebuild from the real durable local stores.
- Bootstrap one established genesis/profile from existing authenticated owner/pairing authority and the real installed roster. Every paired node independently minting a genesis for the same agent is forbidden. The exact owner-key/bootstrap publication seam needs implementation review before coding.
- Bind an exact owner-signed custody deployment profile to agent, host, role key and failure domain. Membership/proof schema evolution is explicit and strict. A client-provided local/external boolean grants no authority. Historic external certificates cannot be relabeled.
- Use a common verified custody port. An in-process adapter calls the same real service and verification logic; an owned remote host uses the existing registered signed-peer transport and credential guard. Do not turn on the test-only loopback exception in production. External HTTPS is another optional transport behind the same verifiers.

## Host sleep, writer movement and restore

The custody host and native writer are separate roles. The writer may move under the existing actual native fencing while the same owned host retains custody. If that host sleeps, retain verified reads and record local intents without pretending the missing prefix is known.

Do not elect a blank replacement custody database from a native lease or a key pin alone. Owned-host replacement reuses authenticated owner activation, the exact complete source manifest, required staged/fsynced transfer, monotonic fence and archived activation chain. No paid host is needed. Unknown pending source stays explicitly unresolved rather than being certified away.

A blank or restored database is not proof that no erasures existed. Reconcile the real activated profile, closed prefix, terminal certificates and erasure ledger before serving restored historical private bytes. Retained live-process state and an unverifiable old backup are different cases. Priority local hiding remains immediate; remote purge and unknown historical backups remain separately named debt. No change authorizes backup deletion, exclusions or a false fleet-complete claim.

### Retained offline memory and restore limits

A fresh reachable enrolled peer reporting a newer activated membership or an unknown erasure set is negative evidence: durably withhold historical private serving until the local copy reconciles it. A signed peer observation does not install a membership, elect a role, clear an owner conflict or authorize new global allocation. Known negative observations do not expire merely because the peer sleeps.

When no current authority is reachable, a genuine retained physical all-member-acknowledged snapshot may remain readable with sync unavailable; this is retained memory, not a claim of fresh global agreement. It must not authorize new canonical writes. Actual source/certificate/profile and local erasure checks still apply, and unshared changes remain local intents.

There is an explicit limit: restoring **all** local authority state and keys while no current authority is reachable is indistinguishable from a genuine latest surviving offline copy using software-only local evidence. This implementation cannot truthfully promise both fresh global backup validation and unrestricted offline survivor access in that condition. Preserve the acknowledged offline-memory guarantee, label its scope, retain known negative fences, and do not claim unknown historical backup erasure complete. No hardware, keychain policy or outside purchase is silently required to hide this limit.

## UI and wire work

Preserve the last agreed shared projection. Render a separate local placement overlay marked Pending for the recording owner; this is not a canonical edit. Restore it from the exact durable queued intent after app quit/reload, not only in-memory banners. Pending paging and cancellation eligibility must cover recorded-local as well as independently copied requests. Status404 remains unknown, never permission to resend or discard an unresolved ID.

Keep current NodeRef objects, exact flat-row source id and machine, owner/device authorization, front-door field semantics, typed conflicts and original-history navigation. Add precisely versioned queued/custody-scope outcomes and capability/readiness fields; update native and dashboard together. Existing provisional native choices that discard unresolved IDs on quit or omit the local overlay are not accepted as final v3 behavior.

## Implementation and proof checklist

- Custody owner: common verified transport and signed deployment profile; default owned-host lifecycle and explicit scope of prepare proofs.
- Source/runtime owner: existing Intake pre-admission state, sequence-free durable capture, authorization revalidation and exact promotion; preserve all-state bounds, priority erasure and existing frozen retries.
- Coordinator: standalone and multi-machine boot, real owner bootstrap, default-off release gates until proofs pass; reads/capabilities/status and truthful UI semantics.
- Native/dashboard owners: persistent request continuity, Pending overlays, named waits/cancel/Undo/conflicts, Create/Name/front-door/Forget controls. No build bump or shipment from mock UI alone.

Required proofs: zero-external-config standalone create/read/move/name/erase/restart; two owned peers committing; sleeping peer local queue/overlay then exact replay; unavailable owned custody host; real native writer movement; authenticated owned-host replacement; old-backup erasure quarantine; revoked/stale queued-intent refusal; competing genesis rejection; no paid-service dependency in native or dashboard; performance and all existing privacy/fencing/certificate tests.

Focused new-default checkpoints include actual standalone boot/reopen, enrolled peer bootstrap, follower-only owner changes, outage-local recording/promotion, real native writer movement and signed phone create/name/move/undo/name removal against synthetic owned-machine fixtures. The dashboard/native sample tests are separate from real paired client/server proof. Signed-mesh handover and retained live-copy erasure have their own ongoing independent acceptance; component passes do not complete that integrated checklist. The unchanged strict 4,000-row ceremony subsequently passed in 54 minutes 2 seconds, including complete recovery after removal of the added Source copy. Its earlier failure remains on record. That run used the older loaded Source/rank/types snapshot; later changes to peer-frontier, immediate local erasure and retained-read authority are not covered by that scale result. An eight-row smoke test or a large transport fixture is not a replacement for the original complete ceremony. No release concurrence, purchase, deployment or feature activation is implied by this document.
