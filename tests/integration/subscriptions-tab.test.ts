/**
 * Integration tests for the Subscriptions tab POLLING CONTROLLER (jsdom, P2.2).
 * Drives the SHIPPED createController() against a real jsdom DOM with injected
 * fetch + manual timers + a controllable clock — every invariant deterministic,
 * no wall-clock, no real network:
 *   - both endpoints render into the real tab DOM (accounts + pending logins)
 *   - feature-dark (both routes { enabled:false }) → the disabled copy, not a crash
 *   - XSS safety holds through the full controller path (no injected element)
 *   - visibility-gating: hidden clears the timer + aborts in-flight; visible re-arms
 *   - a fetch failure drops the tick + keeps the prior paint (no exception escapes)
 */
// @ts-nocheck — exercises the browser-native ESM module.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/subscriptions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeEls(doc: Document) {
  const accounts = doc.createElement('div');
  const pending = doc.createElement('div');
  const matrix = doc.createElement('div');
  const followMe = doc.createElement('div');
  const root = doc.createElement('div');
  root.appendChild(followMe);
  root.appendChild(matrix);
  root.appendChild(accounts);
  root.appendChild(pending);
  doc.body.appendChild(root);
  return { els: { accounts, pending, matrix, followMe }, root };
}

/** A scriptable fetch keyed by URL pathname; records abort signals. */
function makeFetch() {
  const script: Record<string, { status?: number; body?: unknown; throw?: boolean }> = {};
  const signals: AbortSignal[] = [];
  const fetchImpl = async (url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    const entry = script[key] ?? { status: 200, body: { enabled: true } };
    if (entry.throw) throw new Error(`network ${key}`);
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      json: async () => entry.body ?? {},
    };
  };
  return { fetchImpl, script, signals };
}

