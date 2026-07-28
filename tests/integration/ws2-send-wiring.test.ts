/**
 * Wiring-integrity ratchet — every registered WS2 replicated kind must be CONSCIOUSLY
 * classified as SEND-wired or SEND-pending (WS2-SEND-SIDE-EMISSION-SPEC §7).
 *
 * THE GAP THIS GUARDS: WS2 shipped 7 kinds receive-capable (registry + advert + apply)
 * with the SEND half a silent no-op. This test registers the SAME 7 kinds the server
 * registers and asserts the send-wiring manifest accounts for every one of them — so a
 * FUTURE kind added to the registry with neither a wired emitter nor an explicit
 * pending entry fails CI (it cannot be silently added receive-only again).
 */
import { describe, it, expect } from 'vitest';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { PREF_KIND_REGISTRATION } from '../../src/core/PreferencesReplicatedStore.js';
import { RELATIONSHIP_KIND_REGISTRATION } from '../../src/core/RelationshipsReplicatedStore.js';
import { LEARNING_KIND_REGISTRATION } from '../../src/core/LearningsReplicatedStore.js';
import { KNOWLEDGE_KIND_REGISTRATION } from '../../src/core/KnowledgeReplicatedStore.js';
import { EVOLUTION_ACTION_KIND_REGISTRATION } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { USER_KIND_REGISTRATION } from '../../src/core/UserRegistryReplicatedStore.js';
import { TOPIC_OPERATOR_KIND_REGISTRATION } from '../../src/core/TopicOperatorReplicatedStore.js';
import {
  auditWs2SendWiring,
  WS2_SEND_WIRED_STORES,
  WS2_SEND_PENDING_STORES,
} from '../../src/core/ws2SendWiring.js';

/** Register the SAME 7 concrete kinds the server registers (server.ts boot order). */
function serverRegistry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(PREF_KIND_REGISTRATION);
  r.register(RELATIONSHIP_KIND_REGISTRATION);
  r.register(LEARNING_KIND_REGISTRATION);
  r.register(KNOWLEDGE_KIND_REGISTRATION);
  r.register(EVOLUTION_ACTION_KIND_REGISTRATION);
  r.register(USER_KIND_REGISTRATION);
  r.register(TOPIC_OPERATOR_KIND_REGISTRATION);
  return r;
}

describe('WS2 send-side wiring-integrity ratchet', () => {
  it('every registered replicated store is classified (no silent receive-only kind)', () => {
    const audit = auditWs2SendWiring(serverRegistry().stores());
    expect(audit.unclassified).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('learnings is SEND-WIRED (the shipped slice)', () => {
    expect(WS2_SEND_WIRED_STORES).toContain('learnings');
    const audit = auditWs2SendWiring(serverRegistry().stores());
    expect(audit.wired).toContain('learnings');
  });

  it('the WIRED and PENDING sets are disjoint (a store is in exactly one)', () => {
    const overlap = WS2_SEND_WIRED_STORES.filter((s) => WS2_SEND_PENDING_STORES.includes(s));
    expect(overlap).toEqual([]);
  });

  it('WIRED ∪ PENDING covers exactly the registered stores (no stale manifest entry)', () => {
    const registered = new Set(serverRegistry().stores());
    const manifest = new Set([...WS2_SEND_WIRED_STORES, ...WS2_SEND_PENDING_STORES]);
    // Every manifest entry is a real registered store (no typo / stale entry).
    for (const s of manifest) expect(registered.has(s)).toBe(true);
    // Every registered store is in the manifest (the ratchet's core invariant).
    for (const s of registered) expect(manifest.has(s)).toBe(true);
  });
});
