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
  quotaBar,
  renderAccounts,
  renderPendingLogins,
  renderDisabled,
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
});

describe('renderPendingLogins', () => {
  it('empty → friendly empty message', () => {
    const t = el();
    renderPendingLogins(doc, t, [], NOW);
    expect(t.querySelector('.sub-empty')).toBeTruthy();
  });
  it('renders code + url-as-text + TTL + reissue count; never a live href', () => {
    const t = el();
    renderPendingLogins(doc, t, [{
      id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA',
      verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 2,
    }], NOW);
    expect(t.querySelector('.sub-pending-code')!.textContent).toContain('7DAU-W4XJA');
    expect(t.querySelector('.sub-pending-url')!.textContent).toContain('auth.openai.com');
    expect(t.querySelector('a')).toBeNull(); // URL is TEXT, never a live link
    expect(t.querySelector('.sub-pending-ttl')!.textContent).toBe('expires in 12m');
    expect(t.querySelector('.sub-pending-reissue')!.textContent).toContain('2 times');
  });
  it('a javascript: URL renders as inert text, not an anchor', () => {
    const t = el();
    renderPendingLogins(doc, t, [{ id: 'x', label: 'l', kind: 'url-code-paste', verificationUrl: 'javascript:alert(1)', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0 }], NOW);
    expect(t.querySelector('a')).toBeNull();
    expect(t.querySelector('.sub-pending-url')!.textContent).toContain('javascript:alert(1)');
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

function el(): HTMLElement {
  return doc.createElement('div');
}
