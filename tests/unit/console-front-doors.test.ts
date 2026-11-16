/**
 * The three doors (docs/specs/work-front-doors.md §2.1, §2.3, §7 stage 1): Conversations, Work and Agent
 * are the whole sidebar; every existing #/group/page hash keeps resolving (tested over every route the
 * console, the server and the apps link to); the Needs-you strip hides only on a complete zero read.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DOORS, doorHref, doorOf, resolveRoute, startDoor, NATIVE_PATHS, NATIVE_PAGES, GROUPS, PHONE_PAGE_ALIASES, PHONE_ONLY_PAGES, FLEET_TILES, allTabIds, tabHref } from '../../dashboard/console/nav-model.js';
import { stripModel } from '../../dashboard/console/needs-strip.js';
import { NEED_SOURCES, NEED_EXEMPT } from '../../dashboard/console/needs-model.js';
import { SURFACE_REFERRAL_CLAUDEMD_SECTION, SURFACE_REFERRAL_OLD_NEEDS_WORDING, SURFACE_REFERRAL_NEW_NEEDS_WORDING } from '../../src/core/PostUpdateMigrator.js';

const ROOT = path.resolve(__dirname, '../..');
const CONSOLE_JS = fs.readFileSync(path.join(ROOT, 'dashboard/console/console.js'), 'utf8');

/** Every console hash any shipped file links to: the console itself, the server (notices, links) and the agent templates. */
function linkedHashes(): string[] {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|ts|md)$/.test(e.name)) files.push(p); } };
  for (const d of ['dashboard/console', 'src/server', 'src/core', 'src/data/awareness', 'src/scaffold', 'src/templates', 'src/monitoring', 'src/messaging']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const out = new Set<string>();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/#\/((?:home|work|capacity|people|settings|agent)(?:\/[a-z][a-z-]*)*)/g)) out.add(m[1]);
  return [...out].sort();
}

