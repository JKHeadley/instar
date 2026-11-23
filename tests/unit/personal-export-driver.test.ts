import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PAGE_SAFETY_SCRIPT } from '../../src/data/accountPageSafetyScript.js';
import { requestPersonalExport, observePersonalExport, type PersonalExportTarget } from '../../src/import/personalExportDriver.js';

const target: PersonalExportTarget = { provider: 'chatgpt', profileId: 'fixture-owner', expectedEmail: 'owner@example.org', workspace: 'personal' };

/** Exercise the actual browser recipe in a DOM. Neither the helpers nor any real account are opened. */
function setup(source: PersonalExportTarget = target) {
  const claude = source.provider === 'claude';
  const url = new URL(claude ? 'https://claude.ai/settings/privacy' : 'https://chatgpt.com/#settings/DataControls');
  const dom = new JSDOM(`<main>
    <h2>${claude ? 'Privacy' : 'Data controls'}</h2>
    <div data-testid="account-email">owner@example.org</div>
    <button data-testid="workspace-switcher-trigger" data-workspace-type="personal">Personal</button>
    <button id="open">${claude ? 'Export data' : 'Export'}</button>
    <p>ordinary message from owner@example.org about my personal account ${'🗨️'.repeat(2100)}</p></main>`, { url: url.href });
  const doc = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return [1]; } });
  const events: string[] = [];
  const state = { ready: true, reloads: 0, acknowledge: true, interrupted: false };
  const location = { origin: url.origin, href: url.href, pathname: url.pathname, hash: url.hash, search: '', reload() { state.reloads++; } };
  doc.getElementById('open')!.addEventListener('click', () => {
    events.push('open');
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Export your data?</h2><button>Confirm export</button>';
    doc.body.appendChild(dialog);
    dialog.querySelector('button')!.addEventListener('click', () => {
      events.push('confirm');
      dialog.remove();
      if (state.acknowledge) doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<div role="status">Your export is in progress.</div>');
    });
  });
  const options = {
    browserDir: '/fixture/browser', wait: async () => undefined,
    reserveSubmission: vi.fn(async () => { events.push('reserve'); return state.ready; }),
    invoke: vi.fn(async (exe: string, [id, code, origin, offset]: readonly string[]) => {
      if (path.basename(exe) === 'chrome-launch.sh') return 'launched';
      expect(id).toBe(source.profileId);
      expect(origin).toBe(url.origin);
      if (code === 'String(performance.timeOrigin)') return String(100_000 + state.reloads);
      const readOrSignal = new Function('document', 'location', 'getComputedStyle', 'return (' + ACCOUNT_PAGE_SAFETY_SCRIPT + ')')(
        doc, location, () => ({ visibility: 'visible' }));
      if (code === '--read-page') return readOrSignal(true, Number(offset));
      const advisory = readOrSignal(false, 0);
      if (advisory) return JSON.stringify(advisory);
      if (state.interrupted && events.includes('reserve')) throw new Error('private-page-content');
      return new Function('document', 'location', 'getComputedStyle', 'return ' + code)(doc, location, () => ({ visibility: 'visible' }));
    }),
  };
  return { doc, events, state, options, location };
}

