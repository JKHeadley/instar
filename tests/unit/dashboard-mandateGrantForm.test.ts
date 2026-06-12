/**
 * Mandates tab — user floor-action grant form (Mobile-Complete Operator
 * Actions, instar#1080).
 *
 * Born 2026-06-12: scenario 8/8 of the Slack live test needed a PIN-gated
 * floor grant and the only path was a terminal command on a laptop. The
 * operator's directive: instar must be completely mobile-compatible — the
 * dashboard is the surface, the PIN is the only thing typed.
 *
 * Pins: (1) the form renders pick-don't-type fields (person picker from the
 * user registry, action + duration dropdowns) on ACTIVE mandates only;
 * (2) the controller refuses to POST without a PIN, sends it once, NEVER
 * retains it; (3) the grant expiry is clamped to the mandate's own expiry so
 * the operator's pick always succeeds; (4) the dashboard's floor-action list
 * cannot drift from the RolePolicy enum; (5) attacker-controlled fields are
 * escaped.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMandates, renderGrants, renderGrantForm, createController } from '../../dashboard/mandates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');
const ROLE_POLICY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/permissions/RolePolicy.ts'), 'utf-8');

const USERS = [
  { slackUserId: 'U_MIA', name: 'Mia Member', orgRole: 'member' },
  { slackUserId: 'U_ADAM', name: 'Adam Admin', orgRole: 'admin' },
];

function activeMandate(over: Record<string, unknown> = {}) {
  return {
    id: 'm-live', scope: 'slack-live-test', agents: ['fp-a', 'fp-b'],
    authorities: [{ action: 'sign-code-review', bounds: {} }],
    author: 'justin', expiresAt: '2999-01-01T00:00:00Z', revoked: null, authorshipValid: true,
    ...over,
  };
}

// ── renderers ──

describe('grant form renderers (pick, don’t type)', () => {
  it('renders a person PICKER from the registry, action + duration dropdowns, PIN, and the Grant button', () => {
    const html = renderGrantForm(activeMandate(), USERS);
    expect(html).toContain('data-grant-user="m-live"');
    expect(html).toContain('<select');
    expect(html).toContain('Mia Member — member');
    expect(html).toContain('value="U_MIA"');
    expect(html).toContain('data-grant-action="m-live"');
    expect(html).toMatch(/value="prod-deploy" selected/);
    expect(html).toContain('data-grant-duration="m-live"');
    expect(html).toContain('1 hour');
    expect(html).toMatch(/data-grant-pin="m-live"[^>]*autocomplete="off"|autocomplete="off"[^>]*data-grant-pin="m-live"/);
    expect(html).toContain('data-grant="m-live"');
  });

  it('falls back to a text input ONLY when the registry offers nobody', () => {
    const empty = renderGrantForm(activeMandate(), []);
    expect(empty).toMatch(/<input type="text"[^>]*data-grant-user="m-live"/);
    const withUsers = renderGrantForm(activeMandate(), USERS);
    expect(withUsers).not.toMatch(/<input type="text"[^>]*data-grant-user/);
  });

  it('the grant form appears on ACTIVE mandates only — never on revoked or expired ones', () => {
    const active = renderMandates([activeMandate()], USERS);
    expect(active).toContain('data-grant="m-live"');
    const revoked = renderMandates([activeMandate({ revoked: { at: 't', reason: 'kill' } })], USERS);
    expect(revoked).not.toContain('data-grant="m-live"');
    const expired = renderMandates([activeMandate({ expiresAt: '2000-01-01T00:00:00Z' })], USERS);
    expect(expired).not.toContain('data-grant="m-live"');
  });

  it('renderGrants lists carried grants with the person’s NAME and marks expired ones', () => {
    const html = renderGrants(activeMandate({
      grants: [
        { floorAction: 'prod-deploy', grantedTo: 'U_MIA', authorizedBy: 'operator (dashboard PIN)', expiresAt: '2999-01-01T00:00:00Z' },
        { floorAction: 'external-send', grantedTo: 'U_GONE', authorizedBy: 'justin', expiresAt: '2000-01-01T00:00:00Z' },
      ],
    }), USERS);
    expect(html).toContain('Mia Member (U_MIA)');
    expect(html).toContain('prod-deploy');
    expect(html).toContain('operator (dashboard PIN)');
    expect(html).toContain('expired');
    expect(html).toContain('U_GONE'); // unknown id still shown verbatim, never hidden
  });

  it('the dashboard floor-action list cannot drift from the RolePolicy enum (set-equality, both directions)', () => {
    // Extract the source enum literally — the dashboard mirrors it by hand,
    // and this pin is what makes that mirroring safe. Set-EQUALITY, not
    // subset: a removed source action must disappear from the form too
    // (a stale extra would mint inert-but-recorded grants).
    const block = ROLE_POLICY_SRC.match(/FLOOR_ACTIONS[^=]*=\s*\[([^\]]+)\]/)?.[1] ?? '';
    const sourceActions = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(sourceActions.length).toBeGreaterThanOrEqual(6);
    const html = renderGrantForm(activeMandate(), USERS);
    const actionSelect = html.match(/data-grant-action="[^"]*">([\s\S]*?)<\/select>/)?.[1] ?? '';
    const formActions = [...actionSelect.matchAll(/value="([a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(formActions).toEqual(sourceActions);
  });

  it('a thrown fetch (network failure) still clears the PIN and surfaces an error', async () => {
    const listEl = fakeListWithGrantForm('m-live', { user: 'U_MIA', pin: '424242' });
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('/grants')) throw new Error('network down');
      if (url.startsWith('/mandate/audit')) return { status: 200, json: async () => ({ entries: [], chain: { ok: true } }) } as any;
      if (url.startsWith('/permissions/users')) return { status: 200, json: async () => ({ users: USERS }) } as any;
      return { status: 200, json: async () => ({ mandates: [activeMandate()] }) } as any;
    };
    const mk = () => ({ innerHTML: '', textContent: '', className: '', value: '', disabled: false, onclick: null });
    const els: any = { list: listEl, audit: mk(), notice: mk(), stamp: mk() };
    const controller = createController({ doc: {} as any, els, fetchImpl });
    await controller.refresh();
    await listEl._btn.onclick();
    expect(els.notice.textContent).toMatch(/request failed/);
    expect(listEl._fields['[data-grant-pin="m-live"]'].value).toBe(''); // cleared on the failure path too
    expect(listEl._btn.disabled).toBe(false);
    controller.stop();
  });

  it('escapes attacker-controlled fields (XSS-safe)', () => {
    const xss = '<img src=x onerror=alert(1)>';
    const form = renderGrantForm(activeMandate({ id: xss }), [{ slackUserId: xss, name: xss, orgRole: xss }]);
    expect(form).not.toContain('<img');
    const grants = renderGrants(activeMandate({
      grants: [{ floorAction: xss, grantedTo: xss, authorizedBy: xss, expiresAt: '2999-01-01T00:00:00Z' }],
    }), []);
    expect(grants).not.toContain('<img');
  });
});

// ── controller ──

type Resp = { status: number; body: unknown };

function fakeListWithGrantForm(id: string, values: { user?: string; action?: string; duration?: string; pin?: string }) {
  const btn: any = { getAttribute: (n: string) => (n === 'data-grant' ? id : null), disabled: false, onclick: null };
  const fields: Record<string, any> = {
    [`[data-grant-user="${id}"]`]: { value: values.user ?? '' },
    [`[data-grant-action="${id}"]`]: { value: values.action ?? 'prod-deploy' },
    [`[data-grant-duration="${id}"]`]: { value: values.duration ?? '60' },
    [`[data-grant-pin="${id}"]`]: { value: values.pin ?? '' },
  };
  return {
    innerHTML: '', textContent: '',
    querySelectorAll: (sel: string) => (sel === '[data-grant]' ? [btn] : []),
    querySelector: (sel: string) => fields[sel] ?? null,
    _btn: btn,
    _fields: fields,
  };
}

function grantController(mandate: Record<string, unknown>, listEl: any, grantResp: Resp) {
  const calls: Array<{ url: string; opts: any }> = [];
  const fetchImpl = async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    let r: Resp;
    if (url.includes('/grants')) r = grantResp;
    else if (url.startsWith('/mandate/audit')) r = { status: 200, body: { entries: [], chain: { ok: true } } };
    else if (url.startsWith('/permissions/users')) r = { status: 200, body: { users: USERS } };
    else r = { status: 200, body: { mandates: [mandate] } };
    return { status: r.status, json: async () => r.body } as any;
  };
  const mk = () => ({ innerHTML: '', textContent: '', className: '', value: '', disabled: false, onclick: null });
  const els: any = { list: listEl, audit: mk(), notice: mk(), stamp: mk() };
  const controller = createController({ doc: {} as any, els, fetchImpl });
  return { controller, els, calls };
}

describe('grant flow controller — the PIN discipline, again', () => {
  it('refuses to grant WITHOUT a PIN — no request is sent', async () => {
    const listEl = fakeListWithGrantForm('m-live', { user: 'U_MIA', pin: '' });
    const { controller, els, calls } = grantController(activeMandate(), listEl, { status: 201, body: {} });
    await controller.refresh();
    await listEl._btn.onclick();
    expect(calls.some((c) => c.url.includes('/grants'))).toBe(false);
    expect(els.notice.textContent).toMatch(/PIN/);
    controller.stop();
  });

  it('grants WITH the PIN once, posts the right payload, then CLEARS the field', async () => {
    const listEl = fakeListWithGrantForm('m-live', { user: 'U_MIA', pin: '424242', duration: '60' });
    const { controller, calls } = grantController(activeMandate(), listEl, { status: 201, body: { granted: true } });
    await controller.refresh();
    await listEl._btn.onclick();
    const grantCall = calls.find((c) => c.url.includes('/grants'));
    expect(grantCall).toBeTruthy();
    expect(grantCall!.url).toBe('/mandate/m-live/grants');
    const payload = JSON.parse(grantCall!.opts.body);
    expect(payload.pin).toBe('424242');
    expect(payload.grants).toHaveLength(1);
    expect(payload.grants[0].floorAction).toBe('prod-deploy');
    expect(payload.grants[0].grantedTo).toBe('U_MIA');
    expect(Date.parse(payload.grants[0].expiresAt)).toBeGreaterThan(Date.now());
    expect(listEl._fields['[data-grant-pin="m-live"]'].value).toBe(''); // the load-bearing assertion
    controller.stop();
  });

  it('clamps the grant expiry to the mandate’s own expiry (a grant can never outlive its mandate)', async () => {
    const mandateExpiry = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min out
    const listEl = fakeListWithGrantForm('m-live', { user: 'U_MIA', pin: '424242', duration: '240' }); // operator picked 4h
    const { controller, calls } = grantController(activeMandate({ expiresAt: mandateExpiry }), listEl, { status: 201, body: {} });
    await controller.refresh();
    await listEl._btn.onclick();
    const payload = JSON.parse(calls.find((c) => c.url.includes('/grants'))!.opts.body);
    expect(payload.grants[0].expiresAt).toBe(new Date(Date.parse(mandateExpiry)).toISOString());
    controller.stop();
  });

  it('surfaces a server refusal (wrong PIN) as a persistent error and still clears the PIN', async () => {
    const listEl = fakeListWithGrantForm('m-live', { user: 'U_MIA', pin: '000000' });
    const { controller, els } = grantController(activeMandate(), listEl, { status: 403, body: { error: 'Incorrect PIN' } });
    await controller.refresh();
    await listEl._btn.onclick();
    expect(els.notice.textContent).toMatch(/Incorrect PIN/);
    expect(els.notice.className).toMatch(/err/);
    expect(listEl._fields['[data-grant-pin="m-live"]'].value).toBe('');
    controller.stop();
  });

  it('a failing /permissions/users never takes down the tab — the form degrades to a text input', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = async (url: string) => {
      calls.push({ url });
      if (url.startsWith('/permissions/users')) return { status: 500, json: async () => ({ error: 'boom' }) } as any;
      if (url.startsWith('/mandate/audit')) return { status: 200, json: async () => ({ entries: [], chain: { ok: true } }) } as any;
      return { status: 200, json: async () => ({ mandates: [activeMandate()] }) } as any;
    };
    const mk = () => ({ innerHTML: '', textContent: '', className: '', value: '', disabled: false, onclick: null, querySelectorAll: () => [], querySelector: () => null });
    const els: any = { list: mk(), audit: mk(), notice: mk(), stamp: mk() };
    const controller = createController({ doc: {} as any, els, fetchImpl });
    await controller.refresh();
    expect(els.list.innerHTML).toContain('data-grant="m-live"');
    expect(els.list.innerHTML).toMatch(/<input type="text"[^>]*data-grant-user/);
    controller.stop();
  });
});

// ── HTML at-rest ──

describe('dashboard: grant form styling present', () => {
  it('carries the grant-row styles (mobile-wrapping flex row)', () => {
    expect(HTML).toContain('.mnd-grant-row');
    expect(HTML).toContain('.mnd-grant-field');
    expect(HTML).toContain('.mnd-grants');
  });
});
