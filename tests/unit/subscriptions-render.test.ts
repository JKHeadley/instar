/**
 * Unit tests for the Subscriptions tab's pure functions + renderers (P2.2).
 * Exercises the SHIPPED module (dashboard/subscriptions.js) against a real jsdom
 * DOM and asserts the load-bearing safety contract:
 *   - every dynamic value is sanitized (NFKC fold, control/bidi/chrome-glyph
 *     strip, grapheme cap) before the DOM
 *   - all dynamic writes are textContent only → no injected element survives
 *   - the only dynamic attribute (quota-bar width) comes from a clamped 0–100 int
 *   - a verification URL is rendered as TEXT, never a live <a href>
 */
// @ts-nocheck — the module is browser-native ESM (.js), no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  sanitizeForDisplay,
  clampPct,
  friendlyStatus,
  friendlyProvider,
  countdown,
  relativeAge,
  quotaBar,
  renderAccounts,
  renderPendingLogins,
  renderDisabled,
  renderAccountMatrix,
  buildMatrixModel,
  renderOutcomeCard,
} from '../../dashboard/subscriptions.js';

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document;
});

const NOW = Date.parse('2026-06-07T00:00:00Z');

describe('sanitizeForDisplay', () => {
  it('null/undefined → empty string', () => {
    expect(sanitizeForDisplay(null)).toBe('');
    expect(sanitizeForDisplay(undefined)).toBe('');
  });
  it('NFKC-folds full-width confusables', () => {
    expect(sanitizeForDisplay('ＡＢＣ')).toBe('ABC');
  });
  it('strips bidi-control + C0 controls', () => {
    expect(sanitizeForDisplay('a‮bc')).toBe('abc');
  });
  it('strips chrome glyphs (so a code can never impersonate a bar/marker)', () => {
    expect(sanitizeForDisplay('●→✓ ok')).toBe(' ok');
  });
  it('caps a long code', () => {
    expect(sanitizeForDisplay('x'.repeat(200), 'code').length).toBeLessThanOrEqual(48);
  });
});

describe('clampPct', () => {
  it('clamps to 0–100 and rounds', () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
    expect(clampPct(71.6)).toBe(72);
    expect(clampPct('nope')).toBe(0);
    expect(clampPct(NaN)).toBe(0);
  });
});

describe('countdown', () => {
  it('future instants render h/m', () => {
    expect(countdown('2026-06-07T02:15:00Z', NOW)).toBe('2h 15m');
  });
  it('past instants render the expired word', () => {
    expect(countdown('2026-06-06T23:00:00Z', NOW)).toBe('expired');
    expect(countdown('2026-06-06T23:00:00Z', NOW, { expiredWord: 'resetting' })).toBe('resetting');
  });
  it('invalid → empty', () => {
    expect(countdown('not-a-date', NOW)).toBe('');
  });
});

describe('friendly wording', () => {
  it('maps status + provider to plain words', () => {
    expect(friendlyStatus('rate-limited')).toBe('At its limit');
    expect(friendlyStatus('weird')).toBe('Unknown');
    expect(friendlyProvider('anthropic')).toBe('Claude');
    expect(friendlyProvider('openai')).toBe('Codex');
  });
});

describe('quotaBar', () => {
  it('fill width is a clamped integer percent (only dynamic attribute)', () => {
    const bar = quotaBar(doc, '5-hour', 171.6, '2026-06-07T02:00:00Z', NOW);
    const fill = bar.querySelector('.sub-quota-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%'); // clamped from 171.6
    expect(bar.querySelector('.sub-quota-pct')!.textContent).toContain('100% used');
    expect(bar.querySelector('.sub-quota-pct')!.textContent).toContain('resets in 2h');
  });
});

