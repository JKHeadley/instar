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

function authEvidence(uid: string, messageId = 'tg-test') {
  return {
    kind: 'authenticated-inbound' as const,
    ingress: 'telegram-polling' as const,
    authorization: 'telegram-is-authorized-sender' as const,
    senderUid: uid,
    messageId,
  };
}

describe('TopicOperatorStore authenticated binding / verified reads', () => {
  it('establishes from an authenticated uid and reads it back', () => {
    const s = new TopicOperatorStore(dir);
    const rec = s.setAuthenticatedOperator(
      19437,
      { platform: 'telegram', uid: '7812716706', displayName: 'Justin', boundAt: '2026-06-06T00:00:00Z' },
      authEvidence('7812716706'),
    );
    expect(rec?.uid).toBe('7812716706');
    expect(rec?.names).toEqual(['justin']);
    expect(rec?.boundFrom).toBe('authenticated-inbound');
    expect(rec?.establishmentEvidence).toEqual(authEvidence('7812716706'));
    expect(s.getOperator(19437)?.uid).toBe('7812716706');
  });

  it('REFUSES a blank uid — an operator cannot be established without a verified id', () => {
    const s = new TopicOperatorStore(dir);
    expect(s.setAuthenticatedOperator(1, { platform: 'telegram', uid: '' }, authEvidence(''))).toBeNull();
    expect(s.setAuthenticatedOperator(1, { platform: 'telegram', uid: '   ' }, authEvidence('   '))).toBeNull();
    expect(s.getOperator(1)).toBeNull();
  });

  it('REFUSES mismatched or missing authentication evidence', () => {
    const s = new TopicOperatorStore(dir);
    expect(s.setAuthenticatedOperator(1, { platform: 'telegram', uid: '123' }, authEvidence('999'))).toBeNull();
    expect(s.setAuthenticatedOperator(1, { platform: 'telegram', uid: '123' }, authEvidence('123', ''))).toBeNull();
    expect(s.getOperator(1)).toBeNull();
  });

  it('a content name can never BECOME the operator — only a uid does (by construction)', () => {
    const s = new TopicOperatorStore(dir);
    // The only way to set an operator is via a uid; there is no name-only path.
    // Establishing with a uid but no display name yields no names to match prose
    // against — it never adopts a name from content.
    const rec = s.setAuthenticatedOperator(5, { platform: 'telegram', uid: '999' }, authEvidence('999'));
    expect(rec?.uid).toBe('999');
    expect(rec?.names).toEqual([]);
  });

  it('getOperator is null for an unbound topic', () => {
    expect(new TopicOperatorStore(dir).getOperator(404)).toBeNull();
  });

  it('persists across instances (durable JSON store)', () => {
    new TopicOperatorStore(dir).setAuthenticatedOperator(
      19437,
      { platform: 'telegram', uid: '7812716706', displayName: 'Justin' },
      authEvidence('7812716706'),
    );
    const reloaded = new TopicOperatorStore(dir); // fresh instance, no cache
    expect(reloaded.getOperator(19437)?.uid).toBe('7812716706');
    expect(fs.existsSync(path.join(dir, 'topic-operators.json'))).toBe(true);
  });

  it('replacing an operator overwrites the prior record', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(1, { platform: 'telegram', uid: 'A', displayName: 'Alice' }, authEvidence('A'));
    s.setAuthenticatedOperator(1, { platform: 'telegram', uid: 'B', displayName: 'Bob' }, authEvidence('B'));
    expect(s.getOperator(1)?.uid).toBe('B');
  });
});

