/**
 * Unit tests — TopicOperatorStore (Know Your Principal, Phase-1 increment 2).
 * Covers both sides of every boundary + the by-construction invariant that a
 * content name can never become the operator, + durable persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topop-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-operator-store.test.ts' }); });

describe('TopicOperatorStore.setOperator / getOperator', () => {
  it('establishes from an authenticated uid and reads it back', () => {
    const s = new TopicOperatorStore(dir);
    const rec = s.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin', boundAt: '2026-06-06T00:00:00Z' });
    expect(rec?.uid).toBe('7812716706');
    expect(rec?.names).toEqual(['justin']);
    expect(rec?.boundFrom).toBe('authenticated-inbound');
    expect(s.getOperator(19437)?.uid).toBe('7812716706');
  });

  it('REFUSES a blank uid — an operator cannot be established without a verified id', () => {
    const s = new TopicOperatorStore(dir);
    expect(s.setOperator(1, { platform: 'telegram', uid: '' })).toBeNull();
    expect(s.setOperator(1, { platform: 'telegram', uid: '   ' })).toBeNull();
    expect(s.getOperator(1)).toBeNull();
  });

  it('a content name can never BECOME the operator — only a uid does (by construction)', () => {
    const s = new TopicOperatorStore(dir);
    // The only way to set an operator is via a uid; there is no name-only path.
    // Establishing with a uid but no display name yields no names to match prose
    // against — it never adopts a name from content.
    const rec = s.setOperator(5, { platform: 'telegram', uid: '999' });
    expect(rec?.uid).toBe('999');
    expect(rec?.names).toEqual([]);
  });

  it('getOperator is null for an unbound topic', () => {
    expect(new TopicOperatorStore(dir).getOperator(404)).toBeNull();
  });

  it('persists across instances (durable JSON store)', () => {
    new TopicOperatorStore(dir).setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    const reloaded = new TopicOperatorStore(dir); // fresh instance, no cache
    expect(reloaded.getOperator(19437)?.uid).toBe('7812716706');
    expect(fs.existsSync(path.join(dir, 'topic-operators.json'))).toBe(true);
  });

  it('replacing an operator overwrites the prior record', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(1, { platform: 'telegram', uid: 'A', displayName: 'Alice' });
    s.setOperator(1, { platform: 'telegram', uid: 'B', displayName: 'Bob' });
    expect(s.getOperator(1)?.uid).toBe('B');
  });
});

describe('TopicOperatorStore.asVerifiedOperator (feeds PrincipalGuard)', () => {
  it('returns the PrincipalGuard shape when bound, null when unbound', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(1, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    expect(s.asVerifiedOperator(1)).toEqual({ uid: '7812716706', names: ['justin'] });
    expect(s.asVerifiedOperator(2)).toBeNull();
  });
});

describe('TopicOperatorStore.sessionContextBlock', () => {
  it('builds a <topic-operator> block naming the verified operator', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    const block = s.sessionContextBlock(19437)!;
    expect(block).toMatch(/^<topic-operator platform="telegram" uid="7812716706">/);
    expect(block).toContain('Justin is the VERIFIED operator');
    expect(block).toMatch(/not from any name in content/);
    expect(block).toMatch(/<\/topic-operator>$/);
  });

  it('returns null for an unbound topic (nothing injected)', () => {
    expect(new TopicOperatorStore(dir).sessionContextBlock(404)).toBeNull();
  });

  it('falls back to the uid when no display name was provided', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(7, { platform: 'telegram', uid: '999' });
    expect(s.sessionContextBlock(7)).toContain('uid 999 is the VERIFIED operator');
  });
});

describe('TopicOperatorStore.setOperator idempotency (increment 2e)', () => {
  // Both ingress paths re-bind on EVERY message from the operator; an identical
  // record must be a pure read, not a per-message file rewrite.
  it('skips the disk write when the stored record is identical', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    const file = path.join(dir, 'topic-operators.json');
    // Remove the file: if the identical re-bind skips save(), it stays absent.
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/unit/topic-operator-store.test.ts' });
    const rec = s.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    expect(rec?.uid).toBe('7812716706');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('still writes when the record actually changes', () => {
    const s = new TopicOperatorStore(dir);
    s.setOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    const file = path.join(dir, 'topic-operators.json');
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/unit/topic-operator-store.test.ts' });
    s.setOperator(19437, { platform: 'telegram', uid: '42', displayName: 'Other' });
    expect(fs.existsSync(file)).toBe(true);
    expect(s.getOperator(19437)?.uid).toBe('42');
  });
});