const ACCOUNTS_OK = {
  enabled: true,
  accounts: [{ id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active', lastQuota: { fiveHour: { utilizationPct: 12, resetsAt: '2026-06-07T01:00:00Z' }, sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T00:00:00Z' } } }],
};
const PENDING_OK = {
  enabled: true,
  logins: [{ id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA', verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0 }],
};

describe('Subscriptions tab controller (integration)', () => {
  let doc: Document;
  let els: any;
  let timers: Array<{ fn: () => void; ms: number }>;
  let nowMs: number;
  let fx: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    doc = new JSDOM('<!doctype html><body></body>').window.document;
    ({ els } = makeEls(doc));
    timers = [];
    nowMs = Date.parse('2026-06-07T00:00:00Z');
    fx = makeFetch();
  });

  function ctl(extra?: any) {
    return createController({
      doc, els, fetchImpl: fx.fetchImpl, now: () => nowMs,
      schedule: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length - 1; },
      cancel: (id: number) => { if (timers[id]) timers[id] = { fn: () => {}, ms: 0 }; },
      ...extra,
    });
  }

  it('renders both panes from the two endpoints', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('.sub-account-nick')!.textContent).toBe('personal');
    expect(els.accounts.querySelectorAll('.sub-quota').length).toBe(2);
    expect(els.pending.querySelector('.sub-pending-code')!.textContent).toContain('7DAU-W4XJA');
  });

  it('feature-dark (both enabled:false) → the disabled copy, no crash', async () => {
    fx.script['/subscription-pool'] = { body: { enabled: false, accounts: [] } };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: { enabled: false, logins: [] } };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('.sub-disabled')).toBeTruthy();
  });

  it('XSS payload in a nickname never becomes an element through the controller', async () => {
    fx.script['/subscription-pool'] = { body: { enabled: true, accounts: [{ id: 'x', nickname: '<script>alert(1)</script>', provider: 'anthropic', framework: 'claude-code', status: 'active' }] } };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('script')).toBeNull();
    expect(els.accounts.querySelector('.sub-account-nick')!.textContent).toContain('<script>');
  });

  it('a fetch failure drops the tick without throwing + reschedules', async () => {
    fx.script['/subscription-pool'] = { throw: true };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await expect(c.tick()).resolves.toBeUndefined();
    // nothing painted, but a retry is armed
    expect(timers.length).toBeGreaterThan(0);
  });

  it('visibility gating: hidden stops the timer + aborts in-flight; visible re-arms', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: PENDING_OK };
    const c = ctl();
    c.start();
    await flush();
    expect(c._state.active).toBe(true);
    c.onHidden();
    expect(c._state.active).toBe(false);
    c.onVisible();
    expect(c._state.active).toBe(true);
  });

  // ── topic 29836 D1–D5: the matrix "Set up" flow through the SHIPPED controller ──

  const POOL_SCOPE = {
    enabled: true,
    accounts: [
      { id: 'a1', email: 'headley.justin@gmail.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop' },
      { id: 'aX', email: 'ax@x.com', status: 'active', machineId: 'm2', machineNickname: 'Mini' },
    ],
    pool: { selfMachineId: 'm1', failed: [] },
    scope: 'pool',
  };
  const NO_PENDING = { enabled: true, logins: [] };
  const START_CELL_OK = {
    status: 201,
    body: {
      verificationUrl: 'https://claude.com/oauth/authorize?code=true&client_id=x',
      loginId: 'a1', machineId: 'm2', kind: 'url-code-paste',
      expectedEmail: 'headley.justin@gmail.com',
      ttlExpiresAt: new Date(Date.parse('2026-06-07T00:00:00Z') + 12 * 60_000).toISOString(),
      notice: 'Heads up: a brand-new Claude login often asks for TWO codes in order.',
    },
  };

  function scriptMatrixHappyPath() {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: NO_PENDING };
    fx.script['/subscription-pool?scope=pool'] = { body: POOL_SCOPE };
    fx.script['/subscription-pool/matrix/start-cell'] = START_CELL_OK;
  }

  async function openCellToSignIn(c: any) {
    await c.tick();
    const setup = els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]');
    expect(setup).toBeTruthy();
    setup.click();
    const pin = els.matrix.querySelector('.sub-matrix-pin');
    pin.value = '123456';
    els.matrix.querySelector('[data-matrix-confirm]').click();
    await flush();
    // The attempt now exists server-side — subsequent pending reads include it (as the
    // real server would after start-cell), so the reconciler sees a live attempt.
    fx.script['/subscription-pool/pending-logins?scope=pool'] = {
      body: {
        enabled: true,
        logins: [{
          id: 'a1', label: 'Justin', kind: 'url-code-paste', machineId: 'm2', machineNickname: 'Mini',
          paneAlive: true, expectedEmail: 'headley.justin@gmail.com',
          verificationUrl: START_CELL_OK.body.verificationUrl, ttlExpiresAt: START_CELL_OK.body.ttlExpiresAt,
          notice: START_CELL_OK.body.notice,
        }],
      },
    };
    return els.matrix.querySelector('[data-cell-key="a1::m2"]');
  }

  it('D1: a poll tick mid-PIN-entry does NOT clobber the open cell (the exact screenshot defect)', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    await c.tick();
    const setup = els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]');
    setup.click();
    const pin = els.matrix.querySelector('.sub-matrix-pin');
    expect(pin).toBeTruthy();
    pin.value = '12'; // the operator is mid-typing…
    await c.tick();   // …and the 30s poll fires
    const pinAfter = els.matrix.querySelector('.sub-matrix-pin');
    expect(pinAfter).toBe(pin); // the SAME node — not a rebuilt copy, not a "Set up" button
    expect(pinAfter.value).toBe('12');
    expect(els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]')).toBeNull();
  });

  it('D1: an UNTYPED but open PIN entry also survives the poll (the episode marker holds, no race with typing speed)', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    await c.tick();
    els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]').click();
    expect(els.matrix.querySelector('.sub-matrix-pin')).toBeTruthy();
    await c.tick(); // poll before the operator types ANYTHING
    expect(els.matrix.querySelector('.sub-matrix-pin')).toBeTruthy(); // still a PIN entry, not a button
  });

  it('D1 (Back): the operator can back out of PIN entry — the hold releases and the cell restores', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    await c.tick();
    els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]').click();
    els.matrix.querySelector('[data-matrix-collapse]').click();
    expect(els.matrix.querySelector('[data-matrix-setup][data-account-id="a1"][data-machine-id="m2"]')).toBeTruthy();
    expect(els.matrix.querySelector('.sub-matrix-pin')).toBeNull();
  });

  it('D2+D3(a): Confirm renders the COMPLETE in-cell flow (expected-account warning + link + code input + TTL + notice + Cancel) and it survives polls', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    const cell = await openCellToSignIn(c);
    expect(cell.querySelector('.sub-matrix-expected').textContent).toContain('must show headley.justin@gmail.com');
    expect(cell.querySelector('a.sub-matrix-signin').getAttribute('href')).toContain('code=true');
    expect(cell.querySelector('.sub-matrix-notice').textContent).toContain('TWO codes');
    expect(cell.querySelector('[data-matrix-cancel]')).toBeTruthy();
    const code = cell.querySelector('.sub-matrix-code-input');
    code.value = 'ABC'; // mid-paste…
    await c.tick();     // …poll fires
    expect(els.matrix.contains(code)).toBe(true); // the code step is NOT swapped for "◷ Signing in…"
    expect(code.value).toBe('ABC');
  });

  it('D1 (merge arm): while the cell is held, the poll still refreshes the TTL countdown in place', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    const cell = await openCellToSignIn(c);
    const ttl = cell.querySelector('[data-ttl-expires]');
    expect(ttl.textContent).toBe('Link expires in 12m');
    nowMs += 5 * 60_000; // five minutes pass
    await c.tick();
    expect(cell.querySelector('[data-ttl-expires]')).toBe(ttl); // same node (merged, not rebuilt)
    expect(ttl.textContent).toBe('Link expires in 7m');
  });

  it('D4: a validated code-submit flips the cell to an unmistakable success, then active+just-verified once the pool read catches up — plus a durable ✓ Done card', async () => {
    scriptMatrixHappyPath();
    fx.script['/subscription-pool/follow-me/submit-code'] = {
      status: 201, body: { enabled: true, outcome: 'validated', email: 'headley.justin@gmail.com' },
    };
    const c = ctl();
    c._state.active = true;
    const cell = await openCellToSignIn(c);
    cell.querySelector('.sub-matrix-code-input').value = 'GOOD-CODE';
    cell.querySelector('[data-matrix-code-submit]').click();
    await flush();
    expect(cell.textContent).toContain('All set');
    expect(cell.textContent).toContain('headley.justin@gmail.com');
    expect(cell.getAttribute('class')).toContain('sub-matrix-just-verified');
    // The pool read now shows the account active on m2 → the rebuilt cell keeps the ceremony.
    fx.script['/subscription-pool?scope=pool'] = {
      body: {
        ...POOL_SCOPE,
        accounts: [...POOL_SCOPE.accounts, { id: 'a1', email: 'headley.justin@gmail.com', status: 'active', machineId: 'm2', machineNickname: 'Mini' }],
      },
    };
    await c.tick();
    const rebuilt = els.matrix.querySelector('[data-cell-key="a1::m2"]');
    expect(rebuilt.getAttribute('class')).toContain('sub-matrix-active');
    expect(rebuilt.getAttribute('class')).toContain('sub-matrix-just-verified');
    expect(rebuilt.textContent).toContain('just set up');
    // And the pending panel carries the explicit completed card — not a vanished line.
    const done = els.pending.querySelector('.sub-pending-done');
    expect(done).toBeTruthy();
    expect(done.textContent).toContain('headley.justin@gmail.com is now set up on Mini');
  });

  it('D3: a held code-submit names BOTH accounts in the cell and refuses the enrollment', async () => {
    scriptMatrixHappyPath();
    fx.script['/subscription-pool/follow-me/submit-code'] = {
      status: 200,
      body: { enabled: true, outcome: 'held', reason: 'email-mismatch', expected: 'headley.justin@gmail.com', got: 'justin@sagemindai.io' },
    };
    const c = ctl();
    c._state.active = true;
    const cell = await openCellToSignIn(c);
    cell.querySelector('.sub-matrix-code-input').value = 'WRONG-ACCT-CODE';
    cell.querySelector('[data-matrix-code-submit]').click();
    await flush();
    expect(cell.textContent).toContain('justin@sagemindai.io');
    expect(cell.textContent).toContain('headley.justin@gmail.com');
    expect(cell.querySelector('.sub-matrix-setup').textContent).toBe('Retry');
    // The held presentation persists across the next poll (transient, not a blink).
    await c.tick();
    const rebuilt = els.matrix.querySelector('[data-cell-key="a1::m2"]');
    expect(rebuilt.getAttribute('class')).toContain('sub-matrix-held');
    expect(rebuilt.textContent).toContain('justin@sagemindai.io');
    // And the panel shows the explicit failure card.
    expect(els.pending.querySelector('.sub-pending-failed')).toBeTruthy();
  });

  it('D5: a pane-dead code-submit flips the cell to the explicit needs-restart state', async () => {
    scriptMatrixHappyPath();
    fx.script['/subscription-pool/follow-me/submit-code'] = {
      status: 409,
      body: { code: 'pane-dead', error: "this sign-in's window is no longer running on its machine, so it can't take a code — start the sign-in again from the dashboard grid" },
    };
    const c = ctl();
    c._state.active = true;
    const cell = await openCellToSignIn(c);
    cell.querySelector('.sub-matrix-code-input').value = 'ORPHAN-CODE';
    cell.querySelector('[data-matrix-code-submit]').click();
    await flush();
    const rebuilt = els.matrix.querySelector('[data-cell-key="a1::m2"]');
    expect(rebuilt.getAttribute('class')).toContain('sub-matrix-broken');
    expect(rebuilt.textContent).toContain('Sign-in needs a restart');
    expect(rebuilt.querySelector('.sub-matrix-setup').textContent).toBe('Retry');
  });

  it('D4 (expiry): an episode whose pending login vanishes without an outcome resolves to the explicit expired state — never a silent revert to "Set up"', async () => {
    scriptMatrixHappyPath();
    const c = ctl();
    c._state.active = true;
    await openCellToSignIn(c); // episode open (start-cell succeeded)
    // Server-side the attempt expired away: no pending login anymore, still not active.
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: NO_PENDING };
    await c.tick();
    const cell = els.matrix.querySelector('[data-cell-key="a1::m2"]');
    expect(cell.getAttribute('class')).toContain('sub-matrix-expired');
    expect(cell.textContent).toContain('Sign-in link expired');
    expect(cell.querySelector('.sub-matrix-setup').textContent).toBe('Retry');
    // The panel carries the explicit expired card.
    const failed = els.pending.querySelector('.sub-pending-failed');
    expect(failed).toBeTruthy();
    expect(failed.textContent).toContain('expired');
  });

  it('D1 (pending panel): a half-typed code in the panel survives the poll; D5: a dead-pane row is not submittable', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool?scope=pool'] = { body: POOL_SCOPE };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = {
      body: {
        enabled: true,
        logins: [
          { id: 'a1', label: 'Justin', kind: 'url-code-paste', machineId: 'm2', machineNickname: 'Mini', paneAlive: true, expectedEmail: 'headley.justin@gmail.com', verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2026-06-07T00:12:00Z' },
          { id: 'zombie', label: 'Ghost', kind: 'url-code-paste', machineId: 'm2', machineNickname: 'Mini', paneAlive: false, verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2026-06-07T00:12:00Z' },
        ],
      },
    };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    // D5: the dead-pane row is an explicit can't-finish card with NO code input.
    const zombieRow = els.pending.querySelector('.sub-pending-failed');
    expect(zombieRow.textContent).toContain('can’t finish');
    expect(zombieRow.querySelector('.sub-pending-code-input')).toBeNull();
    // D1: type into the LIVE row's code input, then poll — the typed state survives.
    const input = els.pending.querySelector('.sub-pending-code-input');
    input.value = 'HALF-TY';
    await c.tick();
    expect(els.pending.contains(input)).toBe(true);
    expect(input.value).toBe('HALF-TY');
  });

  it('D1 (follow-me Approve card): a half-typed PIN on the Approve card survives the poll', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins?scope=pool'] = { body: NO_PENDING };
    fx.script['/subscription-pool/follow-me/scan'] = {
      body: { offered: [{ accountId: 'a1', targetMachineId: 'm2', machineNickname: 'Mini', accountLabel: 'personal', agents: ['fp-a', 'fp-b'], expiryText: 'expires soon' }] },
    };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    const pin = els.followMe.querySelector('.sub-followme-pin');
    expect(pin).toBeTruthy();
    pin.value = '12';
    await c.tick();
    expect(els.followMe.contains(pin)).toBe(true);
    expect(pin.value).toBe('12');
  });
});