describe('TopicOperatorStore asserted and legacy bindings', () => {
  it('records a manual assertion durably but refuses it as a verified operator', () => {
    const s = new TopicOperatorStore(dir);
    const rec = s.setOperator(77, { platform: 'telegram', uid: 'arbitrary-content-name', displayName: 'Caroline' });
    expect(rec?.boundFrom).toBe('operator-api-assertion');
    expect(rec?.establishmentEvidence).toEqual({
      kind: 'operator-api-assertion',
      route: 'POST /topic-operator',
    });
    expect(s.getBinding(77)?.uid).toBe('arbitrary-content-name');
    expect(s.getOperator(77)).toBeNull();
    expect(s.asVerifiedOperator(77)).toBeNull();
    expect(s.sessionContextBlock(77)).toBeNull();
    expect(s.all()).toEqual({});
    expect(s.allBindings()['77']?.uid).toBe('arbitrary-content-name');
  });

  it('P2: refuses a subject that self-reports authenticated while its evidence says assertion', () => {
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify({
      88: {
        platform: 'telegram', uid: 'forged', names: ['caroline'], boundAt: '',
        boundFrom: 'authenticated-inbound',
        establishmentEvidence: { kind: 'operator-api-assertion', route: 'POST /topic-operator' },
      },
    }));
    const s = new TopicOperatorStore(dir);
    expect(s.getBinding(88)?.boundFrom).toBe('authenticated-inbound');
    expect(s.getOperator(88)).toBeNull();
  });

  it('P5: legacy evidence-less and malformed/wrong-container inputs are not-proven, never verified', () => {
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify({
      99: {
        platform: 'telegram', uid: 'legacy', names: ['legacy'], boundAt: '',
        boundFrom: 'authenticated-inbound',
      },
    }));
    expect(new TopicOperatorStore(dir).getOperator(99)).toBeNull();
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), 'null');
    const nullStore = new TopicOperatorStore(dir);
    expect(nullStore.getOperator(99)).toBeNull();
    expect(nullStore.all()).toEqual({});
    expect(nullStore.allBindings()).toEqual({});
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), '[]');
    expect(new TopicOperatorStore(dir).getOperator(99)).toBeNull();
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), '{not-json');
    expect(new TopicOperatorStore(dir).getOperator(99)).toBeNull();
  });

  it('P4: verified enumeration is non-vacuous and covers every topic-key shape in the raw population', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(
      'outside-primary-enumeration',
      { platform: 'telegram', uid: 'verified-string-topic', displayName: 'Verified' },
      authEvidence('verified-string-topic'),
    );
    s.setOperator(77, { platform: 'telegram', uid: 'asserted-only', displayName: 'Asserted' });

    expect(Object.keys(s.allBindings()).sort()).toEqual(['77', 'outside-primary-enumeration']);
    expect(s.all()).toEqual({
      'outside-primary-enumeration': expect.objectContaining({
        uid: 'verified-string-topic',
        boundFrom: 'authenticated-inbound',
      }),
    });
  });
});

describe('TopicOperatorStore.asVerifiedOperator (feeds PrincipalGuard)', () => {
  it('returns the PrincipalGuard shape when bound, null when unbound', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(1, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' }, authEvidence('7812716706'));
    expect(s.asVerifiedOperator(1)).toEqual({ uid: '7812716706', names: ['justin'] });
    expect(s.asVerifiedOperator(2)).toBeNull();
  });
});

describe('TopicOperatorStore.sessionContextBlock', () => {
  it('builds a <topic-operator> block naming the verified operator', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' }, authEvidence('7812716706'));
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
    s.setAuthenticatedOperator(7, { platform: 'telegram', uid: '999' }, authEvidence('999'));
    expect(s.sessionContextBlock(7)).toContain('uid 999 is the VERIFIED operator');
  });
});

describe('TopicOperatorStore.setAuthenticatedOperator idempotency (increment 2e)', () => {
  // Both ingress paths re-bind on EVERY message from the operator; an identical
  // record must be a pure read, not a per-message file rewrite.
  it('skips the disk write when the stored record is identical', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' }, authEvidence('7812716706', 'tg-1'));
    const file = path.join(dir, 'topic-operators.json');
    // Remove the file: if the identical re-bind skips save(), it stays absent.
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/unit/topic-operator-store.test.ts' });
    const rec = s.setAuthenticatedOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' }, authEvidence('7812716706', 'tg-2'));
    expect(rec?.uid).toBe('7812716706');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('still writes when the record actually changes', () => {
    const s = new TopicOperatorStore(dir);
    s.setAuthenticatedOperator(19437, { platform: 'telegram', uid: '7812716706', displayName: 'Justin' }, authEvidence('7812716706'));
    const file = path.join(dir, 'topic-operators.json');
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/unit/topic-operator-store.test.ts' });
    s.setAuthenticatedOperator(19437, { platform: 'telegram', uid: '42', displayName: 'Other' }, authEvidence('42'));
    expect(fs.existsSync(file)).toBe(true);
    expect(s.getOperator(19437)?.uid).toBe('42');
  });
});
