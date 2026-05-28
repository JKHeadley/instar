/**
 * Unit tests for the TelegramPollOwnerLease — the structural fix that prevents
 * the 409 dual-poll class (docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md Part 1,
 * Task 4 of the 2026-05-27 silent-stalls postmortem).
 *
 * Covers both sides of every decision boundary (Testing Integrity Standard):
 *   - tokenHash never leaks the raw token
 *   - writeLease produces a parseable, well-formed lease (atomic via tmp+rename)
 *   - readLease honors staleness, missing file, bad JSON, wrong shape, wrong version
 *   - lifelineOwnsPoll: live+matching=true; live+mismatch=false; stale=false;
 *     missing=false (FAIL-OPEN — never falsely demotes a server to send-only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  tokenHash,
  writeLease,
  readLease,
  lifelineOwnsPoll,
  leasePath,
  DEFAULT_LEASE_STALE_MS,
  type PollOwnerLease,
} from '../../src/lifeline/TelegramPollOwnerLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = '1234567890:AAFakeTokenForUnitTestsOnlyABCDEFGHIJK';
const OTHER_TOKEN = '9876543210:BBOtherTestTokenZYXWVUTSRQPONMLKJIH';

let stateDir: string;

beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-owner-lease-')); });
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/TelegramPollOwnerLease.test.ts' }); } catch { /* ignore */ }
});

describe('tokenHash', () => {
  it('is deterministic + 64-hex SHA-256', () => {
    const h = tokenHash(TOKEN);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(TOKEN)).toBe(h);
  });
  it('NEVER contains the raw token (security contract)', () => {
    const h = tokenHash(TOKEN);
    expect(h).not.toContain(TOKEN);
    expect(h).not.toContain(TOKEN.split(':')[1]);
  });
  it('differs for different tokens', () => {
    expect(tokenHash(TOKEN)).not.toBe(tokenHash(OTHER_TOKEN));
  });
});

describe('writeLease + readLease', () => {
  it('writes a well-formed lease and reads it back', () => {
    writeLease(stateDir, TOKEN, 4242, 1_000_000);
    const lease = readLease(stateDir, 1_000_000);
    expect(lease).toEqual<PollOwnerLease>({
      pid: 4242,
      tokenHash: tokenHash(TOKEN),
      heartbeatTs: 1_000_000,
      v: 1,
    });
  });

  it('the on-disk file never contains the raw token (security contract)', () => {
    writeLease(stateDir, TOKEN, 1, 1);
    const raw = fs.readFileSync(leasePath(stateDir), 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(raw).toContain(tokenHash(TOKEN));
  });

  it('overwrite replaces the previous lease (heartbeat refresh)', () => {
    writeLease(stateDir, TOKEN, 1, 1_000);
    writeLease(stateDir, TOKEN, 1, 2_000);
    expect(readLease(stateDir, 2_000)?.heartbeatTs).toBe(2_000);
  });

  it('readLease returns null when the file does not exist', () => {
    expect(readLease(stateDir, 1)).toBeNull();
  });

  it('readLease returns null for an unparseable file (fail-OPEN)', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(leasePath(stateDir), '{not valid json');
    expect(readLease(stateDir, 1)).toBeNull();
  });

  it('readLease returns null for wrong-shape JSON (fail-OPEN)', () => {
    fs.writeFileSync(leasePath(stateDir), JSON.stringify({ pid: 1 })); // missing fields
    expect(readLease(stateDir, 1)).toBeNull();
  });

  it('readLease returns null for an unknown schema version', () => {
    const bad = { pid: 1, tokenHash: tokenHash(TOKEN), heartbeatTs: 1, v: 99 };
    fs.writeFileSync(leasePath(stateDir), JSON.stringify(bad));
    expect(readLease(stateDir, 1)).toBeNull();
  });

  it('readLease treats a lease older than staleMs as absent', () => {
    writeLease(stateDir, TOKEN, 1, 1_000);
    expect(readLease(stateDir, 1_000 + DEFAULT_LEASE_STALE_MS + 1)).toBeNull();
    // fresh enough → returns the lease
    expect(readLease(stateDir, 1_000 + DEFAULT_LEASE_STALE_MS - 1)).not.toBeNull();
  });
});

describe('lifelineOwnsPoll — the server-side decision', () => {
  it('TRUE: live lease + matching token (server must demote to send-only)', () => {
    writeLease(stateDir, TOKEN, 1, 1_000);
    expect(lifelineOwnsPoll(stateDir, TOKEN, 1_001)).toBe(true);
  });

  it('FALSE: live lease but DIFFERENT token (server should keep polling its own token)', () => {
    writeLease(stateDir, TOKEN, 1, 1_000);
    expect(lifelineOwnsPoll(stateDir, OTHER_TOKEN, 1_001)).toBe(false);
  });

  it('FALSE: stale lease (fail-OPEN — the lifeline appears dead, server polls)', () => {
    writeLease(stateDir, TOKEN, 1, 1_000);
    expect(lifelineOwnsPoll(stateDir, TOKEN, 1_000 + DEFAULT_LEASE_STALE_MS + 1)).toBe(false);
  });

  it('FALSE: no lease file at all (fail-OPEN — setups without a lifeline keep polling)', () => {
    expect(lifelineOwnsPoll(stateDir, TOKEN, 1)).toBe(false);
  });

  it('FALSE: corrupted lease (fail-OPEN — never falsely silence a fine agent)', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(leasePath(stateDir), 'garbage');
    expect(lifelineOwnsPoll(stateDir, TOKEN, 1)).toBe(false);
  });
});
