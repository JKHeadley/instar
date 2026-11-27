/**
 * renderFollowMeApproveCard / renderFollowMeOffers — the one-tap operator card
 * (ws52-operator-tap-not-text Part A). Verifies it is a tap-only surface: plain
 * language + a PIN + Approve, with NO agent fingerprints in the DOM, and — the
 * dogfood — that it PASSES the arm-1 operator-surface gate (the very rule that
 * would have blocked the old raw-JSON form).
 */
// @ts-nocheck — exercises the browser-native ESM dashboard module.
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderFollowMeApproveCard, renderFollowMeOffers } from '../../dashboard/subscriptions.js';
import { operatorSurfaceRequiresRawInput } from '../../scripts/lib/operator-surface.mjs';

const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;

const OFFER = {
  machineNickname: 'Mac Mini',
  accountLabel: 'adriana',
  accountId: 'acct-adriana',
  targetMachineId: 'm_4cbc0d4a0c',
  // The controller's offer carries the agents (FD2) — the render MUST keep them out of the DOM:
  agents: ['63b1dbb21646e2f5f860441f6c6443ad', '63b1dbb21646e2f5f860441f6c6443ad'],
  expiryText: 'Authorizes this one setup; expires in 1 hour',
};

describe('renderFollowMeApproveCard — a tap-only operator card', () => {
  it('renders plain-language headline + expiry + a PIN box + an Approve button', () => {
    const card = renderFollowMeApproveCard(doc, OFFER);
    expect(card.textContent).toContain('Let Mac Mini use your adriana subscription');
    expect(card.textContent).toContain('expires in 1 hour');
    expect(card.querySelector('input.sub-followme-pin')?.getAttribute('type')).toBe('password');
    const btn = card.querySelector('button.sub-followme-approve');
    expect(btn?.textContent).toBe('Approve');
    expect(btn?.getAttribute('data-followme-approve')).toBe('1');
  });

  it('carries the NON-sensitive account/target ids for the Approve handler', () => {
    const card = renderFollowMeApproveCard(doc, OFFER);
    expect(card.getAttribute('data-account-id')).toBe('acct-adriana');
    expect(card.getAttribute('data-target-machine-id')).toBe('m_4cbc0d4a0c');
  });

  it('NEVER puts agent fingerprints in the DOM (they stay in controller state)', () => {
    const card = renderFollowMeApproveCard(doc, OFFER);
    expect(card.outerHTML).not.toContain('63b1dbb2');
  });

  it('DOGFOOD: the card PASSES the arm-1 operator-surface gate (no raw technical text)', () => {
    const card = renderFollowMeApproveCard(doc, OFFER);
    const verdict = operatorSurfaceRequiresRawInput(card.outerHTML);
    expect(verdict.requiresRawInput).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });
});

describe('renderFollowMeOffers — list of offers', () => {
  it('renders one card per offer with a title', () => {
    const target = doc.createElement('div');
    renderFollowMeOffers(doc, target, [OFFER, { ...OFFER, machineNickname: 'Laptop' }]);
    expect(target.querySelectorAll('button.sub-followme-approve')).toHaveLength(2);
    expect(target.textContent).toContain('Let another machine use a subscription');
  });

  it('is silent when there are no offers (no cards, no title)', () => {
    const target = doc.createElement('div');
    renderFollowMeOffers(doc, target, []);
    expect(target.children).toHaveLength(0);
  });

  it('withholds approval when names are missing or two offers have the same visible target', () => {
    const target = doc.createElement('div');
    renderFollowMeOffers(doc, target, [OFFER, { ...OFFER, accountId: 'acct-second' }]);
    expect(target.querySelectorAll('button.sub-followme-approve')).toHaveLength(0);
    expect(target.textContent).toContain('A unique account and machine name are needed');
    renderFollowMeOffers(doc, target, [{ ...OFFER, machineNickname: OFFER.targetMachineId }]);
    expect(target.querySelectorAll('button.sub-followme-approve')).toHaveLength(0);
    renderFollowMeOffers(doc, target, [OFFER, { ...OFFER, targetMachineId: 'm_other', accountId: 'acct-other', accountLabel: 'other subscription' }]);
    expect(target.querySelectorAll('button.sub-followme-approve')).toHaveLength(0);
  });
});
