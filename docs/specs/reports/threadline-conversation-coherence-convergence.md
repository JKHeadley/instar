# Convergence Report — Threadline Conversation Coherence (P3)

Spec: `docs/specs/THREADLINE-CONVERSATION-COHERENCE-SPEC.md`
Converged: 2026-06-06 (2 rounds)
Reviewers: 3 internal lenses (integration, adversarial+security, lessons-aware) + cross-model `codex-cli:gpt-5.5`.

## Round summary

| Round | Material findings | Outcome |
|-------|-------------------|---------|
| 1 | ~13 (4 codex + 6 integration + 3 adversarial + 4 lessons) | All folded |
| 2 | Combined verify, all fixes grounded against live source | **CONVERGED** |

## Headline catches (caught on paper)

- **Relay-reality (adversarial, grounded in RelayServer.ts/OfflineQueue.ts):**
  the draft promised "the peer's relay redelivers" to an offline holder —
  FALSE. The central relay holds inbound in an IN-MEMORY queue, 24h TTL,
  bounded, dropped on expiry/restart. The honest answer template now
  carries the replica's recvTs staleness AND the real delivery bound;
  a stronger promise requires the durable RedisOfflineQueue by name.
- **Emission chokepoints don't exist (integration):** ConversationStore
  has no create/bind/close methods — the funnel is commit(); emission is
  a prev/next transition-diff on state+boundTopicId only, with a NEW seam
  interface. "Purely additive" re-sized honestly: a compiler-guided
  multi-site edit including the JournalSyncApplier.validateData branch
  (without which replication suspect-flags the sender).
- **Social-graph disclosure (security):** aggregating counterparty
  fingerprints onto every machine is a NEW disclosure class about
  non-operator third parties — reasoned and accepted explicitly, not
  hand-waved as "envelope metadata".
- **The P1.5 beacon deferral stays OPEN (lessons):** P3 contributes the
  uniform visibility-vs-actuation decision and names P1.5's merged view
  (originMachineId per row) as the beacon-holder observable — it does NOT
  claim closure. Composite (holderMachineId, conversationId) fold keys
  (the P1.5 identity lesson, applied at design time). Bounded mesh read:
  own rows from the LIVE store, replica fold under P1 reader ceilings.
  All three Agent Awareness surfaces incl. shadow markers. 200-not-503
  e2e first.

## Approval

Standing directive (Justin, topic 13481, 2026-06-06 ~03:05 PDT) — per-step
convergence, build, all-tier testing, live verify. ELI16 sent to 13481.
