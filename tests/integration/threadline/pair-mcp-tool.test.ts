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

async function makeCtx(opts: { reload?: boolean; extra?: Record<string, unknown> } = {}) {
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
    reloadTrustBeforePairingRead: opts.reload,
    ...(opts.extra ?? {}),
  } as unknown as ThreadlineMCPDeps;

  const server = new ThreadlineMCPServer(
    { agentName: 'agent', protocolVersion: '1.0', transport: 'stdio', requireAuth: false },
    deps,
  );
  const mcpServer = server.getServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  return { trustManager, stateDir, server, client, close: async () => { await client.close(); await server.stop(); } };
}

function parse(result: any) {
  return JSON.parse((result.content as any)[0].text);
}

describe('threadline_pair MCP tool (integration)', () => {
  afterEach(() => {
    for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'pair-mcp-tool.test.ts:cleanup' }); } catch { /* ignore */ } }
    dirs = [];
  });

  it('in stdio mode, status sees a pairing the SERVER started after this process loaded (spec §3.6)', async () => {
    for (const reload of [true, false]) {
      const ctx = await makeCtx({ reload });
      try {
        // A second trust manager on the same state dir stands in for the agent server.
        const serverSide = new AgentTrustManager({ stateDir: ctx.stateDir });
        serverSide.recordPendingVerification('f'.repeat(32), {
          pairingId: 'b'.repeat(32), peerIdentityPub: 'f'.repeat(64), sasWords: SAS_WORDS,
          sasFingerprint: '0102030405060708', ownFp: OWN_FP, displayName: 'later',
        });
        serverSide.flush();
        const out = parse(await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'status' } }));
        expect(out.count).toBe(reload ? 2 : 1);
      } finally { await ctx.close(); }
    }
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

  it('invite makes an invite through the server and tells the agent the operator must send it privately and finish it', async () => {
    const createInvite = vi.fn().mockResolvedValue({ success: true, status: 200, body: { ok: true, iid: 'a'.repeat(32), exp: '2026-10-14T13:00:00Z', message: 'agent invites you… tlinv1:x.y' } });
    const ctx = await makeCtx({ extra: { createInvite } });
    try {
      const out = parse(await ctx.client.callTool({ name: 'threadline_pair', arguments: { action: 'invite', ttlMinutes: 30, fingerprint: PEER_FP.toUpperCase() } }));
      expect(createInvite).toHaveBeenCalledWith({ ttlMinutes: 30, bindFp: PEER_FP });
      expect(out.message).toContain('tlinv1:');
      expect(out.instruction).toMatch(/PRIVATELY/);
      expect(out.instruction).toMatch(/cannot approve or finish/);
    } finally { await ctx.close(); }
  });

  it('invite without a reachable server, or refused by it, is an error', async () => {
    const none = await makeCtx();
    try {
      const r = await none.client.callTool({ name: 'threadline_pair', arguments: { action: 'invite' } });
      expect(r.isError).toBe(true);
    } finally { await none.close(); }
    const refused = await makeCtx({ extra: { createInvite: vi.fn().mockResolvedValue({ success: false, status: 503, error: 'verified pairing not enabled' }) } });
    try {
      const r = await refused.client.callTool({ name: 'threadline_pair', arguments: { action: 'invite' } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain('not enabled');
    } finally { await refused.close(); }
  });
});
