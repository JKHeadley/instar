---
title: "Threadline local-delivery fingerprint attribution — stop the anti-hijack guard isolating legitimate replies"
slug: threadline-local-delivery-fingerprint-attribution
eli16-overview: threadline-local-delivery-fingerprint-attribution.eli16.md
status: draft
supervision: tier0
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
approved: true
approval-context: "Approved by Justin 2026-06-09 (topic 23178, 'Approved please proceed') after reading the convergence report (view e1d7158b). 2-round convergence sharpened the design (shared resolver fixing the publicKey-only no-op; narrow hint avoiding relayContext side effects); operator approved the converged result explicitly."
lessons-engaged:
  - "Recurrence of bug_threadline_name_based_attribution_drops_fingerprint (CMT-1164). #479 + #1032 closed the OUTBOUND identity-divergence; this closes the INBOUND/local-transport half: a same-machine reply is attributed by NAME while the thread it answers is owned by a FINGERPRINT, so the anti-hijack guard isolates a legitimate reply."
  - "L7/B12 Bug-fix evidence bar — grounded against a LIVE incident (server log: `[ThreadlineRouter] Anti-hijack: unverified sender sagemind presented threadId 199c20fe owned by 1db85f; isolating to fresh thread`). NOTE: this spec is the design; the fix is verified-as-stopping-the-isolation by the E2E regression test (which must red on current main), not yet claimed as already-verified."
  - "Convergence round 1 caught a BLOCKING self-bug: the live known-agents.json records sagemind with NO `fingerprint` field, only `publicKey` — so the owner was recorded as `publicKey[:32]` = `1db85f`. A resolver reading only `entry.fingerprint` returns null → the fix would no-op on the exact incident. v2 funnels record + compare through ONE shared resolver using the SAME derivation chain (`fingerprint || publicKey[:32]`)."
  - "P2 Signal vs Authority — this does NOT pass a full relayContext (which would change grounding-preamble injection, history depth, and the persisted participants record — convergence B2/M1). It plumbs only a resolved-fingerprint hint to the anti-hijack comparison. The guard's block/allow logic and every other consumer are untouched; an unresolved sender still isolates (fail-safe)."
review-convergence: "2026-06-10T01:49:11.952Z"
review-iterations: 2
review-completed-at: "2026-06-10T01:49:11.952Z"
review-report: "docs/specs/reports/threadline-local-delivery-fingerprint-attribution-convergence.md"
cross-model-review: "skipped (abbreviated)"
cross-model-review-reason: "Internal-only convergence per skill allowance: 5 internal perspectives across 5 subagent passes over 2 rounds (security, scalability, adversarial, integration, lessons-aware). Lessons-aware ran in the round-2 integration+lessons+security pass and returned CONVERGED. Externals skipped to manage cost on a focused single-file ingress fix."
---

# Threadline local-delivery fingerprint attribution

## Problem (observed live 2026-06-09, topic 23178)

Echo pinged the co-located Luna/SageMind agent over Threadline (thread `199c20fe`). Luna **received it
and replied** — but her reply never surfaced back. The server log:

```
[ThreadlineRouter] Anti-hijack: unverified sender sagemind presented threadId 199c20fe
owned by 1db85f; isolating to fresh thread c127d293
```

The anti-hijack guard (`ThreadlineRouter.handleInboundMessage`, `src/threadline/ThreadlineRouter.ts`
~L535-555) defends against an unverified peer presenting a threadId owned by a *different* participant.
It false-positives on Luna's legitimate reply because the two sides of the comparison are different
**kinds of identifier for the same agent**:

- **The thread owner** (`presented.remoteAgent`) was recorded by echo's *outbound* path
  (`captureOrigin`, `src/server/routes.ts` ~L17571-17575) as
  `localTarget.fingerprint || localTarget.publicKey?.substring(0,32) || localTarget.name`. In the live
  `known-agents.json`, sagemind has **no `fingerprint` field** — only a `publicKey` — so the owner was
  recorded as `publicKey[:32]` = `1db85f`.