describe('the three doors', () => {
  it('the sidebar is exactly Conversations, Work and Agent', () => {
    expect(DOORS.map((d) => d.label)).toEqual(['Conversations', 'Work', 'Agent']);
  });

  it('Work opens straight on the board when it is on, else the Work section (Promises, Plans)', () => {
    expect(doorHref('work', { board: true })).toBe('#/work/board');
    expect(doorHref('work', { board: false })).toBe('#/work');
    // The Conversations door is the hierarchy on every agent, browser devices or not (found live 2026-11-16:
    // the browser-device chat page read "No conversations yet" on a real agent with hundreds).
    expect(doorHref('conversations', { chats: true })).toBe('#/work/conversations');
    expect(doorHref('conversations', { chats: false })).toBe('#/work/conversations');
    expect(doorHref('agent')).toBe('#/agent');
  });

  it('opens on the front door used last; Agent is never the opening door', () => {
    expect(startDoor('work')).toBe('work');
    expect(startDoor('conversations')).toBe('conversations');
    expect(startDoor('agent')).toBe('conversations');
    expect(startDoor(null)).toBe('conversations');
  });

  it('every native page console.js renders is in NATIVE_PATHS, and the other way round', () => {
    const start = CONSOLE_JS.indexOf('const NATIVE = {');
    const body = CONSOLE_JS.slice(start, CONSOLE_JS.indexOf('};', start));
    const keys = [...body.matchAll(/'([a-z]+\/[a-z/-]+)':/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([...NATIVE_PATHS].sort());
  });

  it('every page has a door, and every non-front page lives under Agent', () => {
    for (const p of NATIVE_PATHS) expect(['conversations', 'work', 'agent']).toContain(doorOf(p));
    expect(doorOf('work/board')).toBe('work');
    expect(doorOf('work/chats')).toBe('conversations');
    expect(doorOf('capacity/accounts')).toBe('agent');
    expect(doorOf('work/promises')).toBe('agent');
  });
});

describe('every existing address keeps resolving', () => {
  const resolvesToSomething = (hash: string, opts = {}) => {
    const r = resolveRoute(hash, opts);
    expect(['page', 'group', 'agent', 'redirect'], hash).toContain(r.kind);
    if (r.kind === 'redirect') expect(r.to, hash).toMatch(/^#\/work\/(chats|conversations)$/);
    return r;
  };

  it('every hash linked anywhere in the console, the server and the agent instructions', () => {
    const hashes = linkedHashes();
    expect(hashes.length).toBeGreaterThan(20);
    for (const h of hashes) {
      const r = resolvesToSomething(`#/${h}`);
      // A real page or section never turns into a redirect: only Home and unknown addresses do.
      if (NATIVE_PATHS.includes(h) || GROUPS.some((g) => g.id === h)) expect(r.kind, h).not.toBe('redirect');
    }
  });

  it('the examples the spec names', () => {
    for (const h of ['#/work/board', '#/capacity/accounts', '#/people/mandates', '#/settings/learned?s=pending']) expect(resolveRoute(h).kind, h).toBe('page');
  });

  it('every tile link (NATIVE_PAGES covers the older tab ids)', () => {
    for (const id of allTabIds()) {
      const href = tabHref(id);
      if (!href.startsWith('#/')) continue; // the legacy dashboard and the pairing page are outside the console
      expect(resolveRoute(href).kind, `${id} → ${href}`).toBe('page');
    }
    for (const v of Object.values(NATIVE_PAGES)) if (v.startsWith('#/')) expect(resolveRoute(v).kind, v).toBe('page');
  });

  it('every phone-mode short name and phone-only page', () => {
    for (const short of Object.keys(PHONE_PAGE_ALIASES)) expect(resolveRoute(short, { phone: true }).kind, short).toBe('page');
    for (const p of PHONE_ONLY_PAGES) expect(resolveRoute(p, { phone: true }).kind, p).toBe('page');
  });

  it('every section is still reachable, and the Agent page holds every section', () => {
    for (const g of GROUPS) expect(resolveRoute(`#/${g.id}`).kind).toBe('group');
    expect(resolveRoute('#/agent').kind).toBe('agent');
    expect(CONSOLE_JS).toMatch(/GROUPS\.flatMap\(\(g\) => groupParts\(g, \{ asSection: true \}\)\)/);
    for (const t of FLEET_TILES) expect(resolveRoute(tabHref(t.id)).kind, t.id).toBe('page');
  });

  it('Home and an unknown address land on the Conversations door, never a blank page', () => {
    for (const h of ['#/home', '#/home?retry=1', '', '#/', '#/nope/nothing']) {
      const r = resolveRoute(h, { chats: true });
      expect(r.kind, h).toBe('redirect');
      expect(r.to).toBe('#/work/conversations');
    }
  });

  it('the bare Work address opens the board when it is on, and the Work section when it is off', () => {
    expect(resolveRoute('#/work', { board: true })).toMatchObject({ kind: 'redirect', door: 'work', to: '#/work/board' });
    expect(resolveRoute('#/work', { board: false }).kind).toBe('group');
    // Pages inside the Work section still open as themselves.
    expect(resolveRoute('#/work/promises', { board: true }).kind).toBe('page');
  });
});

describe('an unknown page inside a known section', () => {
  it('opens that section, as it did before the doors', () => {
    expect(resolveRoute('#/capacity/nothing-here')).toMatchObject({ kind: 'group', path: 'capacity', door: 'agent' });
    expect(resolveRoute('#/work/old-page')).toMatchObject({ kind: 'group', path: 'work', door: 'work' });
  });
});

describe('the Needs-you strip', () => {
  const answer = (over = {}) => ({ ok: true, data: { count: 0, items: [], complete: true, couldNotCheck: [], ...over } });
  const item = (title: string, tone = 'attn') => ({ id: title, title, why: 'because', tone, action: { kind: 'href', href: '#/work/board' } });

  it('hides only when a complete read returns zero', () => {
    expect(stripModel(answer()).show).toBe(false);
  });

  it('stays while loading, and when the read failed or answered in an unreadable shape', () => {
    expect(stripModel(null)).toMatchObject({ show: true, state: 'loading', incomplete: true });
    expect(stripModel({ ok: false, reason: 'the server answered 404' })).toMatchObject({ show: true, incomplete: true, badge: '?' });
    expect(stripModel({ ok: true, data: { nope: 1 } })).toMatchObject({ show: true, incomplete: true });
  });

  it('a zero with a source it could not check says so and marks the count incomplete', () => {
    const m = stripModel(answer({ complete: false, couldNotCheck: ['the work board', 'accounts and sign-ins'] }));
    expect(m.show).toBe(true);
    expect(m.incomplete).toBe(true);
    expect(m.badge).toBe('0+?');
    expect(m.line).toBe('Could not check the work board and accounts and sign-ins.');
  });

  it('shows the first rows, the rest as a count, and an urgent one turns the strip red', () => {
    const m = stripModel(answer({ count: 5, items: [item('a', 'bad'), item('b'), item('c'), item('d'), item('e')] }));
    expect(m.rows.map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(m.more).toBe(2);
    expect(m.state).toBe('bad');
    expect(m.title).toBe('Needs you · 5');
    expect(m.badge).toBe('5');
  });
});

describe('wording: the Needs-you list, not Home', () => {
  it('needs-model and its exemptions name the Needs-you list', () => {
    const src = fs.readFileSync(path.join(ROOT, 'dashboard/console/needs-model.js'), 'utf8');
    expect(src).not.toMatch(/in Home['’]s count/);
    expect(NEED_SOURCES.length).toBeGreaterThan(10);
    expect(NEED_EXEMPT.every((e) => !/Home['’]s count/.test(e.why))).toBe(true);
  });

  it('new agents get the new sentence; the migration rewords the old one in place', () => {
    expect(SURFACE_REFERRAL_CLAUDEMD_SECTION).toContain(SURFACE_REFERRAL_NEW_NEEDS_WORDING);
    expect(SURFACE_REFERRAL_CLAUDEMD_SECTION).not.toContain(SURFACE_REFERRAL_OLD_NEEDS_WORDING);
    const old = SURFACE_REFERRAL_CLAUDEMD_SECTION.replace(SURFACE_REFERRAL_NEW_NEEDS_WORDING, SURFACE_REFERRAL_OLD_NEEDS_WORDING);
    expect(old).toContain("in Home's count");
    const mig = fs.readFileSync(path.join(ROOT, 'src/core/PostUpdateMigrator.ts'), 'utf8');
    expect(mig).toMatch(/content\.includes\(SURFACE_REFERRAL_OLD_NEEDS_WORDING\)/);
  });
});
