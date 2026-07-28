# Side-Effects Review — WS2.6 user-registry + topic-operator replicated stores (the last two memory-family PII kinds, dark)

**Version / slug:** `multi-machine-replicated-store-ws26-user-topicop`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `5-lens adversarial review (untrusted-replicated-operator / recordKey-identity / disclosure-min-PII-leak / tombstone-erasure / dark-ship-inertness) — verdict + named tests appended below`
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions

## Summary of the change

WS2.6 adds the final two PII kinds to the WS2 memory family on the proven HLC
replicated-store foundation: `user-record` (the multi-user registry the `UserManager`
resolves an inbound message to) and `topic-operator-record` (which VERIFIED operator a
topic was bound to). Both are thin instantiations of the shipped WS2.3 relationships PII
template: discriminated-union-on-`op` schema (value + tombstone), strict type-clamp on
receive, disclosure-minimized projection, content/identity-surface `recordKey`, 64KB
per-entry cap with a named over-cap error, op:delete tombstone for offline-peer erasure,
HIGH-impact-at-replication / advisory-at-read. With these landed, the WS2 memory family
is COMPLETE (7 kinds: preferences, relationships, learnings, knowledge, evolution-actions,
user-registry, topic-operator; playbook deferred CMT-1416).

Both ship **DARK** behind `multiMachine.stateSync.userRegistry` and
`.topicOperator` (`enabled:false`, `dryRun:true` — the graduated dark→dryRun→live ladder).
Flag-off / single-machine = strict no-op; NO PII ever crosses a machine boundary while dark.

## Decision-point inventory (the decided forks, baked in verbatim)

- **user-record recordKey** = `sha256(sorted channel-set "type:identifier" pairs)` — a user IS
  their channel identifiers (same model as relationships, mirroring `UserManager.channelIndex`).
  NEVER the local `userId` (the cross-machine-unstable id).
- **topic-operator recordKey** = `sha256(topicId + ":" + verified-uid)`. NEVER a content-name
  (Know-Your-Principal: the binding is auth-sender-derived).
- **Impact tier**: BOTH HIGH@replication (append-both-and-flag on concurrent divergence) /
  advisory@read (a replicated PII record is a hint, never the authoritative answer).
- **disclosure-min**: user-record strips the local `userId`; topic-operator projects exactly
  `{platform, uid, names, boundAt}` (no internal `boundFrom`).
- **THE LOAD-BEARING INVARIANT (topic-operator)**: a replicated topic-operator record is
  UNTRUSTED peer data — NEVER this machine's authoritative answer to "who is my verified
  operator?". Only the LOCAL authenticated `TopicOperatorStore.setOperator` binds the principal.
  The store exposes NO apply/set/establish path back into `TopicOperatorStore` by construction.

## 1. Over-block
None. Both kinds ADD reach (replicated PII as advisory context) and never block a message, a
route, or a session. Flag-off / single-machine = strict no-op (named E2E + unit tests).

## 2. Under-block (the real risk surface)
The inverse risk: replicated PII is materialized into a union read. Mitigations: (a) strict
type-clamp on receive (ISO-8601 dates, finite numbers, jailed slugs) makes markup
un-smuggleable through a render slot; (b) every foreign record renders inside a
`<replicated-untrusted-data origin="…">` envelope; (c) the topic-operator foreign render
EXPLICITLY states the record is NOT the verified operator and cannot establish/override one;
(d) identity RESOLUTION of an inbound principal stays LOCAL-ONLY for user-record (the local
channel index always wins); (e) the topic-operator store has no apply path, so a replicated
record can never reach `getOperator()` authority. Accepted residual: a compromised
same-operator peer could inject advisory context text, but it cannot escalate to principal
authority and the blast radius is one operator's own pool — recorded as a known bound.

## 3. Level-of-abstraction fit
The two `*ReplicatedStore.ts` modules are PURE logic (no fs, no Date, no network) — schema +
projection + recordKey + merge + render, unit-testable in isolation. The wiring sits in
server.ts (kind registration + union reader) and the manager seams (`UserManager.persistUsers`/
`removeUser`, `TopicOperatorStore.setOperator`) exactly where the WS2.2–2.5 siblings sit. No
new transport, no new auth, no new tick.

