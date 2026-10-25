/**
 * An identity.json that exists but cannot be read is never replaced with a new identity (Echo review
 * SEC-15): that would be a new agent, every peer's pin of us would break, and the old key would be lost.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const pkg = path.resolve(__dirname, '../../../packages/threadline-mcp');
const hasDeps = fs.existsSync(path.join(pkg, 'node_modules', '@modelcontextprotocol', 'sdk'));

describe.skipIf(!hasDeps)('threadline-mcp identity guard', () => {
  it('refuses to start over a corrupt identity.json and leaves the file untouched', () => {
    execFileSync('npx', ['tsc'], { cwd: pkg, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'pipe' });
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ident-'));
    fs.writeFileSync(path.join(sd, 'identity.json'), '{ "agentId": "trunc');
    const r = spawnSync(process.execPath, [path.join(pkg, 'dist', 'server.js')], {
      env: { ...process.env, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' },
      input: '', encoding: 'utf8', timeout: 15_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exists but is not a readable identity\. Refusing to replace it/);
    expect(fs.readFileSync(path.join(sd, 'identity.json'), 'utf8')).toBe('{ "agentId": "trunc');
  });
});

describe.skipIf(!hasDeps)('threadline-mcp: two servers on one state directory', () => {
  it('the second one does not own pairing and says so; the first does', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-two-'));
    const env = { ...process.env as Record<string, string>, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' };
    const start = async () => {
      const c = new Client({ name: 'host', version: '1.0.0' }, { capabilities: { elicitation: {} } });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env, stderr: 'pipe' }));
      return c;
    };
    const first = await start();
    const second = await start();
    const text = async (c: InstanceType<typeof Client>) => JSON.stringify((await c.callTool({ name: 'threadline_pair_invite', arguments: {} })).content);
    // The refusal names the owning app (its MCP client name), never a pid (Echo review R2-2).
    const refused = await text(second);
    expect(refused).toMatch(/Pairing is open in host\. Finish it there, or close that app and try again\./);
    expect(refused).not.toMatch(/pid|THREADLINE_STATE_DIR/);
    expect(await text(first)).not.toMatch(/Pairing is open in/);
    await second.close(); await first.close();
  }, 60_000);

  it('when the owner exits, the other one takes ownership at its next pairing call ("close that app and try again")', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-take-'));
    const env = { ...process.env as Record<string, string>, THREADLINE_STATE_DIR: sd, THREADLINE_SEND_PORT: '1', THREADLINE_RELAY: 'ws://127.0.0.1:9/v1/connect' };
    const start = async (name: string) => {
      const t = new StdioClientTransport({ command: process.execPath, args: [path.join(pkg, 'dist', 'server.js')], env, stderr: 'pipe' });
      const c = new Client({ name, version: '1.0.0' }, { capabilities: { elicitation: {} } });
      await c.connect(t);
      return { c, t };
    };
    const first = await start('claude-ai');
    const second = await start('cursor');
    const invite = async (c: InstanceType<typeof Client>) => JSON.parse((await c.callTool({ name: 'threadline_pair_invite', arguments: {} })).content[0].text) as { ok: boolean; error?: string };
    expect(await invite(second.c)).toMatchObject({ ok: false, error: expect.stringContaining('Pairing is open in Claude Desktop.') });

    const pid = first.t.pid!;
    process.kill(pid, 'SIGTERM');
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 10_000 });

    expect(await invite(second.c)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(sd, 'threadline', 'owner.lock'), 'utf8')).toBe(`${second.t.pid}\nCursor`);
    await second.c.close();
    await first.c.close().catch(() => {});
  }, 60_000);
});
