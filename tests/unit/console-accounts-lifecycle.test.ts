// @ts-nocheck — the console modules are browser-native JavaScript.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderAccounts } from '../../dashboard/console/accounts.js';
import { createLifecycle } from '../../dashboard/console/page-lifecycle.js';
import { closeSheet, forgetOperatorSession, sheet } from '../../dashboard/console/ui.js';

const start = '/subscription-pool/matrix/start-cell';
const cancel = '/subscription-pool/follow-me/cancel';
const submit = '/subscription-pool/follow-me/submit-code';
const repair = '/subscription-relogin/repair-cell';
const configure = '/subscription-relogin/configure-pool';
const startResult = { verificationUrl: 'https://signin.example.test/fixture', loginId: 'fixture-login' };
const unlockResult = { operatorSessionToken: 'fixture-session', operatorSessionExpiresAt: '2030-01-01T00:00:00Z' };
let dom, main, life, ctx;

function reply(body = {}) {
  return { ok: true, status: 200, json: async () => body };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function account(nickname = 'Fixture Account') {
  return {
    id: 'fixture-account', nickname, email: 'fixture@example.test', framework: 'claude-code',
    status: 'needs-reauth', machineId: 'fixture-studio', machineNickname: 'Fixture Studio',
    lastQuota: { measuredAt: new Date().toISOString(), sevenDay: {
      utilizationPct: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    } },
  };
}
function reads(relogin = {}, row = account()) {
  return vi.fn(async (path) => ({
    ok: true,
    data: path.startsWith('/subscription-pool?')
      ? { enabled: true, accounts: [row], pool: { failed: [] } }
      : path.startsWith('/subscription-relogin?')
        ? { enabled: true, episodes: [{ id: 'fixture-owner-step', accountId: row.id, machineId: row.machineId, state: 'waiting-operator-only' }], blockers: [], ...relogin }
        : path === '/pool' ? { machines: [] } : {},
  }));
}
function transport(responses) {
  const requests = vi.fn(async (path, options) => {
    if (path === '/dashboard/unlock-check') return await (responses[path] ?? reply({ accepted: true }));
    if (Object.hasOwn(responses, path)) return await responses[path];
    if (path.startsWith('/subscription-pool/follow-me/completion?')) return await responses.completion;
    throw new Error(`Unexpected fixture request: ${options?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', requests);
  return requests;
}
function click(text, root = document) {
  const button = [...root.querySelectorAll('button')].find((el) => el.textContent === text);
  expect(button, text).toBeTruthy();
  button.click();
}
function submitPin() {
  document.querySelector('.pin-input').value = '000000';
  document.querySelector('.pin-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}
async function startSignIn() {
  click('Sign in', main);
  await settle();
  submitPin();
  await settle();
}
function leaveAccounts() {
  life.dispose();
  closeSheet();
  const next = document.createElement('main');
  next.textContent = 'Conversations';
  main.replaceWith(next);
  sheet({ title: 'Current conversation details' }, 'Current page');
}
function expectNextDialog() {
  expect(document.querySelector('main').textContent).toBe('Conversations');
  expect(document.querySelector('.sheet-title')?.textContent).toBe('Current conversation details');
}
function writes(fetch) {
  return fetch.mock.calls.filter(([, opts]) => opts?.method === 'POST').map(([path]) => path);
}
function useAutoRepair() {
  const get = reads({ config: {
    machineId: 'fixture-studio', machineNickname: 'Fixture Studio', mode: 'approval',
    revision: 'fixture-revision', verifiedPoolEmails: ['fixture@example.test'],
  } });
  return renderAccounts(main, { ...ctx, get }).then(() => {
    const include = document.querySelector('#sec-auto-repair input');
    if (!include.checked) include.click();
    click('Turn on for ticked machines', main);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid/dashboard/console/#/capacity/accounts?view=sign-in', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'location', 'localStorage']) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
  main = document.querySelector('main');
  life = createLifecycle();
  ctx = life.begin('capacity/accounts');
});
afterEach(async () => {
  await settle();
  life.dispose();
  closeSheet();
  forgetOperatorSession();
  dom.window.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Accounts action dialog ownership', () => {
  it('keeps the next page dialog when an approved sign-in starts after navigation', async () => {
    const pending = deferred();
    const fetch = transport({ [start]: pending.promise });
    await renderAccounts(main, { ...ctx, get: reads() });
    await startSignIn();
    expect(writes(fetch)).toEqual([start]);
    expect(JSON.parse(fetch.mock.calls.find(([path]) => path === start)[1].body)).toEqual({
      accountId: 'fixture-account', machineId: 'fixture-studio', pin: '000000',
    });
    leaveAccounts();
    pending.resolve(reply(startResult));
    await settle();
    expectNextDialog();
    expect(document.querySelector('.signin-link')).toBeNull();
    expect(writes(fetch)).toEqual([start]);
  });

  it('keeps the next page dialog when the approved cancellation close timer fires', async () => {
    const fetch = transport({ [start]: reply(startResult), [cancel]: reply() });
    await renderAccounts(main, { ...ctx, get: reads() });
    await startSignIn();
    click('Cancel this sign-in');
    await settle();
    leaveAccounts();
    await settle(850);
    expectNextDialog();
    expect(writes(fetch)).toEqual([start, cancel]);
  });

  it('closes its own cancelled sign-in and refreshes the current list', async () => {
    const fetch = transport({ [start]: reply(startResult), [cancel]: reply() });
    const get = reads();
    await renderAccounts(main, { ...ctx, get });
    await startSignIn();
    click('Cancel this sign-in');
    await settle(850);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(get.mock.calls.filter(([path]) => path !== '/quota-pacing')).toHaveLength(8);
    expect(get.mock.calls.filter(([path]) => path === '/quota-pacing')).toHaveLength(0);
    expect(writes(fetch)).toEqual([start, cancel]);
  });

  it('submits a code and completes the open sign-in while refreshing its own page', async () => {
    const fetch = transport({
      [start]: reply(startResult),
      [submit]: reply({ outcome: 'submitted' }),
      completion: reply({ completion: { state: 'done', email: 'fixture@example.test' } }),
    });
    await renderAccounts(main, { ...ctx, get: reads() });
    await startSignIn();
    document.querySelector('[aria-label="Sign-in code"]').value = 'fixture-code';
    click('Send the code');
    await settle(2000);
    expect(document.querySelector('.signin-progress-title').textContent).toContain('Signed in as fixture@example.test');
    click('Done');
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(writes(fetch)).toEqual([start, submit]);
  });

  it('does not open a PIN dialog when the unlock check returns after navigation', async () => {
    const pending = deferred();
    const fetch = transport({ '/dashboard/unlock-check': pending.promise });
    await renderAccounts(main, { ...ctx, get: reads() });
    click('Sign in', main);
    leaveAccounts();
    pending.resolve(reply({ accepted: true }));
    await settle();
    expectNextDialog();
    expect(writes(fetch)).toEqual([]);
  });

  it('does not replace another Accounts dialog when an older unlock check returns', async () => {
    location.hash = '#/capacity/accounts';
    const pending = deferred();
    const fetch = transport({ '/dashboard/unlock-check': pending.promise });
    await renderAccounts(main, { ...ctx, get: reads() });
    main.querySelector('.acct-row').click();
    click('Sign in', document.querySelector('[role=dialog]'));
    closeSheet();
    sheet({ title: 'Another account' }, 'Account detail');
    pending.resolve(reply({ accepted: true }));
    await settle();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Another account');
    expect(writes(fetch)).toEqual([]);
  });

  it('waits for the latest PIN check when account actions overlap', async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    await renderAccounts(main, { ...ctx, get: reads() });
    click('Sign in', main);
    click('Sign in', main);
    first.resolve(reply({ accepted: true }));
    await settle();
    expect(document.querySelector('.pin-input')).toBeNull();
    second.resolve(reply({ accepted: true }));
    await settle();
    expect(document.querySelector('.pin-input')).toBeTruthy();
  });

  it('keeps the next dialog and starts no repair after a dismissed PIN unlock returns', async () => {
    const pending = deferred();
    const fetch = transport({ '/dashboard/unlock': pending.promise });
    await useAutoRepair();
    await settle();
    submitPin();
    expect(writes(fetch)).toEqual(['/dashboard/unlock']);
    const pinPanel = document.querySelector('[role=dialog]');
    leaveAccounts();
    expect(pinPanel.isConnected).toBe(false);
    pending.resolve(reply(unlockResult));
    await settle();
    expect(writes(fetch)).toEqual(['/dashboard/unlock']);
    expectNextDialog();
  });

  it('preserves the configure POST but keeps its timer from closing a replacement Accounts dialog', async () => {
    const fetch = transport({
      '/dashboard/unlock': reply(unlockResult),
      [configure]: reply({ results: [{ ok: true, machineId: 'fixture-studio', mode: 'unattended' }] }),
    });
    await useAutoRepair();
    await settle();
    submitPin();
    await settle();
    expect(document.querySelector('.action-status').textContent).toBe('Done.');
    sheet({ title: 'Another account' }, 'Account detail');
    await settle(30_000);
    expect(document.querySelector('.sheet-title').textContent).toBe('Another account');
    expect(writes(fetch)).toEqual(['/dashboard/unlock', configure]);
  });

  it('keeps the next page dialog after the repair-cell request completed', async () => {
    location.hash = '#/capacity/accounts';
    const fetch = transport({ '/dashboard/unlock': reply(unlockResult), [repair]: reply() });
    const episodes = [{ id: 'fixture-episode', machineId: 'fixture-studio', accountId: 'fixture-account', state: 'failed' }];
    await renderAccounts(main, { ...ctx, get: reads({ episodes }) });
    main.querySelector('.acct-row').click();
    click('Try again', document.querySelector('[role=dialog]'));
    await settle();
    submitPin();
    await settle();
    expect(document.querySelector('.action-status').textContent).toContain('The repair is running');
    leaveAccounts();
    await settle(2000);
    expectNextDialog();
    expect(writes(fetch)).toEqual(['/dashboard/unlock', repair]);
  });

  it('allows the repair already sent before navigation to complete without opening a dialog', async () => {
    location.hash = '#/capacity/accounts';
    const pending = deferred();
    const fetch = transport({ '/dashboard/unlock': reply(unlockResult), [repair]: pending.promise });
    const episodes = [{ id: 'fixture-episode', machineId: 'fixture-studio', accountId: 'fixture-account', state: 'failed' }];
    await renderAccounts(main, { ...ctx, get: reads({ episodes }) });
    main.querySelector('.acct-row').click();
    click('Try again', document.querySelector('[role=dialog]'));
    await settle();
    submitPin();
    await settle();
    expect(writes(fetch)).toEqual(['/dashboard/unlock', repair]);
    leaveAccounts();
    pending.resolve(reply());
    await settle(3000);
    expectNextDialog();
    expect(writes(fetch)).toEqual(['/dashboard/unlock', repair]);
  });

  it('discards a completed poll after navigation and does not start another read', async () => {
    const pending = deferred();
    const fetch = transport({ [start]: reply(startResult), [submit]: reply({ outcome: 'submitted' }), completion: pending.promise });
    const get = reads();
    await renderAccounts(main, { ...ctx, get });
    await startSignIn();
    document.querySelector('[aria-label="Sign-in code"]').value = 'fixture-code';
    click('Send the code');
    await settle(2000);
    expect(fetch.mock.calls.filter(([path]) => path.includes('/completion?'))).toHaveLength(1);
    leaveAccounts();
    pending.resolve(reply({ completion: { state: 'done' } }));
    await settle(4000);
    expectNextDialog();
    expect(get.mock.calls.filter(([path]) => path !== '/quota-pacing')).toHaveLength(4);
    expect(get.mock.calls.filter(([path]) => path === '/quota-pacing')).toHaveLength(0);
    expect(fetch.mock.calls.filter(([path]) => path.includes('/completion?'))).toHaveLength(1);
  });

  it('keeps the visible account button usable during a scheduled refresh of the same page', async () => {
    const pending = deferred();
    const get = reads();
    transport({});
    await renderAccounts(main, { ...ctx, get });
    const next = life.begin('capacity/accounts');
    const refresh = renderAccounts(main, { ...next, get: async (path) => {
      if (path.startsWith('/subscription-pool?')) await pending.promise;
      return get(path);
    } });
    click('Sign in', main);
    await settle();
    expect(document.querySelector('.pin-input')).toBeTruthy();
    pending.resolve();
    await refresh;
    expect(document.querySelector('.pin-input')).toBeTruthy();
  });

  it('does not let a slower initial read overwrite a newer render in the same visit', async () => {
    location.hash = '#/capacity/accounts';
    const pending = deferred();
    const old = reads({}, account('Old Account'));
    const slow = renderAccounts(main, { ...ctx, get: async (path) => {
      if (path.startsWith('/subscription-pool?')) await pending.promise;
      return old(path);
    } });
    await renderAccounts(main, { ...ctx, get: reads({}, account('Current Account')) });
    pending.resolve();
    await slow;
    expect(main.textContent).toContain('Current Account');
    expect(main.textContent).not.toContain('Old Account');
  });
});
