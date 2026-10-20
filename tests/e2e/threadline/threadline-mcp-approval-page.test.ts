/**
 * The BUILT threadline-mcp over stdio, driven by an MCP client that declares NO elicitation (like
 * Claude Desktop), pairs with a real Instar agent on a real in-process relay through the local
 * approval page, then sends it a credential (spec threadline-standalone-pairing r4 D5).
 *
 * The server opens the person's browser itself (Echo review R2-1). Here `open` / `xdg-open` on PATH
 * is a stub that records the URL, so the "person" (fetch) gets the link from the opener, and the test
 * checks that no tool result ever carries it.
 *
 * Needs packages/threadline-mcp/node_modules. Skipped where they are not installed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createTempProject } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk')) && fs.existsSync(path.join(pkg, 'node_modules', '@sagemindai', 'threadline-core'));

describe.skipIf(!hasDeps || process.platform === 'win32')('threadline-mcp without elicitation ↔ Instar, through the approval page', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  let client: Client;
  let clientTransport: StdioClientTransport;
  let mcpState: TempProject;
  let instarProject: TempProject;
  let stubDir: TempProject;
  let openedFile: string;
  let boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  const instarEvents: InviteEvent[] = [];
  const inbox: Array<{ from: string; content: unknown }> = [];
  const rawResults: string[] = [];

  const callOn = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    rawResults.push(text);
    try { return { isError: !!r.isError, body: JSON.parse(text), text }; } catch { return { isError: !!r.isError, body: text, text }; }
  };
  const call = (name: string, args: Record<string, unknown> = {}) => callOn(client, name, args);
  const openedLinks = () => (fs.existsSync(openedFile) ? fs.readFileSync(openedFile, 'utf8').split('\n').filter(Boolean) : []);
  const serverEnv = (stateDir: string, relay: string) => ({
    ...process.env as Record<string, string>,
    PATH: `${stubDir.dir}${path.delimiter}${process.env.PATH}`, OPENED_FILE: openedFile,
    THREADLINE_RELAY: relay, THREADLINE_STATE_DIR: stateDir, THREADLINE_NAME: 'desktop-agent', THREADLINE_OWNER: 'Justin',
    THREADLINE_SEND_PORT: '1',
  });
  async function answer(url: string, values: Record<string, string>) {
    let html = '';
    await vi.waitFor(async () => { html = await (await fetch(url)).text(); expect(html).toMatch(/name="qt"/); }, { timeout: 10_000, interval: 50 });
    const qt = /name="qt" value="([0-9a-f]+)"/.exec(html)![1];
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ qt, action: 'submit', ...values }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return { asked: html, after: await res.text() };
  }

  beforeAll(async () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    stubDir = createTempProject();
    openedFile = path.join(stubDir.dir, 'opened.txt');
    for (const name of ['open', 'xdg-open']) {
      fs.writeFileSync(path.join(stubDir.dir, name), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$OPENED_FILE"\n', { mode: 0o755 });
    }
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
      agentName: 'echo', ownerName: 'Justin', stateDir: instarProject.stateDir, projectDir: instarProject.dir, port: 4372, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    boot.pairingInvites!.events.on('event', (e: InviteEvent) => instarEvents.push(e));
    boot.relayClient!.on('message', (m: { from: string; content: unknown }) => inbox.push(m));

    mcpState = createTempProject();
    clientTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env: serverEnv(mcpState.stateDir, relayUrl), stderr: 'pipe' });
    client = new Client({ name: 'desktop-host', version: '1.0.0' }, { capabilities: {} }); // NO elicitation
    await client.connect(clientTransport);
    await vi.waitFor(async () => expect((await call('threadline_status')).body.connected).toBe(true), { timeout: 15_000 });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await boot?.shutdown();
    instarProject?.cleanup(); mcpState?.cleanup(); stubDir?.cleanup();
    await relay?.stop(); relayData?.cleanup();
  });

  it('pair_open returns pending at once with no link; the person approves on the page; Instar finishes; a credential arrives', async () => {
    const instarFp = boot.relayClient!.fingerprint!.toLowerCase();
    const inv = boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };

    const t0 = Date.now();
    const opened = await call('threadline_pair_open');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(opened.body).toMatchObject({ ok: true, pending: true, opened: true, action: 'open' });
    expect(opened.body.note).toMatch(/A page opened in your browser/);
    await vi.waitFor(() => expect(openedLinks()).toHaveLength(1));
    const link = openedLinks()[0];
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
    const token = link.split('/').pop()!;
    expect(opened.text).not.toContain(token);
    expect(opened.text).not.toContain('http://');
    const pendingStatus = await call('threadline_pair_status');
    expect(pendingStatus.body.pendingApproval).toMatchObject({ action: 'open' });
    expect(pendingStatus.text).not.toContain(token);

    await answer(link, { invite: inv.message });
    const approved = await answer(link, { decision: 'approve' });
    expect(approved.asked).toContain('calls itself &quot;echo&quot;');
    expect(approved.after).toContain('Approved.');

    await vi.waitFor(() => expect(instarEvents.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 15_000 });
    expect(boot.pairingInvites!.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      const st = await call('threadline_pair_status');
      expect(st.body.paired).toEqual([expect.objectContaining({ fingerprint: instarFp, state: 'mutual-verified' })]);
      expect(st.body.lastApproval).toMatchObject({ action: 'open', result: { ok: true, result: 'approved' } });
    }, { timeout: 15_000 });

    const sent = await call('threadline_send', { to: instarFp, message: 'the vault password', credential: true });
    expect(sent.isError).toBe(false);
    await vi.waitFor(() => {
      expect(inbox.filter((m) => m.from !== instarFp).some((m) => JSON.stringify(m.content).includes('the vault password'))).toBe(true);
    }, { timeout: 15_000 });

    // No tool result in this whole flow ever carried the page link or its token.
    for (const t of rawResults) { expect(t).not.toContain(token); expect(t).not.toContain('http://127.0.0.1'); }
    expect(JSON.stringify(rawResults)).not.toContain('tlinv1:');
  }, 120_000);

  it('a second threadline-mcp on the same state directory refuses pairing naming the owning app, never a pid', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env: serverEnv(mcpState.stateDir, 'ws://127.0.0.1:1/v1/connect'), stderr: 'pipe' });
    const second = new Client({ name: 'other-host', version: '1.0.0' }, { capabilities: {} });
    await second.connect(transport);
    try {
      const before = openedLinks().length;
      for (const tool of ['threadline_pair_open', 'threadline_pair_finish']) {
        const r = await callOn(second, tool);
        expect(r.isError).toBe(true);
        expect(r.body.error).toBe('Tell your person this, in these words: "Pairing is open in desktop-host. Finish it there, or close that app and try again."');
        expect(r.body.error).not.toMatch(/pid|\d{3,}|THREADLINE_/);
      }
      expect(openedLinks().length).toBe(before); // a non-owner never serves or opens a page
    } finally {
      await second.close();
    }
  }, 60_000);

  it('after the owner exits, the other server takes ownership at its next pairing call, pairs through its page, and handles inbound pairing ops', async () => {
    // A second Instar agent, so this pairing is fresh.
    const instar2 = createTempProject();
    const boot2 = await bootstrapThreadline({
      agentName: 'echo-two', ownerName: 'Justin', stateDir: instar2.stateDir, projectDir: instar2.dir, port: 4373, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    const events2: InviteEvent[] = [];
    boot2.pairingInvites!.events.on('event', (e: InviteEvent) => events2.push(e));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env: serverEnv(mcpState.stateDir, relayUrl), stderr: 'pipe' });
    const second = new Client({ name: 'claude-ai', version: '1.0.0' }, { capabilities: {} });
    await second.connect(transport);
    try {
      expect((await callOn(second, 'threadline_pair_open')).body.error).toContain('Pairing is open in desktop-host.');
      const pid = clientTransport.pid!;
      process.kill(pid, 'SIGTERM');
      await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 10_000 });
      await vi.waitFor(async () => expect((await callOn(second, 'threadline_status')).body.connected).toBe(true), { timeout: 15_000 });

      // The new owner still sees the pairing the old owner made (stores re-read from disk).
      const instarFp = boot.relayClient!.fingerprint!.toLowerCase();
      const st0 = await callOn(second, 'threadline_pair_status');
      expect(st0.body.paired).toEqual([expect.objectContaining({ fingerprint: instarFp, state: 'mutual-verified' })]);

      const inv = boot2.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };
      const before = openedLinks().length;
      const opened = await callOn(second, 'threadline_pair_open');
      expect(opened.body).toMatchObject({ ok: true, pending: true, opened: true });
      await vi.waitFor(() => expect(openedLinks().length).toBe(before + 1));
      const link = openedLinks()[before];
      await answer(link, { invite: inv.message });
      await answer(link, { decision: 'approve' });
      await vi.waitFor(() => expect(events2.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 15_000 });
      expect(boot2.pairingInvites!.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
      // Instar's Finish arrives encrypted on the new owner's relay connection and is handled there.
      const fp2 = boot2.relayClient!.fingerprint!.toLowerCase();
      await vi.waitFor(async () => {
        const st = await callOn(second, 'threadline_pair_status');
        expect(st.body.paired).toEqual(expect.arrayContaining([expect.objectContaining({ fingerprint: fp2, state: 'mutual-verified' })]));
      }, { timeout: 15_000 });
      const lock = fs.readFileSync(path.join(mcpState.stateDir, 'threadline', 'owner.lock'), 'utf8');
      expect(lock).toBe(`${transport.pid}\nClaude Desktop`);
    } finally {
      await second.close();
      await boot2.shutdown();
      instar2.cleanup();
    }
  }, 120_000);
});