describe('renderAccounts', () => {
  it('empty → friendly empty message', () => {
    const t = el();
    renderAccounts(doc, t, [], NOW);
    expect(t.querySelector('.sub-empty')).toBeTruthy();
  });
  it('renders nickname, status, and two quota bars', () => {
    const t = el();
    renderAccounts(doc, t, [{
      id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active', email: 'justin@sagemindai.io',
      lastQuota: { fiveHour: { utilizationPct: 10, resetsAt: '2026-06-07T01:00:00Z' }, sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T00:00:00Z' } },
    }], NOW);
    expect(t.querySelector('.sub-account-nick')!.textContent).toBe('personal');
    expect(t.querySelector('.sub-account-email')!.textContent).toBe('justin@sagemindai.io');
    expect(t.querySelector('.sub-account-status')!.textContent).toBe('Active');
    expect(t.querySelectorAll('.sub-quota').length).toBe(2);
  });
  it('renders a Fable 5 bar when the fable window is present', () => {
    const t = el();
    renderAccounts(doc, t, [{
      id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active',
      lastQuota: {
        fiveHour: { utilizationPct: 10, resetsAt: '2026-06-07T01:00:00Z' },
        sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T00:00:00Z' },
        fable: { utilizationPct: 100, resetsAt: '2026-07-15T00:00:00Z' },
      },
    }], NOW);
    const bars = t.querySelectorAll('.sub-quota');
    expect(bars.length).toBe(3);
    const labels = Array.from(t.querySelectorAll('.sub-quota-label')).map(n => n.textContent);
    expect(labels).toContain('Fable 5');
  });
  it('renders a Fable 5 bar even when it is the only quota window', () => {
    const t = el();
    renderAccounts(doc, t, [{
      id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active',
      lastQuota: { fable: { utilizationPct: 36, resetsAt: '2026-07-18T00:00:00Z' } },
    }], NOW);
    expect(t.querySelectorAll('.sub-quota').length).toBe(1);
    expect(t.querySelector('.sub-quota-label')!.textContent).toBe('Fable 5');
    expect(t.querySelector('.sub-account-noquota')).toBeNull();
  });
  it('shows the no-quota message when no windows at all (fable included) are present', () => {
    const t = el();
    renderAccounts(doc, t, [{
      id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active',
      lastQuota: {},
    }], NOW);
    expect(t.querySelector('.sub-account-noquota')).not.toBeNull();
  });
  it('a malicious nickname survives only as inert text (no element injected)', () => {
    const t = el();
    renderAccounts(doc, t, [{ id: 'x', nickname: '<img src=x onerror=alert(1)>', provider: 'anthropic', framework: 'claude-code', status: 'active' }], NOW);
    expect(t.querySelector('img')).toBeNull(); // textContent only — no element parsed
    expect(t.querySelector('.sub-account-nick')!.textContent).toContain('<img');
  });
  it('no quota → "No quota reading yet"', () => {
    const t = el();
    renderAccounts(doc, t, [{ id: 'a', nickname: 'n', provider: 'anthropic', framework: 'claude-code', status: 'warming' }], NOW);
    expect(t.querySelector('.sub-account-noquota')).toBeTruthy();
  });
  it('shows a token-health line when the account was auto-refreshed', () => {
    const t = el();
    renderAccounts(doc, t, [{
      id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active',
      lastRefreshAt: new Date(NOW - 5 * 60_000).toISOString(),
    }], NOW);
    const line = t.querySelector('.sub-account-refresh');
    expect(line).toBeTruthy();
    expect(line!.textContent).toContain('auto-refreshed');
    expect(line!.textContent).toContain('5m ago');
  });
  it('omits the token-health line when never refreshed', () => {
    const t = el();
    renderAccounts(doc, t, [{ id: 'a', nickname: 'n', provider: 'anthropic', framework: 'claude-code', status: 'active' }], NOW);
    expect(t.querySelector('.sub-account-refresh')).toBeNull();
  });
  it('marks the in-use account with a badge and a distinct card class', () => {
    const t = el();
    const accounts = [
      { id: 'gmail', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', status: 'active' },
      { id: 'dawn', nickname: 'SageMind - Dawn', provider: 'anthropic', framework: 'claude-code', status: 'active' },
    ];
    renderAccounts(doc, t, accounts, NOW, 'dawn');
    const inUse = t.querySelector('.sub-account-inuse');
    expect(inUse).toBeTruthy();
    expect(inUse!.querySelector('.sub-account-inuse-badge')!.textContent).toContain('In use');
    expect(t.querySelectorAll('.sub-account-inuse').length).toBe(1); // exactly one card marked
  });
  it('shows no in-use badge when the active account id is null/unknown', () => {
    const t = el();
    renderAccounts(doc, t, [{ id: 'gmail', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', status: 'active' }], NOW, null);
    expect(t.querySelector('.sub-account-inuse-badge')).toBeNull();
  });
});

describe('relativeAge', () => {
  it('formats coarse past ages and tolerates junk', () => {
    expect(relativeAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(relativeAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago');
    expect(relativeAge(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h ago');
    expect(relativeAge(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d ago');
    expect(relativeAge('not-a-date', NOW)).toBe('');
  });
});

describe('renderPendingLogins', () => {
  it('empty → friendly empty message', () => {
    const t = el();
    renderPendingLogins(doc, t, [], NOW);
    expect(t.querySelector('.sub-empty')).toBeTruthy();
  });
  it('renders a tap-simple card: headline + a "Sign in" link to the trusted provider URL + code + TTL (no reissue noise)', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA',
      verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 2,
    }], NOW);
    expect(t.querySelector('.sub-pending-headline')!.textContent).toContain('Sign in to finish setting up');
    // A trusted provider host (auth.openai.com) → a real tappable "Sign in" link.
    const a = t.querySelector('a.sub-pending-signin');
    expect(a).toBeTruthy();
    expect(a!.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(a!.getAttribute('rel')).toContain('noopener');
    expect(a!.textContent).toBe('Sign in');
    expect(t.querySelector('.sub-pending-code')!.textContent).toContain('7DAU-W4XJA');
    expect(t.querySelector('.sub-pending-ttl')!.textContent).toBe('Link expires in 12m');
    // The confusing "re-issued N times" noise is gone.
    expect(t.querySelector('.sub-pending-reissue')).toBeNull();
  });
  it('a url-code-paste login renders a code paste-back field + Submit (ws52-code-paste-back)', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'adriana', label: 'adriana', kind: 'url-code-paste', machineId: 'm_mini', machineNickname: 'Mac Mini',
      verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true&client_id=x', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0,
    }], NOW);
    expect(t.querySelector('.sub-pending-codehint')!.textContent).toContain('paste the code');
    const input = t.querySelector('input.sub-pending-code-input');
    expect(input).toBeTruthy();
    const submit = t.querySelector('button.sub-pending-code-submit[data-submit-code]');
    expect(submit!.textContent).toBe('Submit code');
    // the row carries the non-sensitive ids the submit handler needs
    const row = t.querySelector('.sub-pending');
    expect(row!.getAttribute('data-login-id')).toBe('adriana');
    expect(row!.getAttribute('data-machine-id')).toBe('m_mini');
  });

  it('a device-code login does NOT render the paste-back field (only url-code-paste does)', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA',
      verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0,
    }], NOW);
    expect(t.querySelector('.sub-pending-code-input')).toBeNull();
    expect(t.querySelector('[data-submit-code]')).toBeNull();
  });

  it('a javascript: URL renders as inert text, not an anchor', () => {
    const t = el();
    renderPendingLogins(doc, t, [{ id: 'x', label: 'l', kind: 'url-code-paste', verificationUrl: 'javascript:alert(1)', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0 }], NOW);
    expect(t.querySelector('a')).toBeNull();
    expect(t.querySelector('.sub-pending-url')!.textContent).toContain('javascript:alert(1)');
  });
  it('renders the flow notice (two-code heads-up) when present', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'sagemind-1', label: 'SageMind - Justin', kind: 'url-code-paste',
      verificationUrl: 'https://claude.com/oauth/authorize?code=abc',
      notice: 'Heads up: a brand-new Claude login often asks for TWO codes in order — first an email-verification code, then the sign-in code.',
      ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0,
    }], NOW);
    expect(t.querySelector('.sub-pending-notice')!.textContent).toContain('TWO codes');
  });
  it('omits the notice element when there is none', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA',
      verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0,
    }], NOW);
    expect(t.querySelector('.sub-pending-notice')).toBeNull();
  });
});

