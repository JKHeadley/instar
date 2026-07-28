/**
 * Dashboard UX Standard F9 floor — "a background refresh never clobbers an open
 * interaction" (docs/specs/dashboard-ux-standard.md, topic 29836 case study D1).
 *
 * Exercises the SHIPPED interaction-hold primitives in dashboard/subscriptions.js:
 *   - hasOpenInteraction: an in-progress episode (data-interaction-open), a focused
 *     text-entry element, or a dirty (partially-typed) field holds the surface;
 *     a clean surface (or a merely-focused BUTTON) does not.
 *   - updateCountdowns: the merge arm — patches [data-ttl-expires] text from the
 *     clock WITHOUT touching any other DOM (safe on held surfaces).
 *   - NEGATIVE CONTROL: a naive replaceChildren rebuild really does destroy typed
 *     state — proving the floor tests a real hazard, not a tautology.
 *   - D5 wording floor: friendlyMachine never surfaces a raw m_<hex> machine id.
 *   - D3 copy: heldExplanation names BOTH accounts, and fail-closed reasons get
 *     honest "couldn't confirm" copy.
 */
// @ts-nocheck — the module is browser-native ESM (.js), no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  hasOpenInteraction,
  updateCountdowns,
  friendlyMachine,
  heldExplanation,
} from '../../dashboard/subscriptions.js';

let dom: JSDOM;
let doc: Document;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  doc = dom.window.document;
});

const NOW = Date.parse('2026-07-10T00:00:00Z');

function surface(): HTMLElement {
  const s = doc.createElement('div');
  doc.body.appendChild(s);
  return s;
}

describe('hasOpenInteraction (F9 hold predicate)', () => {
  it('a clean surface is NOT held', () => {
    const s = surface();
    s.innerHTML = '<div><button>Set up</button><span>Active</span></div>';
    expect(hasOpenInteraction(doc, s)).toBe(false);
  });

  it('a data-interaction-open episode marker holds the surface', () => {
    const s = surface();
    const cell = doc.createElement('td');
    cell.setAttribute('data-interaction-open', 'pin-entry');
    s.appendChild(cell);
    expect(hasOpenInteraction(doc, s)).toBe(true);
  });

  it('a dirty (partially-typed) field holds the surface', () => {
    const s = surface();
    const input = doc.createElement('input');
    s.appendChild(input);
    expect(hasOpenInteraction(doc, s)).toBe(false); // empty → not held
    input.value = '12'; // the operator started typing their PIN
    expect(hasOpenInteraction(doc, s)).toBe(true);
  });

  it('a FOCUSED empty text field holds the surface (about to type)', () => {
    const s = surface();
    const input = doc.createElement('input');
    input.setAttribute('type', 'text');
    s.appendChild(input);
    input.focus();
    expect(doc.activeElement).toBe(input);
    expect(hasOpenInteraction(doc, s)).toBe(true);
  });

  it('a focused BUTTON does not hold (only text-entry elements count)', () => {
    const s = surface();
    const btn = doc.createElement('button');
    s.appendChild(btn);
    btn.focus();
    expect(hasOpenInteraction(doc, s)).toBe(false);
  });

  it('null/undefined roots are safely not held', () => {
    expect(hasOpenInteraction(doc, null)).toBe(false);
    expect(hasOpenInteraction(doc, undefined)).toBe(false);
  });
});

describe('updateCountdowns (F9 merge arm)', () => {
  it('patches every [data-ttl-expires] element from the clock without touching siblings', () => {
    const s = surface();
    const ttl = doc.createElement('div');
    ttl.setAttribute('data-ttl-expires', new Date(NOW + 12 * 60_000).toISOString());
    ttl.textContent = 'stale text';
    const sibling = doc.createElement('input');
    sibling.value = 'typed-code';
    s.appendChild(ttl);
    s.appendChild(sibling);
    const patched = updateCountdowns(doc, s, NOW);
    expect(patched).toBe(1);
    expect(ttl.textContent).toBe('Link expires in 12m');
    expect(sibling.value).toBe('typed-code'); // merge NEVER touches the interaction
  });

  it('an elapsed TTL renders the explicit expired copy', () => {
    const s = surface();
    const ttl = doc.createElement('div');
    ttl.setAttribute('data-ttl-expires', new Date(NOW - 1000).toISOString());
    s.appendChild(ttl);
    updateCountdowns(doc, s, NOW);
    expect(ttl.textContent).toContain('expired');
  });

  it('is a no-op on roots without countdown elements (and on null)', () => {
    expect(updateCountdowns(doc, surface(), NOW)).toBe(0);
    expect(updateCountdowns(doc, null, NOW)).toBe(0);
  });
});

describe('NEGATIVE CONTROL — a naive rebuild clobbers what the hold protects', () => {
  it('replaceChildren destroys a typed input; the F9-held path preserves the exact node', () => {
    const s = surface();
    const input = doc.createElement('input');
    input.value = 'half-typed-pin';
    s.appendChild(input);

    // The guarded path (what the controller does): held → merge only, DOM untouched.
    expect(hasOpenInteraction(doc, s)).toBe(true);
    if (!hasOpenInteraction(doc, s)) s.replaceChildren(doc.createElement('button'));
    expect(s.contains(input)).toBe(true);
    expect(input.value).toBe('half-typed-pin');

    // The naive path (the pre-fix defect): the rebuild destroys the typed state.
    s.replaceChildren(doc.createElement('button'));
    expect(s.contains(input)).toBe(false);
    expect(s.querySelector('input')).toBeNull();
  });
});

describe('friendlyMachine (D5 wording floor — never a raw machine id)', () => {
  it('prefers the nickname', () => {
    expect(friendlyMachine('Laptop', 'm_cc2ec651a91f03f85abb19bfe5e7e8f7')).toBe('Laptop');
  });
  it('suppresses a raw m_<hex> id when there is no nickname', () => {
    expect(friendlyMachine(undefined, 'm_cc2ec651a91f03f85abb19bfe5e7e8f7')).toBe('');
    expect(friendlyMachine('', 'm_ab12cd34ef56')).toBe('');
  });
  it('passes through a human-readable id when no nickname exists', () => {
    expect(friendlyMachine(undefined, 'mac-mini')).toBe('mac-mini');
  });
});

describe('heldExplanation (D3 copy — name BOTH accounts, honest fail-closed)', () => {
  it('names both accounts on a mismatch', () => {
    const msg = heldExplanation('headley.justin@gmail.com', 'justin@sagemindai.io', 'email-mismatch');
    expect(msg).toContain('justin@sagemindai.io');
    expect(msg).toContain('headley.justin@gmail.com');
    expect(msg).toContain('NOT enrolled');
  });
  it('oracle-unavailable (missing-completed-email) → honest "couldn\'t confirm" copy', () => {
    const msg = heldExplanation(null, null, 'missing-completed-email');
    expect(msg.toLowerCase()).toContain('couldn’t confirm');
    expect(msg).toContain('NOT enrolled');
  });
  it('generic fallback never claims success', () => {
    const msg = heldExplanation(null, null, 'missing-expected-email');
    expect(msg).toContain('NOT enrolled');
  });
});