- **The inbound reply's identity** is the **name** `sagemind`. On the LOCAL same-machine path
  (`POST /messages/relay-agent`), the sender stamps `from: { agent: <projectName> }` (a name), and the
  route calls `threadlineRouter.handleInboundMessage(envelope)` **with no identity context**, so the
  guard's `inboundFp = relayContext?.senderFingerprint || message.from.agent` falls back to the name.

`identityMatches = (peer === inboundFp || peer === inboundName)` → `'1db85f' === 'sagemind'` → false →
isolate. The cross-machine **relay** path does NOT hit this: it presents the peer's fingerprint, so
`peer === inboundFp` matches. **The bug is transport-asymmetric attribution: relay carries the
fingerprint, local carries the name, and the anti-hijack compares against the fingerprint-derived
owner.** (CMT-1164, with the concrete second symptom of actively isolating legitimate replies.)

## Goal

On the local same-machine path, give the anti-hijack guard the SAME fingerprint the thread owner was
recorded with, derived by the SAME chain — so a legitimate reply matches its thread and a
genuinely-unknown sender still isolates. Minimal blast radius: change ONLY the identity the guard
compares; do not alter grounding, history depth, persisted records, or any other consumer.

**Constitutional anchor — Cross-Machine Coherence.** The standard governs how "cross-machine paths
resolve peers by their advertised identity," and demands robustness on the not-happy-path. This is the
**co-located (same-machine) degenerate case** of that same peer-identity-coherence requirement: the
local transport is the relay's intra-machine sibling, and letting the two transports diverge so a guard
treats a legitimate reply as a hijack is the "remains ONE coherent agent" break the standard forbids,
just intra-machine. (Acknowledged: the canonical article is framed for multiple machines; this is the
honest nearest-fit — the coherence-of-a-peer's-identity-across-transports argument lives under it.)

## Design — one shared resolver; plumb a fingerprint HINT to the guard only

### A. Shared peer-fingerprint resolver (the consistency keystone)

Add one shared helper used by BOTH the owner-record path and the inbound-compare path, so record and
compare can NEVER diverge (the root of the convergence-blocking self-bug):

```
resolvePeerFingerprint(entry): string | null      // entry.fingerprint || entry.publicKey?.substring(0,32) || null
resolvePeerFingerprintByName(stateDir, name): string | null
```

`resolvePeerFingerprintByName` reads `{stateDir}/threadline/known-agents.json`, finds entries whose
`name` matches (case-insensitive), and returns `resolvePeerFingerprint(entry)` for the unique match.
**Returns `null` when: the name is absent, the entry has neither `fingerprint` nor `publicKey`, OR more
than one entry matches with DIFFERENT derived fingerprints** (collision → never guess; cf. #1032).
Robust against a missing/oversized/malformed file (fail to `null`, never throw on the hot path).

Refactor the outbound owner-record derivation (`captureOrigin` / `recordSent`, routes.ts ~L17571-17575)
to use `resolvePeerFingerprint(entry)` (keeping the existing `|| name` final fallback AT the record
site). Now the owner is recorded, and the inbound is resolved, through the identical derivation.

Scope (convergence round 2): the shared resolver replaces ONLY the Threadline-attribution `[:32]`
sites (routes.ts ~L17394/17408/17440/17573/17581, ThreadlineMCPServer ~L508/853). It must NOT touch the
divergent `routes.ts:13851` chain (`fingerprint || publicKey || 'unresolved'` — FULL key, different
consumer/semantics). Also note: the owner record is only written when the outbound send carried a
resolvable origin topic (`captureOrigin` early-returns `if (!resolvedOriginTopicId)`), so the anti-hijack
only fires for topic-bound threads with a recorded owner — exactly the incident case; the fix is a
correct no-op for ownerless threads.

### B. Plumb a resolved-fingerprint HINT into the anti-hijack — NOT a full relayContext

In the local `/messages/relay-agent` route, resolve `envelope.message.from.agent` via
`resolvePeerFingerprintByName(...)`. Pass the result to `handleInboundMessage` through a NEW narrow
optional parameter, e.g. `handleInboundMessage(envelope, relayContext?, opts?: { inboundSenderFingerprint?: string })`.
The anti-hijack comparison becomes:

```
const inboundFp = relayContext?.senderFingerprint || opts?.inboundSenderFingerprint || message.from.agent || '';
```

**Why a narrow hint, not a relayContext (convergence B2/M1):** passing a full `RelayMessageContext`
where today it is `undefined` would (1) add the relay grounding-preamble to the spawned session prompt
(`buildPrompt` wraps only when relayContext is present), (2) change injected history depth from
`config.maxHistoryMessages` (20) to `RELAY_HISTORY_LIMITS[trustLevel]` (5), and (3) write the
fingerprint instead of the name into the persisted `participants.peers`. None of those are part of this
bug. The narrow `inboundSenderFingerprint` hint touches ONLY the anti-hijack comparison — zero side
effects on grounding, history, affinity (still `verified`-gated and untouched), or persisted records.

### C. Fail-safe + trust decision (committed up front)

- **Resolution succeeds → use the fingerprint.** The guard compares fingerprint-to-fingerprint and a
  legitimate reply resumes its thread.
- **Resolution returns `null` → pass no hint** → the guard falls back to `message.from.agent` (the
  name) exactly as today → a fingerprint-owned thread still isolates (fail-safe), a name-owned thread
  (name-only peer) still matches name-to-name (internally consistent because the owner-record's final
  fallback is also the name).
- **Trust posture (DECISION, per convergence M4):** local delivery is name-asserted and gated ONLY by
  the receiver's relay-agent token (`verifyAgentToken`) — the token is the real authorization boundary
  and is unchanged. Resolving name→fingerprint means the guard trusts the local `known-agents.json`
  mapping for a token-holder. We ACCEPT this: (1) the token already authorizes local delivery; (2)
  pre-fix the guard already operated on the self-asserted name and merely always-isolated, providing no
  real protection locally; (3) the cross-machine attacker path stays transport-verified. The residual
  risk — a process running as the same OS user that already holds the receiver's token could stamp a
  known peer's name and resume that peer's thread — is bounded by token custody, NOT by this guard.
  Tightening *who may call* `/messages/relay-agent` (e.g. a sender-token check) is the correct place for
  that hardening and is out of scope here. <!-- tracked: topic-23178 -->

## Security considerations

- **The guard was never a real local boundary.** Before this fix it isolated EVERY fingerprint-owned
  thread on local delivery (legitimate or not) — a correctness bug, not protection. The token gate is
  and remains the authorization boundary. This change removes the false-isolation; it does not weaken a
  load-bearing control. (Convergence security #2.)
- **No `verified` exemption is involved.** Both the relay and local paths present `plaintext-tofu` to
  the guard (the relay's Ed25519 check is at the transport, not the guard); no production path passes
  `trust.kind:'verified'`. We add no trust; we hand the existing comparison a consistent identifier.
- **`known-agents.json` is a TOFU mapping** (populated by unauthenticated local discovery). The
  resolved fingerprint is therefore TOFU, consistent with the guard's `plaintext-tofu` posture. The
  resolver only reads + array-matches the name (no path construction → no traversal) and fails to `null`
  on any parse error.
- **No durable trust-record poisoning.** The hint is process-local; it is not written to a trust DB.
  (The owner record continues to store what it stored before, now via the shared derivation.)

## Non-goals

- No change to the cross-machine relay path (already presents the fingerprint).
- No change to the anti-hijack guard's block/allow LOGIC — only the identifier it compares.
- No full `relayContext` on the local path (explicitly rejected — see §B).
- Not fixing the warrants-reply gate's `senderFingerprint: senderAgentName` / `trustLevel:'verified'`
  (routes.ts ~L16503-16505): pre-existing, not this bug, and changing it risks the persisted
  participants record. Out of scope. <!-- tracked: topic-23178 -->
- Not canonicalizing the first-contact / isolation-branch owner record (still stores the name): out of
  scope; the shared resolver keeps it consistent for name-only peers. <!-- tracked: topic-23178 -->

## Testing (all three tiers, on the real path — Testing Integrity Standard)

- **Unit (`tests/unit/threadline/`)** — (a) `resolvePeerFingerprint`: `fingerprint`-only → fingerprint;
  `publicKey`-only → `publicKey[:32]` (the LIVE sagemind shape — the case that no-ops without this);
  neither → null; two same-name entries with different derived fps → null. (b)
  `ThreadlineRouter.handleInboundMessage` with the new `inboundSenderFingerprint` hint: thread owned by
  `FP`, inbound `from.agent = <name>` + hint `FP` → RESUMED (not isolated); hint absent / mismatched →
  isolated (fail-safe). Assert NO relayContext side effects (history depth, grounding) when only the
  hint is passed.
- **Integration (`tests/integration/threadline/`)** — NOTE (convergence round 2): the existing
  `relay-send-local-roundtrip` test uses a STUB local target (it only captures envelopes; it never
  exercises the real `handleInboundMessage`/`threadResumeMap` anti-hijack guard, and its fixture sets
  BOTH `fingerprint` and `publicKey`). The integration test here must instead drive the REAL
  `/messages/relay-agent` route on a server with a live `ThreadlineRouter`, with a thread **pre-seeded
  in `threadResumeMap` owned by `publicKey[:32]`** and a `publicKey`-only `known-agents.json` fixture;
  assert the inbound resumes that thread (not isolated), and that an unknown-name inbound still isolates.
  (It may reuse the roundtrip harness's server/fixture scaffolding, but must hit the real guard, not the
  stub.)
- **E2E (`tests/e2e/threadline/`)** — BIDIRECTIONAL (convergence MATERIAL-1): two co-located agents A
  and B with fleet-shaped known-agents fixtures (one `publicKey`-only, one `fingerprint`-only). A opens
  a thread to B; B replies → lands on the SAME thread. B opens a thread to A; A replies → same thread.
  Assert the absence of the `Anti-hijack … isolating` outcome. **This test must RED on current main**
  (reproducing `199c20fe`) and green after — the regression guard.

## Deployment, migration, rollback

- **Single deployable** (agent package, auto-update). No relay deploy. No persistent-state migration
  (resolution is computed per-message from the existing `known-agents.json`). Reaches the fleet on the
  next server restart after the update activates.
- **Second `handleInboundMessage` ingress — resolved (convergence round 2):** the other call site is
  `src/threadline/ThreadlineEndpoints.ts:429` (`POST /threadline/messages/receive`). Code-grounded
  verdict: it is gated by `threadlineAuth` (Ed25519 signature verification, `:347-359`) and its only
  senders are the cross-machine relay (`MessageRouter`) and `AgentBus.httpSend` (`:415` comment) — i.e.
  the **authenticated cross-machine path**, where `from.agent` is the relay-supplied fingerprint, not a
  co-located self-asserted name. The name-vs-fingerprint defect does NOT arise there, so the primary
  fix (the name-hint) is targeted at `/messages/relay-agent` only. **Build requirement:** verify at
  implementation time that `from.agent` on this path is in fact a fingerprint; in the event a NAME can
  ever reach it, the correct identity source is the **authenticated** `X-Threadline-Agent` header
  (already validated by `threadlineAuth`), NOT a TOFU `known-agents.json` lookup — do not wire the
  TOFU name-hint into an authenticated ingress.
- **Rollback:** revert the PR; the route stops passing the hint (name-based behavior returns). Pure code
  change, no data migration.
- **Agent Awareness:** no CLAUDE.md template change — transparent correctness fix.
- **Supervision tier0:** deterministic identity resolution; no LLM/policy judgment.

## PR structure

Single PR (one coherent ingress fix + the shared resolver; one side-effects artifact). Tier 2 (touches
A2A routing + the anti-hijack security surface).