describe('renderDisabled', () => {
  it('shows the friendly not-set-up copy in the accounts pane + clears pending', () => {
    const accounts = el();
    const pending = el();
    pending.appendChild(doc.createElement('div'));
    renderDisabled(doc, { accounts, pending });
    expect(accounts.querySelector('.sub-disabled')).toBeTruthy();
    expect(pending.children.length).toBe(0);
  });
});

// ── account-machine-matrix (account × machine grid) ─────────────────────────
describe('renderAccountMatrix', () => {
  // a1 is active on machine m1 (reachable); m2 is offline (in pool.failed, no account rows).
  const poolScope = {
    enabled: true,
    accounts: [
      { id: 'a1', email: 'a1@x.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop', remote: false },
    ],
    pool: { selfMachineId: 'm1', failed: [{ machineId: 'm2', error: 'timeout' }] },
    scope: 'pool',
  };
  // A pending login for (a2, m1) → that cell is in-progress.
  const pendingScope = { enabled: true, logins: [{ id: 'a2', machineId: 'm1' }] };

  it('renders ✓ active for an (account,machine) with an active pool row', () => {
    const t = el();
    renderAccountMatrix(doc, t, poolScope, pendingScope, {});
    // The a1 × m1 cell is active (✓ Active), not a button.
    const cell = t.querySelector('.sub-matrix-active');
    expect(cell).toBeTruthy();
    expect(cell!.textContent).toContain('✓');
    expect(cell!.querySelector('.sub-matrix-setup')).toBeNull();
  });

  it('renders a "Set up" button for a genuinely-empty (reachable) cell', () => {
    // Two reachable machines m1, m1b; account a1 is active only on m1 → a1 × m1b is empty.
    const t = el();
    const pool = {
      enabled: true,
      accounts: [
        { id: 'a1', email: 'a1@x.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop' },
        { id: 'aX', email: 'aX@x.com', status: 'active', machineId: 'm1b', machineNickname: 'Mini' },
      ],
      pool: { selfMachineId: 'm1', failed: [] },
      scope: 'pool',
    };
    renderAccountMatrix(doc, t, pool, { enabled: true, logins: [] }, {});
    const setupBtns = t.querySelectorAll('.sub-matrix-setup');
    const a1OnMini = Array.from(setupBtns).find((b) => b.getAttribute('data-account-id') === 'a1' && b.getAttribute('data-machine-id') === 'm1b');
    expect(a1OnMini).toBeTruthy();
    expect(a1OnMini!.textContent).toBe('Set up');
  });

  it('renders an offline/disabled column for a pool.failed machine — no fabricated ✓', () => {
    const t = el();
    renderAccountMatrix(doc, t, poolScope, pendingScope, {});
    // m2 is in pool.failed → its header is marked offline and its cells read "unknown".
    const offHead = t.querySelector('.sub-matrix-off');
    expect(offHead).toBeTruthy();
    expect(offHead!.textContent).toContain('offline');
    // The a1 × m2 cell is offline-unknown, never ✓ (no fabricated active state for a dark peer).
    const offCells = t.querySelectorAll('.sub-matrix-offline');
    expect(offCells.length).toBeGreaterThan(0);
    Array.from(offCells).forEach((c) => {
      expect(c.textContent).not.toContain('✓');
      expect(c.querySelector('.sub-matrix-setup')).toBeNull();
    });
  });

  it('renders an in-progress (◷) cell for a pending login on a reachable machine', () => {
    const t = el();
    renderAccountMatrix(doc, t, poolScope, pendingScope, {});
    // a2 × m1 has a pending login → in-progress.
    const cell = t.querySelector('.sub-matrix-in-progress');
    expect(cell).toBeTruthy();
    expect(cell!.textContent).toContain('◷');
    expect(cell!.querySelector('.sub-matrix-setup')).toBeNull();
  });

  it('#1428: a `cancelled` transient SUPPRESSES a still-cached pending login so the cell resets immediately', () => {
    // A needs-reauth account with a still-cached in-flight login: after a confirmed
    // cancel, the optimistic `cancelled` transient must drop the stale flow AT ONCE
    // (not after the next ~40s poll) — the cell falls through to its true underlying
    // "Sign in" state instead of rendering ◷ Signing in.
    const pool = {
      enabled: true,
      accounts: [{ id: 'a3', email: 'a3@x.com', status: 'needs-reauth', machineId: 'm1', machineNickname: 'Laptop' }],
      pool: { selfMachineId: 'm1', failed: [] },
      scope: 'pool',
    };
    const pending = { enabled: true, logins: [{ id: 'a3', machineId: 'm1', verificationUrl: 'https://x/y', ttlExpiresAt: Date.now() + 60000 }] };

    // Without the transient: the cached pending login renders the in-flight flow.
    const before = el();
    renderAccountMatrix(doc, before, pool, pending, {});
    expect(before.querySelector('.sub-matrix-in-progress'), 'stale flow shows without the transient').toBeTruthy();

    // With the `cancelled` transient: the flow is gone; the cell is the clean "Sign in".
    const after = el();
    renderAccountMatrix(doc, after, pool, pending, { 'a3::m1': { state: 'cancelled', at: Date.now() } });
    expect(after.querySelector('.sub-matrix-in-progress'), 'no in-flight flow after cancel').toBeNull();
    const btn = Array.from(after.querySelectorAll('.sub-matrix-setup'))
      .find((b) => b.getAttribute('data-account-id') === 'a3' && b.getAttribute('data-machine-id') === 'm1');
    expect(btn, 'the cell reset to an actionable Sign-in button').toBeTruthy();
    expect(btn!.textContent).toBe('Sign in');
  });

  it('#1428: buildMatrixModel drops a stale pending login under a `cancelled` transient (poll stays authority)', () => {
    // The model-level proof: with the transient the cell is NOT in-progress; the next
    // poll clears the transient (tested in the controller) so a genuinely-failed cancel
    // re-derives in-progress from the fresh server state.
    const held = buildMatrixModel(poolScope, pendingScope, { 'a2::m1': { state: 'cancelled', at: Date.now() } });
    const cell = held.rows.flatMap((r) => r.cells).find((c) => c.accountId === 'a2' && c.machineId === 'm1');
    expect(cell!.state).not.toBe('in-progress');
    // negative control: WITHOUT the transient the same cached login IS in-progress.
    const live = buildMatrixModel(poolScope, pendingScope, {});
    const liveCell = live.rows.flatMap((r) => r.cells).find((c) => c.accountId === 'a2' && c.machineId === 'm1');
    expect(liveCell!.state).toBe('in-progress');
  });

  it('renders a "Sign in" button (with the "Needs sign-in" word above it) for a needs-reauth cell', () => {
    // a3 exists on a reachable machine but its login expired (status needs-reauth) → the cell must
    // be ACTIONABLE: the status word AND a "Sign in" button carrying the (account, machine) ids.
    const t = el();
    const pool = {
      enabled: true,
      accounts: [
        { id: 'a3', email: 'a3@x.com', status: 'needs-reauth', machineId: 'm1', machineNickname: 'Laptop' },
      ],
      pool: { selfMachineId: 'm1', failed: [] },
      scope: 'pool',
    };
    renderAccountMatrix(doc, t, pool, { enabled: true, logins: [] }, {});
    const cell = t.querySelector('.sub-matrix-needs-reauth');
    expect(cell).toBeTruthy();
    // The status word still shows…
    expect(cell!.textContent).toContain('Needs sign-in');
    // …AND there is a real, actionable button wired to the same start-cell flow as "Set up".
    const btn = cell!.querySelector('.sub-matrix-setup');
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toBe('Sign in');
    expect(btn!.getAttribute('data-matrix-setup')).toBe('1');
    expect(btn!.getAttribute('data-account-id')).toBe('a3');
    expect(btn!.getAttribute('data-machine-id')).toBe('m1');
  });

  it('buildMatrixModel pivots on (accountId, machineId) and marks offline machines', () => {
    const model = buildMatrixModel(poolScope, pendingScope, {});
    expect(model.machines.find((m: any) => m.machineId === 'm2')!.offline).toBe(true);
    expect(model.machines.find((m: any) => m.machineId === 'm1')!.offline).toBe(false);
    const a1m1 = model.rows.find((r: any) => r.account.accountId === 'a1')!.cells.find((c: any) => c.machineId === 'm1');
    expect(a1m1.state).toBe('active');
    const a1m2 = model.rows.find((r: any) => r.account.accountId === 'a1')!.cells.find((c: any) => c.machineId === 'm2');
    expect(a1m2.state).toBe('offline');
  });

  // ── topic 29836 D1–D5: the cell carries the complete flow + explicit terminal states ──

  it('every cell carries a stable data-cell-key (the F9 hold/merge identity)', () => {
    const t = el();
    renderAccountMatrix(doc, t, poolScope, pendingScope, {});
    const cells = t.querySelectorAll('.sub-matrix-cell');
    expect(cells.length).toBeGreaterThan(0);
    Array.from(cells).forEach((c) => expect(c.getAttribute('data-cell-key')).toContain('::'));
  });

  it('D2: an in-progress cell with a full pending-login record renders the COMPLETE flow (link + expected email + code input + TTL + notice + Cancel)', () => {
    const t = el();
    const pending = {
      enabled: true,
      logins: [{
        id: 'a2', machineId: 'm1', kind: 'url-code-paste', paneAlive: true,
        verificationUrl: 'https://claude.com/oauth/authorize?code=true&client_id=x',
        expectedEmail: 'headley.justin@gmail.com',
        notice: 'Heads up: a brand-new Claude login often asks for TWO codes in order.',
        ttlExpiresAt: '2026-06-07T00:12:00Z',
      }],
    };
    renderAccountMatrix(doc, t, poolScope, pending, {});
    const cell = t.querySelector('.sub-matrix-in-progress')!;
    // D3(a): the expected-account warning sits BESIDE the sign-in link.
    expect(cell.querySelector('.sub-matrix-expected')!.textContent).toContain('headley.justin@gmail.com');
    expect(cell.querySelector('.sub-matrix-expected')!.textContent).toContain('Switch account');
    const a = cell.querySelector('a.sub-matrix-signin')!;
    expect(a.getAttribute('href')).toBe('https://claude.com/oauth/authorize?code=true&client_id=x');
    expect(cell.querySelector('input.sub-matrix-code-input')).toBeTruthy();
    const submit = cell.querySelector('[data-matrix-code-submit]')!;
    expect(submit.getAttribute('data-login-id')).toBe('a2');
    expect(submit.getAttribute('data-machine-id')).toBe('m1');
    expect(cell.querySelector('.sub-matrix-notice')!.textContent).toContain('TWO codes');
    const ttl = cell.querySelector('.sub-matrix-ttl')!;
    expect(ttl.getAttribute('data-ttl-expires')).toBe('2026-06-07T00:12:00Z');
    expect(cell.querySelector('[data-matrix-cancel]')).toBeTruthy();
  });

  it('D5: an in-progress record whose pane is DEAD (paneAlive:false) renders the explicit needs-restart state with a Retry — never a code input', () => {
    const t = el();
    const pending = {
      enabled: true,
      logins: [{ id: 'a2', machineId: 'm1', kind: 'url-code-paste', paneAlive: false, verificationUrl: 'https://claude.com/oauth' }],
    };
    renderAccountMatrix(doc, t, poolScope, pending, {});
    const cell = t.querySelector('.sub-matrix-broken')!;
    expect(cell).toBeTruthy();
    expect(cell.textContent).toContain('Sign-in needs a restart');
    expect(cell.textContent).toContain('window closed');
    expect(cell.querySelector('.sub-matrix-code-input')).toBeNull(); // NOT submittable
    const btn = cell.querySelector('.sub-matrix-setup')!;
    expect(btn.textContent).toBe('Retry');
  });

  it('D3: a held cell with the gate verdict detail names BOTH accounts in plain language', () => {
    const t = el();
    const transient = {
      'a1::m1': { state: 'held', expected: 'headley.justin@gmail.com', got: 'justin@sagemindai.io', reason: 'email-mismatch', at: Date.now() },
    };
    renderAccountMatrix(doc, t, poolScope, { enabled: true, logins: [] }, transient);
    const cell = t.querySelector('.sub-matrix-held')!;
    const detail = cell.querySelector('.sub-matrix-held-detail')!;
    expect(detail.textContent).toContain('justin@sagemindai.io');
    expect(detail.textContent).toContain('headley.justin@gmail.com');
    expect(cell.querySelector('.sub-matrix-setup')!.textContent).toBe('Retry');
  });

  it('D4: an expired transient renders the explicit expired state with a Retry', () => {
    const t = el();
    const pool = {
      enabled: true,
      accounts: [
        { id: 'a1', email: 'a1@x.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop' },
        { id: 'aX', email: 'aX@x.com', status: 'active', machineId: 'm1b', machineNickname: 'Mini' },
      ],
      pool: { selfMachineId: 'm1', failed: [] },
    };
    const transient = { 'a1::m1b': { state: 'expired', at: Date.now() } };
    renderAccountMatrix(doc, t, pool, { enabled: true, logins: [] }, transient);
    const cell = t.querySelector('.sub-matrix-expired')!;
    expect(cell.textContent).toContain('Sign-in link expired');
    expect(cell.querySelector('.sub-matrix-setup')!.textContent).toBe('Retry');
  });

  it('D4: just-verified bridges — a client-verified enrollment shows the verified ceremony even before the pool read catches up', () => {
    const t = el();
    const pool = {
      enabled: true,
      accounts: [
        { id: 'a1', email: 'a1@x.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop' },
        { id: 'aX', email: 'aX@x.com', status: 'active', machineId: 'm1b', machineNickname: 'Mini' },
      ],
      pool: { selfMachineId: 'm1', failed: [] },
    };
    // a1 on m1b: server still says empty, but the client just observed a validated completion.
    const transient = { 'a1::m1b': { state: 'just-verified', at: Date.now() } };
    renderAccountMatrix(doc, t, pool, { enabled: true, logins: [] }, transient);
    const cell = t.querySelector('.sub-matrix-just-verified')!;
    expect(cell).toBeTruthy();
    expect(cell.textContent).toContain('Set up complete');
    expect(cell.querySelector('.sub-matrix-setup')).toBeNull(); // never blinks back to "Set up"
  });

  it('D4: an ACTIVE cell with a fresh just-verified transient carries the highlight class + "just set up" wording', () => {
    const t = el();
    const transient = { 'a1::m1': { state: 'just-verified', at: Date.now() } };
    renderAccountMatrix(doc, t, poolScope, { enabled: true, logins: [] }, transient);
    const cell = t.querySelector('.sub-matrix-active')!;
    expect(cell.getAttribute('class')).toContain('sub-matrix-just-verified');
    expect(cell.textContent).toContain('just set up');
  });
});