describe('requesting a personal export in its dedicated browser', () => {
  it.each(['claude','chatgpt'] as const)('persists intent before the first click, then checks %s acknowledgment after reload', async provider => {
    const selection = { ...target, provider };
    const f = setup(selection);
    expect(await requestPersonalExport(selection, f.options)).toEqual({ status: 'acknowledged' });
    expect(f.events).toEqual(['reserve','open','confirm']);
    expect(f.state.reloads).toBe(1);
  });
  it.each(['wrong email','named team','missing selected workspace','missing account field','editable email','duplicate export button','chat URL'])('refuses %s before reserving or clicking', async variant => {
    const f = setup();
    if (variant === 'wrong email') f.doc.querySelector('[data-testid="account-email"]')!.textContent = 'other@example.org';
    if (variant === 'named team') f.doc.querySelector('[data-workspace-type]')!.setAttribute('data-workspace-type', 'business');
    if (variant === 'missing selected workspace') f.doc.querySelector('[data-workspace-type]')!.remove();
    if (variant === 'missing account field') f.doc.querySelector('[data-testid="account-email"]')!.remove();
    if (variant === 'editable email') f.doc.querySelector('[data-testid="account-email"]')!.outerHTML = '<input data-testid="account-email" value="owner@example.org">';
    if (variant === 'duplicate export button') f.doc.querySelector('main')!.insertAdjacentHTML('beforeend','<button>Export</button>');
    if (variant === 'chat URL') f.location.pathname = '/c/a-chat';
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'needs-attention', reason: 'page-unverified' });
    expect(f.events).toEqual([]);
  });
  it('does not re-submit a reserved job or obtain acknowledgment from the click alone', async () => {
    const f = setup();
    f.state.ready = false;
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'already-reserved' });
    f.state.ready = true;
    f.state.acknowledge = false;
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'outcome-unknown' });
    expect(await observePersonalExport(target,f.options)).toEqual({ status: 'outcome-unknown' });
    expect(f.events).toEqual(['reserve','reserve','open','confirm']);
  });
  it('keeps ambiguous delivery and process errors free of private output', async () => {
    const f = setup(); f.state.interrupted = true;
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'outcome-unknown' });
    expect(f.events).toEqual(['reserve']);
  });
  it('checks the page again after reservation and blocks when the account changes', async () => {
    const f = setup();
    f.options.reserveSubmission.mockImplementation(async () => {
      f.doc.querySelector('[data-testid="account-email"]')!.textContent = 'other@example.org'; return true;
    });
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'outcome-unknown' });
    expect(f.events).toEqual([]);
  });
  it.each(['cancel', 'authority withdrawn', 'account switch', 'workspace switch', 'recovery screen'])('stops on %s between the first click and confirmation', async variant => {
    const f = setup();
    const controller = new AbortController();
    let authorized = true;
    f.doc.getElementById('open')!.addEventListener('click', () => {
      if (variant === 'cancel') controller.abort();
      if (variant === 'authority withdrawn') authorized = false;
      if (variant === 'account switch') f.doc.querySelector('[data-testid="account-email"]')!.textContent = 'other@example.org';
      if (variant === 'workspace switch') f.doc.querySelector('[data-workspace-type]')!.setAttribute('data-workspace-type', 'team');
      if (variant === 'recovery screen') f.doc.querySelector('[role="dialog"]')!.insertAdjacentHTML('afterbegin','<h2>Recovery codes</h2>');
    });
    expect(await requestPersonalExport(target, { ...f.options, signal: controller.signal, authorized:() => authorized })).toEqual({ status: 'outcome-unknown' });
    expect(f.events).toEqual(['reserve', 'open']);
  });
  it('ignores account fields and workspace markers inserted inside a user-editable fragment', async () => {
    const f = setup();
    const fake = f.doc.createElement('div');
    fake.setAttribute('contenteditable','true');
    fake.append(f.doc.querySelector('[data-testid="account-email"]')!, f.doc.querySelector('[data-workspace-type]')!);
    f.doc.querySelector('main')!.append(fake);
    expect(await requestPersonalExport(target, f.options)).toEqual({ status: 'needs-attention', reason: 'page-unverified' });
    expect(f.events).toEqual([]);
  });
  it('rejects a stale pending indicator if no fresh navigation occurred', async () => {
    const f = setup();
    f.location.reload = () => {};
    expect(await requestPersonalExport(target, f.options)).toEqual({ status: 'outcome-unknown' });
    expect(f.events).toEqual(['reserve', 'open', 'confirm']);
  });
  it('pauses on an inconsistent multi-part read or an already aborted operation', async () => {
    const f = setup();
    const original = f.options.invoke.getMockImplementation()!;
    f.options.invoke.mockImplementation(async (exe, args) => {
      const result = await original(exe, args);
      if (args[1] === '--read-page' && Number(args[3]) > 0) {
        return JSON.stringify({ ...JSON.parse(result), pageFingerprint: 'different page' });
      }
      return result;
    });
    expect(await requestPersonalExport(target, f.options)).toEqual({ status: 'needs-attention', reason: 'browser-unavailable' });
    expect(await requestPersonalExport(target, { ...f.options, signal: AbortSignal.abort() }))
      .toEqual({ status: 'needs-attention', reason: 'cancelled' });
    expect(f.events).toEqual([]);
  });
  it('does not treat an already-pending export as one it just requested', async () => {
    const f = setup();
    f.doc.querySelector('main')!.insertAdjacentHTML('beforeend','<div role="status">Your export is in progress.</div>');
    expect(await requestPersonalExport(target,f.options)).toEqual({ status: 'needs-attention', reason:'existing-request' });
    expect(await observePersonalExport(target,f.options)).toEqual({ status:'acknowledged' });
    expect(f.events).toEqual([]);
  });
  it.each(['default','/tmp/profile','--new'])('rejects unsafe profile %s before launching', async profileId => {
    const f = setup();
    expect(await requestPersonalExport({ ...target, profileId },f.options)).toEqual({ status:'needs-attention', reason:'invalid-target' });
    expect(f.options.invoke).not.toHaveBeenCalled();
  });
});
