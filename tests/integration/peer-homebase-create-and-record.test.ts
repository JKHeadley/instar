/**
 * Integration tier for the per-peer homebase: `ensurePeerHomebase` against a REAL
 * `AgentTrustManager` (real file-backed store, real persistence), with the topic primitive
 * faked at the Telegram boundary.
 *
 * The unit tests cover the decisions with injected deps; this covers the thing those cannot —
 * that the recorded id actually survives in the real store, that a second pass is a genuine
 * no-op rather than a second topic, and that the gate and the lease check stop it before any
 * external call is attempted.
 *
 * Honest scope: this is NOT the full HTTP pipeline. Driving `POST
 * /threadline/pairing/:peerFp/verify` requires reproducing the pairing handshake (real SAS
 * derivation from two in-process identities), which the existing
 * `tests/e2e/threadline-verified-pairing-alive.test.ts` harness does. That tier is still
 * missing for this feature and is recorded as such in the side-effects artifact rather than
 * implied by this file's name.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { ensurePeerHomebase } from '../../src/threadline/peerHomebase.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PREFIX = 'homebase-int-';
const PEER = '8c7928aa9f04fbda9471'.padEnd(32, '0');

describe('ensurePeerHomebase against a real trust store', () => {
  let stateDir: string;
  let tm: AgentTrustManager;
  let created: string[];

  const deps = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    holdsLease: true,
    findOrCreateTopic: async (name: string) => {
      created.push(name);
      return { topicId: 31337, reused: false };
    },
    getRecorded: (fp: string) => tm.getHomebaseTopic(fp),
    record: (fp: string, topicId: number) => tm.setHomebaseTopic(fp, topicId),
    ...over,
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    tm = new AgentTrustManager({ stateDir });
    tm.getOrCreateProfileByFingerprint(PEER, 'pp');
    created = [];
  });

  afterAll(() => {
    for (const e of fs.readdirSync(os.tmpdir())) {
      if (e.startsWith(PREFIX)) {
        SafeFsExecutor.safeRmSync(path.join(os.tmpdir(), e), {
          recursive: true, force: true, operation: 'tests/integration/peer-homebase-create-and-record.test.ts',
        });
      }
    }
  });

  it('creates the topic, records it, and the record SURVIVES a reload', async () => {
    const r = await ensurePeerHomebase(PEER, 'pp', deps());
    expect(r).toEqual({ created: true, topicId: 31337, reused: false });
    expect(created).toEqual([`pp · Threadline · ${PEER.slice(0, 6)}`]);

    // The point of the integration tier: a real store, re-read from disk.
    const reloaded = new AgentTrustManager({ stateDir });
    expect(reloaded.getHomebaseTopic(PEER)).toBe(31337);
  });

  it('a second pass creates NOTHING — the common path after a re-verify', async () => {
    await ensurePeerHomebase(PEER, 'pp', deps());
    created = [];
    const again = await ensurePeerHomebase(PEER, 'pp', deps());
    expect(again).toEqual({ created: false, reason: 'already-recorded', topicId: 31337 });
    expect(created).toEqual([]); // no external call attempted at all
  });

  it('the gate stops it BEFORE the external call', async () => {
    const r = await ensurePeerHomebase(PEER, 'pp', deps({ enabled: false }));
    expect(r).toEqual({ created: false, reason: 'disabled' });
    expect(created).toEqual([]);
    expect(tm.getHomebaseTopic(PEER)).toBeUndefined();
  });

  it('a standby stops it BEFORE the external call — no 41 duplicate topics', async () => {
    const r = await ensurePeerHomebase(PEER, 'pp', deps({ holdsLease: false }));
    expect(r).toEqual({ created: false, reason: 'not-lease-holder' });
    expect(created).toEqual([]);
    expect(tm.getHomebaseTopic(PEER)).toBeUndefined();
  });

  it('a Telegram failure leaves the store untouched and does not throw', async () => {
    const r = await ensurePeerHomebase(PEER, 'pp', deps({
      findOrCreateTopic: async () => { throw new Error('Chat is not a forum — topic creation skipped'); },
    }));
    expect(r).toEqual({ created: false, reason: 'create-failed' });
    expect(tm.getHomebaseTopic(PEER)).toBeUndefined();
  });

  it('an unknown peer is refused, and no profile is conjured as a side-effect', async () => {
    const stranger = 'ff'.repeat(16);
    const r = await ensurePeerHomebase(stranger, 'who', deps());
    // The topic WAS created (the primitive was called) but the record refused, which is the
    // honest outcome: the topic exists and is reported rather than silently adopted.
    expect(r).toEqual({ created: false, reason: 'record-refused' });
    expect(tm.getHomebaseTopic(stranger)).toBeUndefined();
  });
});