// ── topic 29836 D3/D4/D5: pending-panel wording, liveness, and outcome cards ──
describe('renderPendingLogins — expected-account, liveness, wording floors, outcome cards', () => {
  it('D3(a): renders the expected-account warning before the link when expectedEmail is present', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'a2', label: 'Justin', kind: 'url-code-paste', expectedEmail: 'headley.justin@gmail.com',
      verificationUrl: 'https://claude.com/oauth/authorize?code=true', ttlExpiresAt: '2026-06-07T00:12:00Z',
    }], NOW);
    const warn = t.querySelector('.sub-pending-expected')!;
    expect(warn.textContent).toContain('must show headley.justin@gmail.com');
    expect(warn.textContent).toContain('Switch account');
  });

  it('omits the expected-account warning when there is no expectedEmail', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA',
      verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z',
    }], NOW);
    expect(t.querySelector('.sub-pending-expected')).toBeNull();
  });

  it('D5 wording floors: the headline uses the account EMAIL over the internal label, and the machine NICKNAME — never a raw m_<hex> id', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'justin-gmail', label: 'Justin', kind: 'url-code-paste',
      expectedEmail: 'headley.justin@gmail.com',
      machineId: 'm_cc2ec651a91f03f85abb19bfe5e7e8f7', machineNickname: 'Laptop',
      verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2026-06-07T00:12:00Z',
    }], NOW);
    const headline = t.querySelector('.sub-pending-headline')!.textContent!;
    expect(headline).toContain('headley.justin@gmail.com');
    expect(headline).toContain('Laptop');
    expect(headline).not.toContain('m_cc2ec651a91f03f85abb19bfe5e7e8f7');
  });

  it('D5 wording floor: with NO nickname, a raw m_<hex> machine id is suppressed — never shown to the operator', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'justin-gmail', label: 'Justin', kind: 'url-code-paste',
      expectedEmail: 'headley.justin@gmail.com', machineId: 'm_cc2ec651a91f03f85abb19bfe5e7e8f7',
      verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2026-06-07T00:12:00Z',
    }], NOW);
    expect(t.textContent).not.toContain('m_cc2ec651a91f03f85abb19bfe5e7e8f7');
  });

  it('D5: a pending login whose pane is DEAD renders the explicit can\'t-finish card — no link, no code input', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'justin-gmail', label: 'Justin', kind: 'url-code-paste', paneAlive: false,
      expectedEmail: 'headley.justin@gmail.com', machineNickname: 'Laptop', machineId: 'm_x',
      verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2026-06-07T00:12:00Z',
    }], NOW);
    const row = t.querySelector('.sub-pending-failed')!;
    expect(row.textContent).toContain('can’t finish');
    expect(row.textContent).toContain('Laptop');
    expect(row.querySelector('a')).toBeNull();
    expect(row.querySelector('.sub-pending-code-input')).toBeNull();
    // The restart guidance points at an affordance that actually exists on this surface.
    expect(row.textContent).toContain('grid');
    expect(row.textContent).not.toContain('Approve');
  });

  it('D4: outcome cards render explicit done/failed/expired presentations (never a vanishing line)', () => {
    const t = el();
    renderPendingLogins(doc, t, [], NOW, [
      { kind: 'validated', accountId: 'a1', machineId: 'm1', machineNickname: 'Mini', email: 'headley.justin@gmail.com', at: NOW },
      { kind: 'held', accountId: 'a2', machineId: 'm1', expected: 'a@x.com', got: 'b@x.com', reason: 'email-mismatch', at: NOW },
      { kind: 'expired', accountId: 'a3', machineId: 'm1', machineNickname: 'Mini', at: NOW },
    ]);
    const done = t.querySelector('.sub-pending-done')!;
    expect(done.textContent).toContain('Done');
    expect(done.textContent).toContain('headley.justin@gmail.com is now set up on Mini');
    const failed = t.querySelectorAll('.sub-pending-failed');
    expect(failed.length).toBe(2);
    expect(failed[0].textContent).toContain('b@x.com'); // both accounts named
    expect(failed[0].textContent).toContain('a@x.com');
    expect(failed[1].textContent).toContain('expired');
    // With outcome cards present, the bare "no logins" empty line is omitted.
    expect(t.querySelector('.sub-empty')).toBeNull();
  });

  it('renderOutcomeCard sanitizes hostile outcome content into inert text', () => {
    const card = renderOutcomeCard(doc, {
      kind: 'validated', accountId: '<img src=x onerror=alert(1)>', machineId: 'm1', at: NOW,
    });
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('<img');
  });
});

function el(): HTMLElement {
  return doc.createElement('div');
}
