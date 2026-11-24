import { describe, expect, it } from 'vitest';
import { workCardPlainLanguageIssue } from '../../src/core/WorkCardPlainLanguage.js';

describe('work card text a person reads', () => {
  it.each([
    ['need', 'Chief of Staff handoff f79e7768'],
    ['title', 'Finish DSE-T10'],
    ['whyYou', 'The owner waiting list is at softOpenCards.'],
    ['recommendation', 'Continue the token pacing worktree.'],
    ['need', 'Follow record 7a3169e5-09af-4365-81bf-7b4651a353e0.'],
  ])('identifies the %s that needs a rewrite', (field, value) => {
    expect(workCardPlainLanguageIssue({ [field]: value })).toMatchObject({ field });
  });

  it('checks nested visible text without mistaking technical metadata for copy', () => {
    const metadata = {
      refs: [{ kind: 'commitment', id: 'CMT-2203' }],
      source: { conversationKey: 'telegram:141385', messageId: '146785' },
      links: [{ label: 'Completed design plan', url: 'https://example.invalid/commit/f79e7768' }],
    };
    expect(workCardPlainLanguageIssue({
      ...metadata, title: 'Review the new iPhone layout',
      doneWhen: [{ id: 'm1', text: 'You can open the Accounts screen and read every limit.' }],
    })).toBeNull();
    expect(workCardPlainLanguageIssue({ ...metadata, brief: { checks: [{ text: 'Check requestApproved.' }] } }))
      .toMatchObject({ field: 'brief.checks[0].text' });
    expect(workCardPlainLanguageIssue({ title: '[Check](https://example.invalid/commit/f79e7768)' }))
      .toMatchObject({ field: 'title' });
  });

  it('preserves original owner words without exempting the agent-written outcome', () => {
    const need = 'Please check PR 3596.';
    const options = { preserveOriginalRequest: true };
    expect(workCardPlainLanguageIssue({ need, title: 'Review the dashboard update' }, options)).toBeNull();
    expect(workCardPlainLanguageIssue({
      need, doneWhen: [{ text: 'requestApproved is true.' }],
    }, options)).toMatchObject({ field: 'doneWhen[0].text' });
  });
});
