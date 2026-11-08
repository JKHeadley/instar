/**
 * HTML-site ratchet (dashboard-conversations-browser-device §4.12).
 *
 * Every way src/server (and the view-holder relay in src/commands/server.ts) can send HTML is listed
 * here and classified. A browser device's key lives in the console origin, so a page that renders
 * agent- or third-party-authored markup on that origin could drive it; such pages must be
 * `sandboxed`. A new site fails this test until someone classifies it (and, if it renders authored
 * markup, sandboxes it). The count per (file, enclosing route) catches a new site added inside an
 * already-listed handler.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { dashboardSecurityHeaders, VIEW_SANDBOX_CSP } from '../../src/server/middleware.js';

type SiteClass =
  | 'sandboxed'            // renders agent- or third-party-authored markup: served under the /view sandbox
  | 'first-party-template' // instar code, every interpolated value escaped
  | 'first-party-console'  // the dashboard console / legacy dashboard (escaping or DOMPurify for foreign text)
  | 'agent-served-code'    // /dashboard/preview: inside the OS-user boundary (§4.1)
  | 'not-html';            // matched the scan but sends text/plain or a static asset

const SITES: Record<string, { count: number; cls: SiteClass; why: string }> = {
  'src/commands/server.ts (none)': { count: 2, cls: 'sandboxed', why: 'view-holder relay body; the answering machine adds the /view sandbox header' },
  'src/server/AgentServer.ts /dashboard/desktop.html': { count: 1, cls: 'first-party-template', why: 'desktop page; the one interpolated label is escaped' },
  'src/server/AgentServer.ts /dashboard/desktop.js': { count: 1, cls: 'not-html', why: 'static script asset' },
  'src/server/AgentServer.ts /dashboard/desktop-setup.js': { count: 1, cls: 'not-html', why: 'static script asset' },
  'src/server/AgentServer.ts /dashboard/desktop.css': { count: 1, cls: 'not-html', why: 'static stylesheet asset' },
  'src/server/AgentServer.ts /dashboard': { count: 1, cls: 'first-party-console', why: 'express.static of the shipped dashboard and console' },
  'src/server/dashboardEntry.ts /dashboard': { count: 2, cls: 'first-party-console', why: 'dashboard index and /dashboard/pair page files shipped with instar' },
  'src/server/dashboardPreview.ts (none)': { count: 2, cls: 'agent-served-code', why: '/dashboard/preview: agent-published console pages, by design inside the OS-user boundary' },
  'src/server/routes.ts /mcp/approve/:requestId': { count: 6, cls: 'first-party-template', why: 'MCP approval page; interpolated values escaped' },
  'src/server/routes.ts /view/:id': { count: 6, cls: 'sandboxed', why: 'private views (marked passes raw HTML) and the relayed holder copy' },
  'src/server/routes.ts /view/:id/unlock': { count: 4, cls: 'sandboxed', why: 'unlocked view render' },
  'src/server/routes.ts /secrets/drop/:token': { count: 4, cls: 'first-party-template', why: 'secret drop form; values escaped' },
  'src/server/topicIntentRoutes.ts /topic-intent/:topicId/briefing': { count: 1, cls: 'not-html', why: 'empty text/plain 400' },
};

const ROOT = path.resolve(__dirname, '../..');
const HTML_SITE = /text\/html|\.type\(['"]html['"]\)|\.sendFile\(|express\.static\(|\.send\(\s*['"`]|\.send\(html\b/;
const ROUTE = /\b(?:router|app|this\.app|r)\.(?:get|post|put|patch|delete|use|all)\(\s*['"`]([^'"`]+)['"`]/;

function scan(): Record<string, number> {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src/server'));
  files.push(path.join(ROOT, 'src/commands/server.ts'));
  const out: Record<string, number> = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || !HTML_SITE.test(l)) return;
      let route = '(none)';
      for (let j = i; j >= 0 && j > i - 120; j--) { const m = ROUTE.exec(lines[j]!); if (m) { route = m[1]!; break; } }
      const k = `${rel} ${route}`;
      out[k] = (out[k] ?? 0) + 1;
    });
  }
  return out;
}

function headersFor(p: string): Record<string, string> {
  const h: Record<string, string> = {};
  const req = { path: p, get: () => 'localhost:4040' } as unknown as Request;
  const res = { header: (k: string, v: string) => { h[k.toLowerCase()] = v; } } as unknown as Response;
  dashboardSecurityHeaders(req, res, () => {});
  return h;
}

describe('HTML-site ratchet (§4.12)', () => {
  it('every HTML-sending site is classified, with the current count', () => {
    const found = scan();
    const unclassified = Object.keys(found).filter((k) => !SITES[k]);
    expect(unclassified, `classify these new HTML sites in tests/unit/html-site-ratchet.test.ts: ${unclassified.join(', ')}`).toEqual([]);
    const miscounted = Object.entries(found).filter(([k, n]) => SITES[k] && SITES[k]!.count !== n).map(([k, n]) => `${k}: ${n} (listed ${SITES[k]!.count})`);
    expect(miscounted, 'a classified handler gained or lost an HTML site; re-classify it').toEqual([]);
    const stale = Object.keys(SITES).filter((k) => !found[k]);
    expect(stale, 'remove listings whose site is gone').toEqual([]);
  });

  it('every sandboxed site is under /view (the path the sandbox middleware covers) or the view relay', () => {
    for (const [k, v] of Object.entries(SITES)) {
      if (v.cls !== 'sandboxed') continue;
      expect(k.includes(' /view/') || k === 'src/commands/server.ts (none)', k).toBe(true);
    }
  });

  it('/view responses carry the sandbox policy, any case, with no same-origin, scripts or forms', () => {
    for (const p of ['/view/abc', '/view/abc/unlock', '/VIEW/abc', '/View/abc', '/view']) {
      expect(headersFor(p)['content-security-policy'], p).toBe(VIEW_SANDBOX_CSP);
    }
    expect(VIEW_SANDBOX_CSP).toBe('sandbox allow-popups allow-popups-to-escape-sandbox allow-downloads');
    for (const forbidden of ['allow-same-origin', 'allow-scripts', 'allow-forms']) expect(VIEW_SANDBOX_CSP).not.toContain(forbidden);
    expect(headersFor('/views')['content-security-policy']).toBeUndefined();
    expect(headersFor('/viewer/x')['content-security-policy']).toBeUndefined();
  });

  it('the console CSP allows blob: images and media only under /dashboard/console/ (§4.11)', () => {
    const c = headersFor('/dashboard/console/index.html')['content-security-policy']!;
    expect(c).toContain("img-src 'self' blob:");
    expect(c).toContain("media-src 'self' blob:");
    expect(c).not.toContain('data:');
    expect(headersFor('/DASHBOARD/Console/x.js')['content-security-policy']).toContain("img-src 'self' blob:");
    const legacy = headersFor('/dashboard/legacy')['content-security-policy']!;
    expect(legacy).not.toContain('blob:');
  });
});
