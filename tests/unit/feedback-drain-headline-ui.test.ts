/**
 * Feedback Drain tab — decision headline (ACT-003): the tab opens on one sentence naming
 * what needs the operator and at most one button, with every counter in a collapsed drawer.
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { decideHeadline, operatorTodos, renderHeadline, fixesAwaitingReview } from '../../dashboard/feedback-drain-headline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
let doc: Document;
beforeEach(() => { doc = new JSDOM('<!doctype html><body><div id="t"></div></body>').window.document; });

const SETTLED = { status: 'active', approveAction: null, blockers: [], current: { generation: 2, matchesProposal: true } };
const SUMMARY = { authority: 'active', counts: { work: 2, hold: 1, ignored: 0, untriaged: 3, queued: 1 } };
const calm = { readiness: SETTLED, triageProposal: SETTLED, triageSummary: SUMMARY, execute: { reason: 'ok', attempts: [] }, queue: { items: [] } };

describe('what needs the operator', () => {
  it('nothing pending → calm, no button, no counter wall', () => {
    const m = decideHeadline(calm);
    expect(m.tone).toBe('calm');
    expect(m.sentence).toBe('Nothing here needs you.');
    expect(m.sub).toContain('2 items picked to work on, 4 waiting to be sorted');
    expect(m.todo).toBeNull();
  });
  it('drain not running here → calm, says so', () => {
    const m = decideHeadline({});
    expect(m.tone).toBe('calm');
    expect(m.sub).toMatch(/not running on this machine/);
  });
  it('blockers with nothing approvable → calm, explains, no button', () => {
    const m = decideHeadline({ readiness: { status: 'none', approveAction: null, blockers: ['No model is currently available.'] } });
    expect(m.tone).toBe('calm');
    expect(m.sub).toContain('No model is currently available.');
    expect(m.todo).toBeNull();
  });
  it('readiness approval pending → action pointing at the readiness card', () => {
    const m = decideHeadline({ ...calm, readiness: { status: 'none', approveAction: 'create', blockers: [] } });
    expect(m.tone).toBe('action');
    expect(m.sentence).toBe('Feedback is waiting on one approval from you.');
    expect(m.sub).toMatch(/which model sorts incoming reports/);
    expect(m.todo).toMatchObject({ target: 'fdAuthority', focus: 'fraPin', button: 'Review and approve' });
  });
  it('paused readiness says why', () => {
    const m = decideHeadline({ ...calm, readiness: { status: 'proposal-only', approveAction: 'replace', pausedBecause: 'the daily cap was reached.' } });
    expect(m.sub).toContain('It was paused: the daily cap was reached.');
  });
  it('executor acceptance → presses the existing preview step, never commits', () => {
    const m = decideHeadline({ ...calm, execute: { reason: 'approver-not-independent', attempts: [] } });
    expect(m.todo).toMatchObject({ target: 'fdTriage', press: 'plan-accept-approver-dependence' });
  });
  it('several pending → leads with the most important, counts the rest', () => {
    const m = decideHeadline({ ...calm, readiness: { status: 'none', approveAction: 'create' }, triageProposal: { status: 'none', approveAction: 'create' }, execute: { reason: 'approver-not-independent' } });
    expect(m.todo.target).toBe('fdAuthority');
    expect(m.sub).toMatch(/After that, 2 more things here need you\.$/);
    expect(operatorTodos({ ...calm, readiness: { approveAction: 'create' }, triageProposal: { approveAction: 'create' } })).toHaveLength(2);
  });
  it('fixes waiting on GitHub → a link, and only GitHub links count', () => {
    const queue = { items: [
      { executionState: 'pr-open', prLink: 'https://github.com/o/r/pull/7' },
      { executionState: 'pr-open', prLink: 'javascript:alert(1)' },
      { executionState: 'queued', prLink: null },
    ] };
    expect(fixesAwaitingReview(queue)).toHaveLength(1);
    const m = decideHeadline({ ...calm, queue });
    expect(m.todo).toMatchObject({ href: 'https://github.com/o/r/pull/7', button: 'Open the fix' });
  });
});

describe('rendering', () => {
  it('one button that calls reveal; text never parsed as HTML', () => {
    const target = doc.getElementById('t');
    let revealed = null;
    renderHeadline(doc, target, decideHeadline({ ...calm, readiness: { status: 'proposal-only', approveAction: 'replace', pausedBecause: '<img src=x onerror=alert(1)>' } }), { reveal: (t) => { revealed = t; } });
    expect(target.querySelector('img')).toBeNull();
    const buttons = target.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(revealed.target).toBe('fdAuthority');
  });
  it('calm renders no button', () => {
    const target = doc.getElementById('t');
    renderHeadline(doc, target, decideHeadline(calm));
    expect(target.querySelectorAll('button, a')).toHaveLength(0);
  });
});

describe('the page leads with the decision', () => {
  const panel = HTML.slice(HTML.indexOf('id="feedbackDrainPanel"'), HTML.indexOf('<!-- subscriptions tab'));
  it('headline comes before the cards and the counters, which sit in closed drawers', () => {
    const h = panel.indexOf('id="fdHeadline"');
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(panel.indexOf('id="fdAuthority"'));
    expect(h).toBeLessThan(panel.indexOf('id="fdBacklog"'));
    expect(panel).toMatch(/<details id="fdControls" class="ph-detail">/);
    expect(panel).toMatch(/<details id="fdMore" class="ph-detail">/);
    expect(panel.slice(panel.indexOf('<details id="fdMore"'))).toContain('id="fdBacklog"');
  });
  it('the headline loads on open and on the poll (it has no PIN to wipe)', () => {
    const start = HTML.slice(HTML.indexOf('function startFeedbackDrain'), HTML.indexOf('function stopFeedbackDrain'));
    expect(start).toContain('loadFeedbackHeadline()');
    expect(start.slice(start.indexOf('setInterval'))).toContain('loadFeedbackHeadline');
    expect(HTML).toContain("import('/dashboard/feedback-drain-headline.js')");
  });
});
