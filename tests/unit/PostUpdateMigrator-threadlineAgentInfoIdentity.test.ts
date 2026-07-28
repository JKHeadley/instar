/**
 * Verifies PostUpdateMigrator.migrateThreadlineAgentInfoIdentity repairs an
 * existing agent's agent-info.json so discovery advertises the CANONICAL
 * routing identity (the address the relay answers to) instead of a stale orphan
 * hex key or an absent fingerprint (THREADLINE-IDENTITY-DISCOVERY-UNIFICATION,
 * Migration parity — the belt-and-suspenders for the narrow update-without-
 * restart window).
 *
 * Covers: diverged fixture → repaired to the consistent { fingerprint,
 * publicKey } pair; already-aligned → no-op; no-identity → no-op (no
 * fabrication, no throw); idempotent across repeated runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function run(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateThreadlineAgentInfoIdentity(r: MigrationResult): void }).migrateThreadlineAgentInfoIdentity(result);
  return result;
}

/** Seed a canonical (unencrypted) identity.json; return its fingerprint + hex pubkey. */
function seedCanonicalIdentity(stateDir: string): { fingerprint: string; publicKeyHex: string } {
  fs.mkdirSync(stateDir, { recursive: true });
  const kp = generateIdentityKeyPair();
  fs.writeFileSync(
    path.join(stateDir, 'identity.json'),
    JSON.stringify({
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none',
      createdAt: new Date().toISOString(),
    }, null, 2),
  );
  return { fingerprint: computeFingerprint(kp.publicKey), publicKeyHex: kp.publicKey.toString('hex') };
}

describe('PostUpdateMigrator — threadline agent-info identity repair', () => {
  let projectDir: string;
  let stateDir: string;
  let tlDir: string;
  let agentInfoPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agentinfo-id-'));
    stateDir = path.join(projectDir, '.instar');
    tlDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(tlDir, { recursive: true });
    agentInfoPath = path.join(tlDir, 'agent-info.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-threadlineAgentInfoIdentity.test.ts:cleanup' });
  });

  it('repairs a diverged agent-info.json (stale orphan hex) to the canonical consistent pair', () => {
    const expected = seedCanonicalIdentity(stateDir);
    // agent-info.json carries a STALE hex pubkey from an old keypair, no fingerprint.
    const orphan = generateIdentityKeyPair();
    fs.writeFileSync(agentInfoPath, JSON.stringify({
      name: 'test', port: 4042, path: projectDir,
      capabilities: ['threadline', 'mcp'], threadlineVersion: '1.0',
      publicKey: orphan.publicKey.toString('hex'),
      framework: 'instar', updatedAt: new Date(0).toISOString(),
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('repaired agent-info.json'))).toBe(true);

    const repaired = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(repaired.fingerprint).toBe(expected.fingerprint);
    expect(repaired.publicKey).toBe(expected.publicKeyHex);
    expect(repaired.publicKey).not.toBe(orphan.publicKey.toString('hex'));
    // Internal consistency holds after repair.
    expect(computeFingerprint(Buffer.from(repaired.publicKey, 'hex'))).toBe(repaired.fingerprint);
  });

  it('is a no-op when agent-info.json is already aligned with the canonical identity', () => {
    const expected = seedCanonicalIdentity(stateDir);
    fs.writeFileSync(agentInfoPath, JSON.stringify({
      name: 'test', port: 4042, path: projectDir,
      capabilities: ['threadline'], threadlineVersion: '1.0',
      publicKey: expected.publicKeyHex,
      fingerprint: expected.fingerprint,
      framework: 'instar', updatedAt: new Date().toISOString(),
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.some(s => s.includes('already aligned'))).toBe(true);
  });

  it('no-ops (never fabricates) when there is no resolvable routing identity', () => {
    // agent-info.json exists but there is NO identity.json / legacy identity.
    fs.writeFileSync(agentInfoPath, JSON.stringify({
      name: 'test', port: 4042, path: projectDir,
      capabilities: ['threadline'], threadlineVersion: '1.0',
      framework: 'instar', updatedAt: new Date().toISOString(),
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.some(s => s.includes('no resolvable routing identity'))).toBe(true);
    const after = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(after.fingerprint).toBeUndefined();
    expect(after.publicKey).toBeUndefined();
  });

  it('skips when there is no agent-info.json (agent never announced)', () => {
    seedCanonicalIdentity(stateDir);
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('no agent-info.json'))).toBe(true);
  });

  it('is idempotent across repeated runs', () => {
    const expected = seedCanonicalIdentity(stateDir);
    fs.writeFileSync(agentInfoPath, JSON.stringify({
      name: 'test', port: 4042, path: projectDir,
      capabilities: ['threadline'], threadlineVersion: '1.0',
      publicKey: 'deadbeef', framework: 'instar', updatedAt: new Date(0).toISOString(),
    }, null, 2));

    const first = run(newMigrator(projectDir));
    expect(first.upgraded.some(u => u.includes('repaired'))).toBe(true);

    const second = run(newMigrator(projectDir));
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some(s => s.includes('already aligned'))).toBe(true);

    const finalInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(finalInfo.fingerprint).toBe(expected.fingerprint);
    expect(finalInfo.publicKey).toBe(expected.publicKeyHex);
  });
});
