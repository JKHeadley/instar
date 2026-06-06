/**
 * Wiring-shape test (WORKING-SET-HANDOFF-SPEC §3.3, issues #926 + #930):
 * the server's wsOwnerOf seam must carry BOTH quiet-topic fallbacks —
 * the local pin AND the journal-placement evidence (the pin store is
 * router-local, so the pinned-TO machine needs the journal step).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('wsOwnerOf quiet-topic fallbacks (#926 + #930)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf-8');

  it('fetchPeerCapacity passes the commitments advert AND peer quotaState THROUGH to the puller (the dropped-advert bug #931 + A2)', () => {
    const idx = src.indexOf('fetchPeerCapacity: async (machineId, url)');
    expect(idx).toBeGreaterThan(0);
    // Window widened for the A2 quotaState pass-through (+ its rationale comment).
    const block = src.slice(idx, idx + 2400);
    expect(block).toContain('commitmentsAdvert?: { incarnation: string; replicationSeq: number }');
    expect(block).toContain('cap.commitmentsAdvert ? { commitmentsAdvert: cap.commitmentsAdvert }');
    // A2 (live, v1.3.384): the peer's quotaState must also pass through, or the
    // router never sees a peer's quota and placement can't avoid a blocked peer.
    expect(block).toContain('quotaState?: { blocked: boolean; blockedUntil?: string; reason?: string }');
    expect(block).toContain('cap.quotaState ? { quotaState: cap.quotaState }');
  });

  it('falls back to the LOCAL pin, then the topic-placement journal entry', () => {
    const idx = src.indexOf('const wsOwnerOf = (topic: number)');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 3000);
    // #926: the local pin step.
    expect(block).toContain("pin?.pinned && pin.preferredMachine === wsSelf");
    // #930: the journal-placement step (router-local pin blindness).
    expect(block).toContain("kind: 'topic-placement', topic, limit: 1");
    expect(block).toContain('pd?.owner === wsSelf');
    // The honest default when no evidence exists.
    expect(block).toContain('return { owner: null, epoch: null }');
  });
});
