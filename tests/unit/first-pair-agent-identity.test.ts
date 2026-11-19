/** fb-1e30d109-e50 — the pure pieces of the first-pair identity fix. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAgentIdentityForPairing, describeMissingAgentIdentity, joinerAgentNameToAdopt } from '../../src/core/firstPairAgentIdentity.js';
import { readAgentIdentityForHandover } from '../../src/core/AgentIdentityHandover.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function home(opts: { peers?: string[] } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-pair-'));
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify({ machineId: 'm_self', name: 'self' }));
  const machines: Record<string, unknown> = { m_self: { name: 'self', role: 'awake', status: 'active' } };
  for (const p of opts.peers ?? []) machines[p] = { name: p, role: 'standby', status: 'active' };
  fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), JSON.stringify({ version: 1, machines }));
  return dir;
}
const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/first-pair-agent-identity.test.ts' });

describe('ensureAgentIdentityForPairing', () => {
  it('mints on the agent\'s only machine', () => {
    const d = home();
    try {
      expect(ensureAgentIdentityForPairing(d)).toEqual({ ok: true, minted: true });
      expect(readAgentIdentityForHandover(d)).not.toBeNull();
    } finally { rm(d); }
  });
  it('leaves an existing identity alone', () => {
    const d = home();
    try {
      ensureAgentIdentityForPairing(d);
      const fp = readAgentIdentityForHandover(d)!.fingerprint;
      expect(ensureAgentIdentityForPairing(d)).toEqual({ ok: true, minted: false });
      expect(readAgentIdentityForHandover(d)!.fingerprint).toBe(fp);
    } finally { rm(d); }
  });
  it('refuses (in words) where the registry already names another machine', () => {
    const d = home({ peers: ['m_peer'] });
    try {
      const r = ensureAgentIdentityForPairing(d);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.absence.reason).toBe('inviter-mint-refused');
      expect(readAgentIdentityForHandover(d)).toBeNull();
    } finally { rm(d); }
  });
  it('never mints beside an identity file it cannot hand over (encrypted or damaged)', () => {
    const d = home();
    try {
      fs.writeFileSync(path.join(d, 'identity.json'), JSON.stringify({ version: 1, publicKey: 'x', privateKeyEncryption: 'aes' }));
      let minted = false;
      const r = ensureAgentIdentityForPairing(d, { mint: () => { minted = true; } });
      expect(r).toMatchObject({ ok: false, absence: { reason: 'inviter-identity-unreadable' } });
      expect(minted).toBe(false);
    } finally { rm(d); }
  });
  it('a mint that throws something else is named, not swallowed', () => {
    const d = home();
    try {
      const r = ensureAgentIdentityForPairing(d, { mint: () => { throw new Error('disk full'); } });
      expect(r).toMatchObject({ ok: false, absence: { reason: 'inviter-mint-failed' } });
      if (!r.ok) expect(r.absence.detail).toContain('disk full');
    } finally { rm(d); }
  });
});

describe('describeMissingAgentIdentity', () => {
  it('a named reason is shown as is', () => {
    expect(describeMissingAgentIdentity({ reason: 'inviter-mint-refused', detail: 'X lists another machine.' })).toBe('  X lists another machine.');
  });
  it('only a response with no reason at all reads as an older inviter', () => {
    expect(describeMissingAgentIdentity(undefined)).toMatch(/older version/);
    expect(describeMissingAgentIdentity({ reason: 'x', detail: '  ' })).toMatch(/older version/);
  });
});

describe('joinerAgentNameToAdopt', () => {
  it('a config with no agent name takes the inviter\'s', () => {
    expect(joinerAgentNameToAdopt({}, 'xmproof')).toBe('xmproof');
    expect(joinerAgentNameToAdopt(null, 'xmproof')).toBe('xmproof');
  });
  it('an explicit name is kept (a real mismatch stays a refusal)', () => {
    expect(joinerAgentNameToAdopt({ projectName: 'other' }, 'xmproof')).toBeNull();
  });
  it('a malformed inviter name is ignored', () => {
    expect(joinerAgentNameToAdopt({}, '../etc')).toBeNull();
    expect(joinerAgentNameToAdopt({}, '..')).toBeNull();
    expect(joinerAgentNameToAdopt({}, '.')).toBeNull();
    expect(joinerAgentNameToAdopt({}, 'a..b')).toBeNull();
    expect(joinerAgentNameToAdopt({}, 42)).toBeNull();
  });
});
