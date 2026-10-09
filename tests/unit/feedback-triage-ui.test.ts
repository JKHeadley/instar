/**
 * Feedback Drain tab — Triage section: plain-language summary, the triage authority card,
 * the PIN plan/commit buttons, the ranked queue, and that the page mounts it.
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  triageStatusLine, triageAuthorityRequest, triageResultNote, summaryText, queueRowText, renderTriageSection, newTriageDecisionRef,
} from '../../dashboard/feedback-triage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
let doc: Document;
beforeEach(() => { doc = new JSDOM('<!doctype html><body><div id="t"></div></body>').window.document; });

const SUMMARY = { authority: 'awaiting-approval', counts: { work: 2, hold: 3, ignored: 1, untriaged: 4, queued: 1 }, callsUsedToday: 7, maxCallsPerDay: 150, ignoreLive: false, ignoreLiveRecommended: false };
const PROPOSAL = { status: 'none', current: null, proposal: { maxBatch: 20 }, blockers: [], approveAction: 'create', summary: 'Let the sorting model read each item.' };

describe('plain words', () => {
  it('status line and summary', () => {
    expect(triageStatusLine(PROPOSAL)).toMatch(/Not set up yet/);
    expect(triageStatusLine({ status: 'proposal-only', current: { generation: 3 }, pausedBecause: 'A different model replied.' })).toMatch(/Paused \(version 3\) — A different model replied/);
    const text = summaryText(SUMMARY);
    expect(text).toContain('waiting for your approval');
    expect(text).toContain('2 to work on, 3 held, 1 set aside, 5 waiting to be sorted');
    expect(text).toContain('practice mode');
    expect(summaryText({ ...SUMMARY, ignoreLiveRecommended: true })).toContain('ready to go live');
  });
  it('requests and notes', () => {
    expect(triageAuthorityRequest('create', '1234', 'r')).toEqual({ action: 'create', pin: '1234', operatorDecisionRef: 'r', useProposal: true });
    expect(triageAuthorityRequest('revoke', '1234', 'r')).toEqual({ action: 'revoke', pin: '1234', operatorDecisionRef: 'r' });
    expect(triageResultNote(false, { error: 'incorrect PIN' })).toMatch(/not accepted/);
    expect(newTriageDecisionRef(new Date(0), () => 0)).toMatch(/^dashboard-triage:/);
    expect(queueRowText({ rank: 1, severity: 'high', title: 'Crash', summary: 'It crashes' })).toBe('1. [high] Crash — It crashes');
  });
});

describe('renderTriageSection', () => {
  it('renders the card, approve button and queue; values via textContent only', async () => {
    const calls = [];
    const target = doc.getElementById('t');
    renderTriageSection(doc, target, { summary: SUMMARY, proposal: PROPOSAL, queue: { items: [{ rank: 1, severity: 'high', title: '<img src=x onerror=alert(1)>' }] } }, {
      submitAuthority: async (action, pin) => { calls.push([action, pin]); return 'ok'; },
      planIgnoreLive: async (enabled) => ({ planId: 'p1', nonce: 'n1', renderedText: `turn ${enabled}` }),
      commitPlan: async (plan, pin) => { calls.push(['commit', plan.planId, pin]); return 'done'; },
    });
    expect(target.querySelector('img')).toBeNull();
    expect(target.textContent).toContain('<img src=x');
    doc.getElementById('ftPin').value = '9999';
    target.querySelector('[data-ft-action="create"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual(['create', '9999']);
    target.querySelector('[data-ft-action="plan-ignore-live"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(target.textContent).toContain('turn true');
    target.querySelector('[data-ft-action="commit-ignore-live"]').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[1]).toEqual(['commit', 'p1', '9999']);
  });
  it('says so when triage is not live', () => {
    const target = doc.getElementById('t');
    renderTriageSection(doc, target, { summary: null }, {});
    expect(target.textContent).toContain('not live on this machine');
  });
});

describe('page wiring', () => {
  it('index.html mounts the Triage section and loads the module', () => {
    expect(HTML).toContain('id="fdTriage"');
    expect(HTML).toContain("import('/dashboard/feedback-triage.js')");
    expect(HTML).toContain('/feedback-factory/triage/commit');
  });
});
