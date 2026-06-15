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
  const pullerSrc = fs.readFileSync(path.join(__dirname, '../../src/core/PeerPresencePuller.ts'), 'utf-8');

  it('fetchPeerCapacity passes the commitments advert AND peer quotaState THROUGH to the puller (the dropped-advert bug #931 + A2)', () => {
    const idx = src.indexOf('fetchPeerCapacity: async (machineId, url)');
    expect(idx).toBeGreaterThan(0);
    // The narrowing return is now the SHARED `narrowSessionStatusToPeerCapacity`
    // helper (STATESYNC-PEER-ADVERT-PROPAGATION-FIX extracted it so production +
    // the round-trip test run ONE mapping); server.ts delegates to it.
    const block = src.slice(idx, idx + 1800);
    expect(block).toContain('narrowSessionStatusToPeerCapacity(res.result, journalAdvert)');
    // The advert pass-throughs now live (and are unit-tested) in the helper. The
    // dropped-advert bugs (#931 commitments + A2 quotaState) must still survive.
    expect(pullerSrc).toContain('commitmentsAdvert?: { incarnation: string; replicationSeq: number }');
    expect(pullerSrc).toContain('cap.commitmentsAdvert !== undefined ? { commitmentsAdvert: cap.commitmentsAdvert }');
    expect(pullerSrc).toContain('quotaState?: { blocked: boolean; blockedUntil?: string; reason?: string }');
    expect(pullerSrc).toContain('cap.quotaState !== undefined ? { quotaState: cap.quotaState }');
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
