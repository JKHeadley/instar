/**
 * Feedback Drain tab — the readiness authority approve/revoke card, and that the page
 * actually mounts it (a module no page imports is the "PIN route with no screen" defect
 * this card exists to fix).
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  statusLine,
  newDecisionRef,
  authorityRequest,
  resultNote,
  renderAuthorityCard,
} from '../../dashboard/feedback-readiness-authority.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');

let doc: Document;
beforeEach(() => { doc = new JSDOM('<!doctype html><body></body>').window.document; });

const PROPOSAL = {
  authorityId: 'feedback-readiness-default', agentId: 'echo', ownerMachineId: 'm_owner', ownerEpoch: 3,
  provider: 'codex-cli', modelFamily: 'gpt-5.5', promptVersion: 'p', schemaVersion: 's', decisionPointId: 'd',
  maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
};
const NONE = { status: 'none', current: null, proposal: PROPOSAL, blockers: [], approveAction: 'create',
  summary: 'Let the sorting model decide which feedback reports become work items: up to 50 reports per batch, at most $5 per day. Anything outside that comes to you.' };

describe('status line', () => {
  it('names each state in plain words', () => {
    expect(statusLine(NONE)).toMatch(/Not set up yet/);
    expect(statusLine({ status: 'revoked', current: { generation: 2 } })).toMatch(/Revoked \(version 2\)/);
    expect(statusLine({ status: 'proposal-only', current: { generation: 4 } })).toMatch(/Paused by a safety brake/);
    expect(statusLine({ status: 'active', current: { generation: 1, maxBatch: 50, maxDailySpendUsd: 5, matchesProposal: true } }))
      .toBe('Active (version 1): up to 50 reports per batch, at most $5 per day.');
    expect(statusLine({ status: 'active', current: { generation: 1, matchesProposal: false } })).toMatch(/out of date/);
  });
});

describe('requests', () => {
  it('approve asks the SERVER to fill the binding fields; only the envelope travels', () => {
    const body = authorityRequest('create', { maxBatch: '50', maxTokens: '1200', maxDailySpendUsd: '5' }, '1234', 'dashboard:x:1');
    expect(body).toEqual({ action: 'create', pin: '1234', operatorDecisionRef: 'dashboard:x:1', useProposal: true, maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 });
    expect(body).not.toHaveProperty('agentId');
    expect(body).not.toHaveProperty('provider');
  });
  it('an emptied limit field is omitted (server default), never sent as 0', () => {
    const body = authorityRequest('replace', { maxBatch: '', maxTokens: ' ', maxDailySpendUsd: '3' }, '1', 'r');
    expect(body).not.toHaveProperty('maxBatch');
    expect(body).not.toHaveProperty('maxTokens');
    expect(body.maxDailySpendUsd).toBe(3);
  });
  it('revoked: Restore explains it brings back the stored limits', () => {
    const root = doc.createElement('div');
    renderAuthorityCard(doc, root, { ...NONE, status: 'revoked', approveAction: 'restore', current: { generation: 2 } }, {});
    expect(root.textContent).toContain('Restore brings back the last approved limits');
    expect([...root.querySelectorAll('[data-fra-action]')].map((b) => b.getAttribute('data-fra-action'))).toEqual(['restore']);
  });
  it('revoke and restore carry no fields — the server reuses the stored record', () => {
    expect(authorityRequest('revoke', {}, '1234', 'r')).toEqual({ action: 'revoke', pin: '1234', operatorDecisionRef: 'r' });
    expect(authorityRequest('restore', {}, '1234', 'r')).toEqual({ action: 'restore', pin: '1234', operatorDecisionRef: 'r' });
  });
  it('decision refs are unique and bounded to the audit-safe charset', () => {
    const a = newDecisionRef(new Date('2026-09-30T17:00:00Z'), () => 0.1);
    const b = newDecisionRef(new Date('2026-09-30T17:00:00Z'), () => 0.2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[-A-Za-z0-9._:]{8,200}$/);
  });
  it('result notes: success, wrong PIN, and a server refusal all say what happened', () => {
    expect(resultNote(true, { generation: 1, revoked: false })).toMatch(/Approved \(version 1\)/);
    expect(resultNote(true, { generation: 2, revoked: true })).toMatch(/Revoked/);
    expect(resultNote(false, { error: 'Incorrect PIN' })).toMatch(/PIN was not accepted/);
    expect(resultNote(false, { error: 'authority already exists' })).toMatch(/Not applied: authority already exists/);
  });
});

describe('card', () => {
  it('fresh: shows the plain sentence, a PIN box and Approve — no Revoke', () => {
    const root = doc.createElement('div');
    renderAuthorityCard(doc, root, NONE, {});
    expect(root.textContent).toContain('up to 50 reports per batch, at most $5 per day');
    expect(root.querySelector('#fraPin')?.getAttribute('type')).toBe('password');
    const actions = [...root.querySelectorAll('[data-fra-action]')].map((b) => b.getAttribute('data-fra-action'));
    expect(actions).toEqual(['create']);
  });

  it('active and current: Save new limits + Revoke', () => {
    const root = doc.createElement('div');
    renderAuthorityCard(doc, root, { ...NONE, status: 'active', approveAction: null, current: { ...PROPOSAL, generation: 1, revoked: false, matchesProposal: true } }, {});
    expect([...root.querySelectorAll('[data-fra-action]')].map((b) => b.getAttribute('data-fra-action'))).toEqual(['replace', 'revoke']);
  });

  it('blocked: shows the reason and offers no Approve', () => {
    const root = doc.createElement('div');
    renderAuthorityCard(doc, root, { ...NONE, proposal: null, approveAction: null, blockers: ['No machine is configured to run the feedback drain here.'] }, {});
    expect(root.textContent).toContain('No machine is configured');
    expect(root.querySelectorAll('[data-fra-action]')).toHaveLength(0);
  });

  it('Approve submits the action, the edited envelope and the typed PIN', async () => {
    const root = doc.createElement('div');
    const calls = [];
    renderAuthorityCard(doc, root, NONE, { submit: async (...args) => { calls.push(args); return 'ok'; } });
    root.querySelector('#fraMaxBatch').value = '20';
    root.querySelector('#fraPin').value = ' 9999 ';
    root.querySelector('[data-fra-action="create"]').dispatchEvent(new doc.defaultView.Event('click'));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([['create', { maxBatch: '20', maxTokens: '1200', maxDailySpendUsd: '5' }, '9999']]);
    expect(root.querySelector('#fraNote').textContent).toBe('ok');
  });

  it('dynamic values never become markup', () => {
    const root = doc.createElement('div');
    renderAuthorityCard(doc, root, { ...NONE, summary: '<img src=x onerror=alert(1)>' }, {});
    expect(root.querySelector('img')).toBeNull();
  });
});

describe('the card is reachable from the page', () => {
  it('the Feedback Drain panel carries the mount point', () => {
    const panel = HTML.slice(HTML.indexOf('id="feedbackDrainPanel"'));
    expect(panel.slice(0, panel.indexOf('</div>\n\n'))).toContain('id="fdAuthority"');
  });
  it('the page imports the module, reads the proposal, and posts with X-Instar-Request', () => {
    expect(HTML).toContain("import('/dashboard/feedback-readiness-authority.js')");
    expect(HTML).toContain('/feedback-factory/readiness-authorities/proposal');
    const loader = HTML.slice(HTML.indexOf('async function loadFeedbackAuthority'), HTML.indexOf('function startFeedbackDrain'));
    expect(loader).toContain("'X-Instar-Request': '1'");
  });
  it('the card renders on tab open, not on the 15s poll (a re-render would wipe the PIN)', () => {
    const start = HTML.slice(HTML.indexOf('function startFeedbackDrain'), HTML.indexOf('function stopFeedbackDrain'));
    expect(start).toContain('loadFeedbackAuthority()');
    expect(start.slice(start.indexOf('setInterval'))).not.toContain('loadFeedbackAuthority');
  });
});
