/**
 * Integration test for the threadline_pair MCP tool (Secure A2A Verified Pairing §3.6).
 *
 * Drives the real ThreadlineMCPServer over an in-memory transport with a real
 * AgentTrustManager. Verifies:
 *   - status lists pairings, and shows the SAS words for a pending peer (local
 *     operator surface) so the operator can compare them out-of-band.
 *   - verify/deny do NOT flip pairing state from the MCP tool — they return
 *     guidance pointing to the PIN-gated dashboard flip (FD7). The agent cannot
 *     self-confirm a pairing; the state is unchanged after a verify/deny call.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ThreadlineMCPServer } from '../../../src/threadline/ThreadlineMCPServer.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { ThreadlineMCPDeps } from '../../../src/threadline/ThreadlineMCPServer.js';

const PEER_FP = '8c7928aa9f04fbda947172a2f9b2d81a';
const OWN_FP = '1111111111111111111111111111aaaa';
const PAIRING_ID = 'cafef00dcafef00dcafef00dcafef00d';
const SAS_WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];

let dirs: string[] = [];

async function makeCtx() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-mcp-'));
  dirs.push(stateDir);
  const trustManager = new AgentTrustManager({ stateDir });
  trustManager.recordPendingVerification(PEER_FP, {
    pairingId: PAIRING_ID,
    peerIdentityPub: 'deadbeef'.repeat(8),
    sasWords: SAS_WORDS,
    sasFingerprint: 'a1b2c3d4e5f60718',
    ownFp: OWN_FP,
    displayName: 'dawn',
  });

  const deps = {
    discovery: {
      discoverLocal: vi.fn().mockResolvedValue([]),
      loadKnownAgents: vi.fn().mockReturnValue([]),
      announcePresence: vi.fn(),
      startPresenceHeartbeat: vi.fn().mockReturnValue(() => {}),
    } as any,
    threadResumeMap: { get: vi.fn(), save: vi.fn(), remove: vi.fn(), resolve: vi.fn(), getByRemoteAgent: vi.fn().mockReturnValue([]) } as any,
    trustManager,
    auth: null,
    sendMessage: vi.fn(),
    getThreadHistory: vi.fn(),
    registry: null,
  } as unknown as ThreadlineMCPDeps;

  const server = new ThreadlineMCPServer(
    { agentName: 'agent', protocolVersion: '1.0', transport: 'stdio', requireAuth: false },
    deps,
  );
  const mcpServer = server.getServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  return { trustManager, server, client, close: async () => { await client.close(); await server.stop(); } };
}

function parse(result: any) {
  return JSON.parse((result.content as any)[0].text);
}

describe('threadline_pair MCP tool (integration)', () => {
  afterEach(() => {
    for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'pair-mcp-tool.test.ts:cleanup' }); } catch { /* ignore */ } }
    dirs = [];
  });

  it('status lists the pending pairing without SAS words', async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'status' } });
      const out = parse(res);
      expect(out.count).toBe(1);
      expect(out.pairings[0].peerFp).toBe(PEER_FP);
      expect(out.pairings[0].state).toBe('pending-verification');
      expect(JSON.stringify(out)).not.toContain('abandon');
    } finally { await ctx.close(); }
  });

  it('status for one pending peer shows the SAS words for out-of-band comparison', async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'status', fingerprint: PEER_FP } });
      const out = parse(res);
      expect(out.pairing.sasWords).toEqual(SAS_WORDS);
      expect(out.pairing.instruction).toContain('out-of-band');
    } finally { await ctx.close(); }
  });

  it('verify does NOT flip pairing state — returns the PIN-gated dashboard path (FD7)', async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'verify', fingerprint: PEER_FP } });
      const out = parse(res);
      expect(out.requiresOperatorPin).toBe(true);
      expect(out.message).toContain('dashboard');
      // The pairing must be UNCHANGED — the MCP tool cannot self-confirm.
      expect(ctx.trustManager.getProfileByFingerprint(PEER_FP)?.pairingState).toBe('pending-verification');
      expect(ctx.trustManager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    } finally { await ctx.close(); }
  });

  it('deny likewise does NOT flip — returns guidance, state unchanged', async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'deny', fingerprint: PEER_FP } });
      const out = parse(res);
      expect(out.requiresOperatorPin).toBe(true);
      expect(ctx.trustManager.getProfileByFingerprint(PEER_FP)?.pairingState).toBe('pending-verification');
    } finally { await ctx.close(); }
  });

  it('verify/deny without a fingerprint is an error', async () => {
    const ctx = await makeCtx();
    try {
      const res = await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'verify' } });
      expect(res.isError).toBe(true);
    } finally { await ctx.close(); }
  });
});
