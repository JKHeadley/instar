/** App-first approval discovery never grants authority or hides unconfirmed delivery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildTrustRequests } from '../../dashboard/console/allowed-model.js';
import { renderAllowed } from '../../dashboard/console/allowed.js';
import { trustRequestNeedRows } from '../../dashboard/console/needs-model.js';

const NOW = Date.parse('2026-11-22T23:00:00Z');
const open = (over: Record<string, unknown> = {}) => ({ requestId: 'tr-request', changeKind: 'board-policy', status: 'open', adapter: 'telegram', delivered: false,
  summary: ['Start the waiting Work Board cards.'], expiresAt: '2026-11-23T23:00:00Z', ...over });
const answer = (requests: unknown[], approvalDelivery: unknown = { state: 'accepted', message: 'Open Changes to approve in Instar.' }) => ({ ok: true, data: { requests, approvalDelivery } });
let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.restoreAllMocks(); });

describe('approval continuation is based on current eligibility', () => {
  it('opens the app even when a chat card was delivered earlier', () => {
    const m = buildTrustRequests(answer([open({ delivered: true })]), NOW);
    expect(m.rows[0].continuation).toBe('Open Changes to approve in Instar.');
    expect(m.rows[0].sub).not.toContain('unconfirmed');
  });
  it('keeps uncertain chat evidence visible after the app becomes available', () => {
    const m = buildTrustRequests(answer([open()]), NOW);
    expect(m.rows[0].sub).toContain('Chat delivery is unconfirmed');
    expect(m.rows[0].sub).toContain('Changes to approve');
  });
  it('preserves setup instructions and does not claim approval capability from pairing', () => {
    const message = 'This Mac has no Touch ID. Use your paired iPhone to set up approvals.';
    const res = answer([open({ adapter: 'device' })], { state: 'setup', message });
    expect(buildTrustRequests(res, NOW).rows[0].continuation).toBe(message);
    expect(trustRequestNeedRows(res, NOW)?.[0].sub).toBe('Set up approvals in the Instar app to review this request.');
    expect(trustRequestNeedRows(answer([open()], { state: 'setup', message }), NOW)?.[0].sub)
      .toBe('Set up approvals in the Instar app because chat delivery is unconfirmed.');
  });
  it('does not infer a live app or failed chat delivery from absent availability metadata', () => {
    const r = buildTrustRequests({ ok: true, data: { requests: [open()] } }, NOW).rows[0];
    expect(r.deliveryState).toBe('unknown');
    expect(r.sub).toContain('could not check');
    expect(r.sub).not.toMatch(/failed|delivered to/);
  });
  it('uses a confirmed private chat only when current device availability is none', () => {
    expect(buildTrustRequests(answer([open({ delivered: true })], { state: 'none' }), NOW).rows[0].continuation).toContain('exact request card');
    expect(buildTrustRequests(answer([open()], { state: 'none' }), NOW).rows[0].continuation).toContain('unconfirmed');
    expect(buildTrustRequests(answer([open({ adapter: 'device' })], { state: 'none' }), NOW).rows[0].continuation).toContain('Reconnect');
  });
  it('shows only open, unexpired requests and never turns unreadable input into no requests', () => {
    expect(buildTrustRequests(answer([open(), open({ requestId: 'ended', status: 'consumed' }), open({ requestId: 'expired', expiresAt: '2026-11-20T00:00:00Z' })]), NOW).rows.map(r => r.requestId)).toEqual(['tr-request']);
    expect(buildTrustRequests({ ok: true, data: {} }, NOW).ok).toBe(false);
    expect(buildTrustRequests({ ok: false, reason: 'offline' }, NOW).reason).toBe('offline');
  });
  it('Needs-you retains stable identity and a registered console continuation', () => {
    const rows = trustRequestNeedRows(answer([open()]), NOW);
    expect(rows).toHaveLength(1);
    expect(rows![0].main).toBe('Review how the agent starts work cards');
    expect(buildTrustRequests(answer([open({ changeKind: 'one-action', summary: ['mcp__raw_tool {long:json}'] })]), NOW).rows[0].main).toBe('Review an action the agent wants to take once');
    expect(buildTrustRequests(answer([open({ changeKind: 'trust-grant' })]), NOW).rows[0].main).toBe('Review what the agent may do');
    expect(buildTrustRequests(answer([open({ changeKind: 'future-kind' })]), NOW).rows[0].main).toBe('Review a requested change');
    expect(rows![0]).toMatchObject({ key: 'need:trust:tr-request', action: { kind: 'href', href: '#/settings/allowed?s=approvals&request=tr-request' } });
    expect(trustRequestNeedRows({ ok: false, reason: 'offline' }, NOW)).toBeNull();
  });
});

describe('Allowed approval section', () => {
  it('scrolls only to the exact approval from a Needs You link without granting it', async () => {
    dom = new JSDOM('<main></main>', { url: 'http://localhost/dashboard/console/#/settings/allowed?s=approvals&request=second' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location });
    const scroll = vi.fn(function (this: HTMLElement) { return this.dataset.approvalRequest; });
    dom.window.HTMLElement.prototype.scrollIntoView = scroll;
    const post = vi.fn();
    const get = vi.fn(async (path: string) => path === '/trust/requests'
      ? answer([open({ expiresAt: '2099-11-23T23:00:00Z' }), open({ requestId: 'second', expiresAt: '2099-11-23T23:00:00Z' })])
      : { ok: false, reason: 'not configured' });
    await renderAllowed(dom.window.document.querySelector('main')!, { get, post });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveReturnedWith('second');
    expect(post).not.toHaveBeenCalled();
  });

  it('renders the whole change as text and offers guidance without granting approval', async () => {
    dom = new JSDOM('<body><main></main></body>', { url: 'http://localhost/dashboard/console/#/settings/allowed' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
      HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0) });
    dom.window.scrollTo = vi.fn();
    const post = vi.fn();
    const get = vi.fn(async (path: string) => path === '/trust/requests'
      ? answer([open({ expiresAt: '2099-11-23T23:00:00Z', summary: ['<img src=x onerror=alert(1)>', 'The complete second summary line.'] })])
      : { ok: false, reason: 'not configured' });
    const main = dom.window.document.querySelector('main')!;
    await renderAllowed(main, { get, post });
    const section = main.querySelector('#sec-approvals')!;
    expect(section.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(section.textContent).toContain('The complete second summary line.');
    expect(section.querySelector('img')).toBeNull();
    const button = section.querySelector('button')!;
    expect(button.textContent).toBe('How to approve');
    expect(section.querySelector('.need-title')!.textContent).toBe('Review how the agent starts work cards');
    expect(button.compareDocumentPosition(section.querySelector('.approval-summary')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button.click();
    expect(dom.window.document.body.textContent).toContain('Permissions screen');
    expect(dom.window.document.body.textContent).toContain('This console page does not approve');
    expect(post).not.toHaveBeenCalled();
  });
});
