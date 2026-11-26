/**
 * threadline-mcp's local approval page (packages/threadline-mcp/src/approvalPage.ts; spec
 * threadline-standalone-pairing r4 D5, Echo review round 2). Served on 127.0.0.1 only, at a one-time
 * token path, for an app that cannot ask the person itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { ApprovalPage, ApprovalCoordinator, escapeHtml, PAGE_NOTE_OPENED } from '../../../packages/threadline-mcp/src/approvalPage.js';
import type { ToolResult } from '../../../packages/threadline-mcp/src/pairTools.js';

const pages: ApprovalPage[] = [];
afterEach(() => { for (const p of pages.splice(0)) p.close(); });
async function mkPage(timeoutMs = 60_000) {
  const p = await ApprovalPage.open({ timeoutMs, resultGraceMs: 5_000, postWaitMs: 200 });
  pages.push(p);
  return p;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
const qtOf = (html: string) => /name="qt" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
const post = (p: ApprovalPage, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  req(p.link, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });

describe('approval page', () => {
  it('binds only 127.0.0.1 on a random port, and the link uses 127.0.0.1 with a 64-hex token', async () => {
    const p = await mkPage();
    expect(p.address).toMatchObject({ address: '127.0.0.1' });
    expect(p.address!.port).toBeGreaterThan(0);
    expect(p.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
    expect(p.link).not.toContain('localhost');
  });

  it('refuses a wrong Host (DNS rebinding), a missing Host, and accepts exactly 127.0.0.1:<port>', async () => {
    const p = await mkPage();
    const port = p.address!.port;
    expect((await req(p.link, { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await req(p.link, { headers: { Host: `localhost:${port}` } })).status).toBe(403);
    expect((await req(p.link, { headers: { Host: '127.0.0.1' } })).status).toBe(403);
    expect((await req(p.link)).status).toBe(200);
    // HTTP/1.0 with no Host header at all.
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`GET /${p.token} HTTP/1.0\r\n\r\n`));
      let out = ''; s.on('data', (c) => { out += c; }); s.on('end', () => resolve(out)); s.on('close', () => resolve(out));
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
  });

  it('an unknown token is a bare 404; only GET and POST are allowed', async () => {
    const p = await mkPage();
    const other = p.link.replace(/[0-9a-f]{64}$/, 'a'.repeat(64));
    const r = await req(other);
    expect(r.status).toBe(404);
    expect(r.body).toBe('Not found');
    expect((await req(p.link.replace(/\/[0-9a-f]{64}$/, '/'))).status).toBe(404);
    for (const method of ['PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']) expect((await req(p.link, { method })).status).toBe(405);
  });

  it('every response carries the security headers', async () => {
    const p = await mkPage();
    for (const r of [await req(p.link), await req(p.link.replace(/[0-9a-f]{64}$/, 'b'.repeat(64))), await req(p.link, { method: 'PUT' })]) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBeTruthy();
      expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    }
  });

  it('renders an enum as radios in the given order and escapes a hostile claimed name', async () => {
    const p = await mkPage();
    void p.elicit('Pair with the agent that calls itself "<script>alert(1)</script>"?', { decision: { type: 'string', title: 'Your decision', enum: ['decline', 'approve'] } });
    const html = (await req(p.link)).body;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const radios = [...html.matchAll(/type="radio" name="decision" value="([^"]+)"/g)].map((m) => m[1]);
    expect(radios).toEqual(['decline', 'approve']);
    expect(html).toMatch(/value="submit">Submit</);
    expect(html).toMatch(/value="cancel" formnovalidate>Cancel</);
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });

  it('a string field is a textarea with its title and description', async () => {
    const p = await mkPage();
    void p.elicit('Paste it', { invite: { type: 'string', title: 'Pairing invite', description: 'The whole message' } });
    const html = (await req(p.link)).body;
    expect(html).toMatch(/<label for="invite">Pairing invite<\/label>/);
    expect(html).toMatch(/<textarea id="invite" name="invite"/);
    expect(html).toContain('The whole message');
  });

  it('POST Submit resolves the pending question with the chosen values; the next page shows what comes next', async () => {
    const p = await mkPage();
    const answer = p.elicit('Decide', { decision: { type: 'string', title: 'Your decision', enum: ['decline', 'approve'] } });
    const qt = qtOf((await req(p.link)).body);
    const r = post(p, { qt, action: 'submit', decision: 'approve' });
    expect(await answer).toEqual({ decision: 'approve' });
    p.finish('Paired with the agent that calls itself "x".');
    const res = await r;
    expect(res.status).toBe(200);
    expect(res.body).toContain('Paired with the agent that calls itself &quot;x&quot;.');
    expect(res.body).not.toContain('<form');
  });

  it('Cancel resolves null', async () => {
    const p = await mkPage();
    const answer = p.elicit('Decide', { decision: { type: 'string', title: 'd', enum: ['keep', 'unpair'] } });
    const qt = qtOf((await req(p.link)).body);
    await post(p, { qt, action: 'cancel' });
    expect(await answer).toBeNull();
  });

  it('a missing or wrong per-question token is refused and decides nothing; so is a choice not offered', async () => {
    const p = await mkPage();
    let settled = false;
    const answer = p.elicit('Decide', { decision: { type: 'string', title: 'd', enum: ['decline', 'approve'] } });
    void answer.then(() => { settled = true; });
    expect((await post(p, { action: 'submit', decision: 'approve' })).status).toBe(403);
    expect((await post(p, { qt: 'f'.repeat(32), action: 'submit', decision: 'approve' })).status).toBe(403);
    const qt = qtOf((await req(p.link)).body);
    expect((await post(p, { qt, action: 'submit', decision: 'yes' })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    void post(p, { qt, action: 'submit', decision: 'decline' }).catch(() => {});
    expect(await answer).toEqual({ decision: 'decline' });
  });

  it('a POST from another origin (or Origin: null) is refused; absent or our own origin is accepted', async () => {
    const p = await mkPage();
    const answer = p.elicit('Decide', { decision: { type: 'string', title: 'd', enum: ['decline', 'approve'] } });
    const qt = qtOf((await req(p.link)).body);
    const port = p.address!.port;
    expect((await post(p, { qt, action: 'submit', decision: 'approve' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(p, { qt, action: 'submit', decision: 'approve' }, { Origin: 'null' })).status).toBe(403);
    expect((await post(p, { qt, action: 'submit', decision: 'approve' }, { Origin: `http://localhost:${port}` })).status).toBe(403);
    void post(p, { qt, action: 'submit', decision: 'approve' }, { Origin: `http://127.0.0.1:${port}` }).catch(() => {});
    expect(await answer).toEqual({ decision: 'approve' });
  });

  it('expiry resolves the open question with null, and the page then 404s', async () => {
    const p = await mkPage(150);
    const answer = p.elicit('Decide', { decision: { type: 'string', title: 'd', enum: ['decline', 'approve'] } });
    expect((await req(p.link)).status).toBe(200);
    expect(await answer).toBeNull();
    expect(p.isExpired).toBe(true);
    expect((await req(p.link)).status).toBe(404);
    expect(await p.elicit('again?', { d: { type: 'string', title: 'd' } })).toBeNull();
  });
});

describe('approval coordinator', () => {
  const decisionQ = { decision: { type: 'string' as const, title: 'd', enum: ['decline', 'approve'] } };

  it('returns pending without waiting for the person, opens the browser itself, and never puts the link in the result (R2-1)', async () => {
    const opened: string[] = [];
    const c = new ApprovalCoordinator({ timeoutMs: 60_000, postWaitMs: 100, openBrowser: async (u) => { opened.push(u); return true; } });
    let finished = false;
    const r = await c.start('finish', async (elicit) => { const a = await elicit('Decide', decisionQ); finished = true; return { ok: true, result: a?.decision === 'approve' ? 'finished' : 'undecided', agent: 'x' }; });
    expect(finished).toBe(false);
    expect(r).toMatchObject({ ok: true, pending: true, opened: true, action: 'finish', note: PAGE_NOTE_OPENED });
    expect(opened).toHaveLength(1);
    const token = opened[0].split('/').pop()!;
    const text = JSON.stringify(r);
    expect(text).not.toContain(token);
    expect(text).not.toContain('http://');
    const st = JSON.stringify(c.statusFields());
    expect(st).toContain('pendingApproval');
    expect(st).not.toContain(token);
    expect(st).not.toContain('http://');
    // Asking again for the same step re-opens the same page and returns the same pending result.
    const again = await c.start('finish', async () => ({ ok: true }));
    expect(again).toMatchObject({ pending: true, action: 'finish' });
    expect(opened).toEqual([opened[0], opened[0]]);
    // A different step while this page is open is refused in plain words, and opens nothing (MINOR b).
    expect(await c.start('open', async () => ({ ok: true }))).toEqual({ ok: false, error: 'Another approval is already open in your browser; finish it first.' });
    expect(opened).toHaveLength(2);
    c.close();
  });

  it('falls back to the link in the chat, flagged, only when the browser cannot be opened', async () => {
    const c = new ApprovalCoordinator({ timeoutMs: 60_000, postWaitMs: 100, openBrowser: async () => false });
    const r = await c.start('open', async (elicit) => { await elicit('Decide', decisionQ); return { ok: true, result: 'declined' }; }) as ToolResult & { link: string };
    expect(r).toMatchObject({ ok: true, pending: true, opened: false, fallback: 'link-in-chat' });
    expect(r.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/);
    expect(String(r.note)).toMatch(/weaker/);
    expect(c.statusFields()).toMatchObject({ pendingApproval: { fallback: 'link-in-chat', link: r.link } });
    c.close();
    await new Promise((res) => setTimeout(res, 10));
    expect(c.statusFields()).toMatchObject({ lastApproval: { action: 'open', fallback: 'link-in-chat' } });
  });

  it('an action that ends before asking anything answers the tool call directly and opens nothing', async () => {
    const opened: string[] = [];
    const c = new ApprovalCoordinator({ timeoutMs: 60_000, openBrowser: async (u) => { opened.push(u); return true; } });
    const r = await c.start('finish', async () => ({ ok: false, error: 'Nobody has accepted one of your invites yet.' }));
    expect(r).toEqual({ ok: false, error: 'Nobody has accepted one of your invites yet.' });
    expect(opened).toEqual([]);
    expect(c.statusFields()).toEqual({});
  });
});
