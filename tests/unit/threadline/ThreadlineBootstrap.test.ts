/**
 * Tests for ThreadlineBootstrap — auto-wiring Threadline into the agent server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';

/** Write a canonical (unencrypted) identity.json and return its expected fingerprint + hex pubkey. */
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

describe('ThreadlineBootstrap', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-bootstrap-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadlineBootstrap.test.ts:26' });
  });

  it('bootstraps successfully and returns all components', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });

    expect(result.handshakeManager).toBeDefined();
    expect(result.discovery).toBeDefined();
    expect(result.shutdown).toBeInstanceOf(Function);

    await result.shutdown();
  });

  // NOTE: tests asserting orphan `identity-keys.json` creation / persistence /
  // permissions / corrupted-file regeneration were removed when
  // loadOrCreateIdentityKeys was deleted — that orphan keypair is no longer minted
  // (see docs/specs/threadline-duplicate-identity-resolution.md, change D). The
  // canonical routing identity is covered by the advertisement tests below.

  it('creates threadline directory structure', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    expect(fs.existsSync(path.join(stateDir, 'threadline'))).toBe(true);
  });

  it('does NOT create the orphan identity-keys.json (loadOrCreateIdentityKeys removed)', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    expect(fs.existsSync(path.join(stateDir, 'threadline', 'identity-keys.json'))).toBe(false);
  });

  it('CI guard: ThreadlineBootstrap mints no orphan identity (cannot be re-introduced)', () => {
    // Per docs/specs/threadline-duplicate-identity-resolution.md change D: gate on the
    // orphan-minting FUNCTION name, not the filename string — `identity-keys.json` is
    // still legitimately named in explanatory comments here and in PostUpdateMigrator.ts
    // (the #479 routing-identity note explaining what NOT to advertise).
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/threadline/ThreadlineBootstrap.ts'),
      'utf-8',
    );
    expect(src).not.toContain('loadOrCreateIdentityKeys');
  });

  it('registers MCP server in .mcp.json', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    expect(fs.existsSync(mcpJsonPath)).toBe(true);

    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    expect(mcpConfig.mcpServers.threadline).toBeDefined();
    expect(mcpConfig.mcpServers.threadline.command).toBe('node');
    expect(mcpConfig.mcpServers.threadline.args).toContain('--agent-name');
    expect(mcpConfig.mcpServers.threadline.args).toContain('test-agent');
  });

  it('preserves existing .mcp.json entries', async () => {
    // Pre-existing .mcp.json with playwright
    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    fs.writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    }));

    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    // Both should exist
    expect(mcpConfig.mcpServers.playwright).toBeDefined();
    expect(mcpConfig.mcpServers.threadline).toBeDefined();
  });

  it('announces agent presence via discovery', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      agentDescription: 'A test agent for testing',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfoPath = path.join(stateDir, 'threadline', 'agent-info.json');
    expect(fs.existsSync(agentInfoPath)).toBe(true);

    const agentInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(agentInfo.name).toBe('test-agent');
    expect(agentInfo.port).toBe(4040);
    expect(agentInfo.description).toBe('A test agent for testing');
    expect(agentInfo.capabilities).toContain('threadline');
    expect(agentInfo.capabilities).toContain('mcp');
    expect(agentInfo.framework).toBe('instar');
  });

  // THREADLINE-IDENTITY-DISCOVERY-UNIFICATION: announce advertises the canonical
  // routing identity (the address the relay answers to), internally consistent.
  it('advertises the canonical routing fingerprint + consistent publicKey when an identity exists', async () => {
    const expected = seedCanonicalIdentity(stateDir);

    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfo = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8'),
    );
    expect(agentInfo.fingerprint).toBe(expected.fingerprint);
    expect(agentInfo.publicKey).toBe(expected.publicKeyHex);
    // Internal consistency: fingerprint === computeFingerprint(publicKey)
    expect(computeFingerprint(Buffer.from(agentInfo.publicKey, 'hex'))).toBe(agentInfo.fingerprint);
    // machine field is set so multi-machine advertisements are attributable
    expect(typeof agentInfo.machine).toBe('string');
    expect(agentInfo.machine.length).toBeGreaterThan(0);
  });

  // No-fabrication boundary: no routing identity on disk → both fields OMITTED
  // (never invent a dead address), and boot does not throw.
  it('omits fingerprint and publicKey when no routing identity exists', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfo = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8'),
    );
    expect(agentInfo.fingerprint).toBeUndefined();
    expect(agentInfo.publicKey).toBeUndefined();
  });

  // The CANONICAL identity is advertised, never the legacy threadline/identity-keys.json
  // hex key — even when that orphan file is present (the root cause of the bug).
  it('advertises the canonical identity even when the orphan identity-keys.json is present', async () => {
    const expected = seedCanonicalIdentity(stateDir);
    // Plant an orphan identity-keys.json with a DIFFERENT key (the stale-hex source).
    const orphan = generateIdentityKeyPair();
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'threadline', 'identity-keys.json'),
      JSON.stringify({
        publicKey: orphan.publicKey.toString('hex'),
        privateKey: orphan.privateKey.toString('hex'),
        createdAt: new Date().toISOString(),
      }, null, 2),
    );

    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfo = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8'),
    );
    expect(agentInfo.publicKey).toBe(expected.publicKeyHex);
    expect(agentInfo.publicKey).not.toBe(orphan.publicKey.toString('hex'));
    expect(agentInfo.fingerprint).toBe(expected.fingerprint);
  });

  it('uses default description when none provided', async () => {
    const result = await bootstrapThreadline({
      agentName: 'my-agent',
      stateDir,
      projectDir,
      port: 4040,
    });
    await result.shutdown();

    const agentInfoPath = path.join(stateDir, 'threadline', 'agent-info.json');
    const agentInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    expect(agentInfo.description).toBe('my-agent Instar agent');
  });

  it('shutdown stops heartbeat without error', async () => {
    const result = await bootstrapThreadline({
      agentName: 'test-agent',
      stateDir,
      projectDir,
      port: 4040,
    });

    // Should not throw
    await result.shutdown();
    // Double shutdown should also not throw
    await result.shutdown();
  });
});