## 4. Signal vs authority compliance
Fully signal-only. Neither kind gates or rewrites anything. The user-registry merged read is a
HINT (inbound resolution stays local-authoritative); the topic-operator merged read is advisory
context (the principal stays local-authoritative). The mesh path is the existing read/observe
replicated-store substrate — adds reach, never authority; the receiver type-clamps + envelopes.

## 5. Interactions
- Rides the existing `ReplicatedKindRegistry` + dual-registry (`JOURNAL_KINDS`) + union reader +
  conflict/rollback substrate (no new machinery).
- Two new `enabled:false` ConfigDefaults paths shift the dark-gate EXPECTED line-map by +29;
  hand-edited (regeneration forbidden) + two new attributed entries added.
- Coexists with the WS2.1–2.5 siblings (same `multiMachine.stateSync.*` block, independent flags).
- The maintainer's WS5.2 credential-repointing track was NOT touched (separate lane).

## 6. External surfaces
No new HTTP routes. The kinds register onto the shared registry and ride the existing
`/state/*` conflict/quarantine routes (already alive). Emission/serve/pull stay dark behind the
two new flags. The journal-backed emitter is wired at the manager seams but only attached when
the flag is on (a later rollout stage, mirroring the siblings).

## 7. Multi-machine posture (Cross-Machine Coherence) + Phase C
- **Per-machine emission; N-machine pool = N independent emitters.** Identity keyed on the
  channel-set (user) / topic+uid (operator), NOT a per-machine id — so the SAME user/operator
  across N machines is ONE record, never N duplicates.
- **The topic-operator untrusted-replicated invariant scales:** on N machines only the LOCAL
  authenticated binding is authoritative for the principal; replicated records from N-1 peers
  are advisory. A re-bind to a NEW operator (different uid) is a DIFFERENT record (different
  key), so a replica can never overwrite the local binding.
- **No LAN/broadcast assumption.** Rides the existing per-peer replicated-store substrate.
- **Offline-peer erasure:** a removed user / unbound operator propagates an op:delete tombstone
  keyed on the SAME identity surface, so an erased record stays erased on a peer that was offline
  at delete time.

## Migration parity
- ConfigDefaults: two new dark blocks (no migrateConfig needed — an absent per-store key resolves
  to dark, the safe default; identical to the WS2.2–2.5 siblings).
- CLAUDE.md template (`templates.ts`) + a chained migrator else-if in `PostUpdateMigrator` splice
  the two new One Memory bullets — ESPECIALLY the topic-operator UNTRUSTED-REPLICATED-OPERATOR
  invariant — into already-deployed agents before any operator enables the replication. Idempotent
  (guarded by the unique 'User registry is the SECOND PII store' marker), with a focused test.
- devGatedFeatures: two new DARK_GATE_EXCLUSIONS entries (optional-integration).
- Docs: two new `under-the-hood.md` class blocks (≥2 mentions each — docs-coverage passes).

## 5-lens adversarial verdict (folded as named tests)
1. **Untrusted-replicated-operator (THE blocker)** — `untrusted-replicated-operator-never-authoritative`:
   the foreign render ALWAYS says NOT the verified operator; the module exposes NO apply/set/establish
   export; the wiring test proves `getOperator()` authority is UNCHANGED by a replicated record. PASS.
2. **recordKey identity** — `recordKey-identity-collapses-cross-machine`: same channel-set/topic+uid →
   one key regardless of local id; a different uid is a different record. PASS.
3. **disclosure-min / PII leak** — `disclosure-min-strips-local-id` (userId never on wire),
   topic-operator projection exactly `{platform,uid,names,boundAt}`, `64KB-named-error`, `type-clamp`
   (markup injection blocked, path-shaped slug jailed). PASS.
4. **tombstone erasure** — `op:delete-tombstone-erasure`: tombstone keyed on the SAME identity surface;
   schema op:delete branch accepts it. PASS.
5. **dark-ship inertness** — `dark-ship-strict-noop`: no emitter ⇒ manager behaves byte-identically;
   E2E DISABLED → 503. PASS.

No residual blockers. Known accepted bound: a compromised same-operator peer can inject advisory
context (cannot escalate to authority; one-operator blast radius).
