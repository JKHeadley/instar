/**
 * The real product: the BUILT threadline-mcp server, launched over stdio like Claude Code launches
 * it, driven by an MCP client that answers elicitations as a person would, pairs with a real Instar
 * agent on a real in-process relay through the actual tools, then sends it a credential
 * (spec threadline-standalone-pairing §7 step 2).
 *
 * Needs packages/threadline-mcp/node_modules (the package's own deps). Skipped where they are not
 * installed, e.g. CI unit shards; run locally and in the package's own pipeline.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createTempProject } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk')) && fs.existsSync(path.join(pkg, 'node_modules', '@sagemindai', 'threadline-core'));

describe.skipIf(!hasDeps)('threadline-mcp over stdio ↔ Instar', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  let client: Client;
  let transport: StdioClientTransport;
  let mcpState: TempProject;
  let instarProject: TempProject;
  let boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  const instarEvents: InviteEvent[] = [];
  const inbox: Array<{ from: string; content: unknown }> = [];
  let elicitAnswers: Array<Record<string, string>> = [];
  const asked: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    try { return { isError: !!r.isError, body: JSON.parse(text) }; } catch { return { isError: !!r.isError, body: text }; }
  };

  beforeAll(async () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    instarProject = createTempProject();
    boot = await bootstrapThreadline({
      agentName: 'echo', ownerName: 'Justin', stateDir: instarProject.stateDir, projectDir: instarProject.dir, port: 4371, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    boot.pairingInvites!.events.on('event', (e: InviteEvent) => instarEvents.push(e));
    boot.relayClient!.on('message', (m: { from: string; content: unknown }) => inbox.push(m));

    mcpState = createTempProject();
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(pkg, 'dist', 'server.js')],
      env: {
        ...process.env as Record<string, string>,
        THREADLINE_RELAY: relayUrl, THREADLINE_STATE_DIR: mcpState.stateDir, THREADLINE_NAME: 'desktop-agent', THREADLINE_OWNER: 'Justin',
        THREADLINE_SEND_PORT: '1', // never adopt a local listener proxy on this machine
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'person-host', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(String((req.params as { message?: string }).message));
      const content = elicitAnswers.shift();
      return content ? { action: 'accept', content } : { action: 'decline' };
    });
    await client.connect(transport);
    await vi.waitFor(async () => expect((await call('threadline_status')).body.connected).toBe(true), { timeout: 15_000 });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await boot?.shutdown();
    instarProject?.cleanup(); mcpState?.cleanup();
    await relay?.stop(); relayData?.cleanup();
  });

  it('pairs with an Instar agent through the tools (the person pastes and approves), then sends a credential', async () => {
    const instarFp = boot.relayClient!.fingerprint!.toLowerCase();
    const inv = boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };

    // Before pairing, a credential is refused by the tool.
    const early = await call('threadline_send', { to: instarFp, message: 'too soon', credential: true });
    expect(early.isError).toBe(true);
    expect(String(early.body)).toMatch(/only go to an agent you have paired with/);

    elicitAnswers = [{ invite: inv.message }, { decision: 'approve' }];
    const opened = await call('threadline_pair_open');
    expect(opened.body).toMatchObject({ ok: true, result: 'approved' });
    expect(JSON.stringify(opened.body)).not.toContain('tlinv1:');
    expect(asked[1]).toContain('calls itself "echo"');

    await vi.waitFor(() => expect(instarEvents.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 15_000 });
    expect(boot.pairingInvites!.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      const st = await call('threadline_pair_status');
      expect(st.body.paired).toEqual([expect.objectContaining({ fingerprint: instarFp, state: 'mutual-verified' })]);
    }, { timeout: 15_000 });

    // Pairing events reach the inbox as system lines, not agent messages (spec §4).
    const inboxNow = await call('threadline_inbox');
    expect(inboxNow.body.pairing.join('\n')).toMatch(/now paired with "echo"/);
    expect(JSON.stringify(inboxNow.body.messages)).not.toMatch(/pair-invite-/);

    const sent = await call('threadline_send', { to: instarFp, message: 'the vault password', credential: true });
    expect(sent.isError).toBe(false);
    // A reply that resolves waitForReply carries the same trust labels as the inbox (Echo review ADV-4):
    // a pre-D9 Instar answers in plaintext, so it must come back as an unverified claim, not as the peer.
    const mcpFp = String((await call('threadline_status')).body.agentId ?? '').toLowerCase();
    expect(mcpFp).toMatch(/^[0-9a-f]{32}$/);
    const waiting = call('threadline_send', { to: instarFp, message: 'ping?', threadId: 'thread-wfr-0001', waitForReply: true, timeoutSeconds: 15 });
    await new Promise((r) => setTimeout(r, 1500));
    boot.relayClient!.sendPlaintext(mcpFp, 'pong from instar', 'thread-wfr-0001');
    const answered = await waiting;
    expect(answered.body.reply).toBe('pong from instar');
    expect(answered.body.note).toMatch(/neither encrypted nor signed/);

    // History keeps only that a credential was sent, never its body (Echo review SEC-11).
    const histDir = path.join(mcpState.stateDir, 'history');
    const hist = fs.readdirSync(histDir).map((f) => fs.statSync(path.join(histDir, f)).isFile() ? fs.readFileSync(path.join(histDir, f), 'utf8') : '').join('\n');
    expect(hist).toMatch(/\[credential, 18 bytes\]/);
    expect(hist).not.toContain('the vault password');
    await vi.waitFor(() => {
      expect(inbox.filter((m) => m.from !== instarFp).some((m) => JSON.stringify(m.content).includes('the vault password'))).toBe(true);
    }, { timeout: 15_000 });
  }, 120_000);
});
