/**
 * Recording a peer's homebase topic on its trust profile.
 *
 * The profile is the durable per-peer record, so the topic id lives there rather than in a
 * second map that could be torn against it. The behaviour worth pinning is the refusal: a
 * second write with a DIFFERENT topic id would silently orphan the first, which is the
 * duplicate-topic shape the spec accepts as a rare crash outcome but must never invite.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PREFIX = 'homebase-rec-';
const PEER = 'aa'.repeat(16);

describe('homebase topic record', () => {
  let stateDir: string;
  let tm: AgentTrustManager;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    tm = new AgentTrustManager({ stateDir });
    // The profile is created the ordinary way rather than through the pairing fixture: this
    // test is about the homebase record, not about how a peer becomes known.
    tm.getOrCreateProfileByFingerprint(PEER, 'pp');
  });

  afterAll(() => {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith(PREFIX)) {
        SafeFsExecutor.safeRmSync(path.join(os.tmpdir(), entry), {
          recursive: true, force: true, operation: 'tests/unit/peer-homebase-topic-record.test.ts',
        });
      }
    }
  });

  it('starts with no homebase — absent is the correct initial state, not an error', () => {
    expect(tm.getHomebaseTopic(PEER)).toBeUndefined();
  });

  it('records and reads back a topic id', () => {
    expect(tm.setHomebaseTopic(PEER, 4242)).toBe(true);
    expect(tm.getHomebaseTopic(PEER)).toBe(4242);
  });

  it('is idempotent for the SAME id', () => {
    expect(tm.setHomebaseTopic(PEER, 4242)).toBe(true);
    expect(tm.setHomebaseTopic(PEER, 4242)).toBe(true);
    expect(tm.getHomebaseTopic(PEER)).toBe(4242);
  });

  it('REFUSES a different id rather than orphaning the first topic', () => {
    expect(tm.setHomebaseTopic(PEER, 4242)).toBe(true);
    expect(tm.setHomebaseTopic(PEER, 9999)).toBe(false);
    expect(tm.getHomebaseTopic(PEER)).toBe(4242);
  });

  it('refuses an unknown peer rather than creating a profile as a side-effect', () => {
    expect(tm.setHomebaseTopic('ee'.repeat(16), 1)).toBe(false);
    expect(tm.getHomebaseTopic('ee'.repeat(16))).toBeUndefined();
  });

  it('refuses nonsense input', () => {
    expect(tm.setHomebaseTopic('', 1)).toBe(false);
    expect(tm.setHomebaseTopic(PEER, 1.5)).toBe(false);
    expect(tm.setHomebaseTopic(PEER, Number.NaN)).toBe(false);
    expect(tm.getHomebaseTopic(PEER)).toBeUndefined();
  });

  it('survives a reload — the profile is the durable record', () => {
    expect(tm.setHomebaseTopic(PEER, 777)).toBe(true);
    const reloaded = new AgentTrustManager({ stateDir });
    expect(reloaded.getHomebaseTopic(PEER)).toBe(777);
  });
});
