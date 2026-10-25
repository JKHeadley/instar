/**
 * classifyApprovalRequest (CMT-810) — the operator-approval REQUEST shape that the
 * action-claim classifier correctly ignores ("may I restart the Studio?" is a
 * request, not a claim) but which the cross-topic activity index must see. Both
 * sides of the decision boundary with realistic inputs, including the 2026-10-14
 * incident wording.
 */
import { describe, it, expect } from 'vitest';
import { classifyApprovalRequest, classifyActionClaim, excerptAround } from '../../src/core/action-claim.js';

describe('classifyApprovalRequest — operator-approval requests', () => {
  it('catches the incident shape: asking to approve a Mac Studio restart', () => {
    for (const [text, verb] of [
      ['May I restart the Mac Studio? It will take about 3 minutes.', 'restart'],
      ['Can I go ahead and reboot the Studio now?', 'reboot'],
      ['Do you want me to restart the Mac Studio?', 'restart'],
      ['Please approve the restart of the Mac Studio.', 'restart'],
      ['Can you approve this Mac Studio reboot?', 'reboot'],
      ['Is it ok if I shut down the Studio for the kernel update?', 'shutdown'],
      ['Requesting your approval to roll back the deploy.', 'rollback'],
      ['Should I kill the stuck session?', 'kill'],
      ['Mind if I delete the stale worktrees?', 'delete'],
      ["I'd like to restart the server — ok?", 'restart'],
      ['Would you like me to push the fix?', 'push'],
      ['Permission to rotate the Telegram token?', 'rotate'],
      ['Ok to restart the Studio now?', 'restart'],
      ['Is it safe to reboot the Studio during the build?', 'reboot'],
      ['I need your approval for the restart before 15:00.', 'restart'],
      ['Approve the rollback?', 'rollback'],
      ['Can you confirm the restart is approved for 15:00?', 'restart'], // a real confirm-ASK still counts
    ] as const) {
      const r = classifyApprovalRequest(text);
      expect(r.isApprovalRequest, text).toBe(true);
      expect(r.request?.normalizedVerb, text).toBe(verb);
    }
  });

  it('does NOT fire on statements, past tense, third person, quotes, or hold-off advice', () => {
    for (const text of [
      "I'd like to restart the server later today.", // statement, no question
      'You approved the restart at 14:41.', // past tense
      'I would hold off on restarting the Studio for now.', // the 61449 advice
      'Hold off on the restart; I can wait.',
      "I'll restart the server now.", // a CLAIM (other classifier's job)
      'Did you restart it?', // asking the operator what THEY did
      '"May I restart it?" is what the other session asked.', // quoted
      'The user may want to restart later.',
      'Restart is complete.',
      'The approval flow for deploys is documented in the runbook.',
      // second-pass review 2026-10-14: STATEMENTS of permission/prohibition are not requests
      'It is not safe to restart the Studio yet; I would hold off.', // topic 61449's actual position
      'You are clear to restart whenever you like.',
      'I can confirm the restart finished cleanly.',
      'Only the operator can approve a restart of that machine.',
      'Got your approval for the restart at 14:41 — proceeding.',
      "It's never okay to reboot the Studio during a build.",
      // second-pass round 2 (advisory): negated asks + verification asks are not approval requests
      'You do not need me to restart anything.',
      "You don't want me to reboot it, right?",
      'Please confirm the restart completed.',
      'Can you confirm the deploy finished?',
    ]) {
      expect(classifyApprovalRequest(text).isApprovalRequest, text).toBe(false);
    }
  });

  it('is disjoint from classifyActionClaim on the incident wording (a request is not a claim)', () => {
    const text = 'May I restart the Mac Studio?';
    expect(classifyActionClaim(text).isActionClaim).toBe(false);
    expect(classifyApprovalRequest(text).isApprovalRequest).toBe(true);
  });

  it('is total: empty / non-string input never throws', () => {
    expect(classifyApprovalRequest('')).toEqual({ isApprovalRequest: false });
    expect(classifyApprovalRequest(undefined as unknown as string)).toEqual({ isApprovalRequest: false });
  });

  it('returns the FIRST request when several appear', () => {
    const r = classifyApprovalRequest('Should I push the branch first? Then may I restart the Studio?');
    expect(r.request?.normalizedVerb).toBe('push');
  });
});

describe('excerptAround', () => {
  it('returns the containing sentence, whitespace-normalized and bounded', () => {
    const text = 'Done with the build.\n\nMay I restart the\n  Mac Studio? It will take 3 minutes.';
    const matched = classifyApprovalRequest(text).request!.matched; // the real flow: the regex's own match
    expect(excerptAround(text, matched)).toBe('May I restart the Mac Studio?');
  });
  it('falls back to the head of the message when the needle is absent', () => {
    expect(excerptAround('abc def', 'zzz', 5)).toBe('abc d');
  });
  it('clamps long sentences to maxLen', () => {
    const long = 'May I restart ' + 'x'.repeat(500) + '?';
    expect(excerptAround(long, 'May I restart').length).toBe(200);
  });
});
