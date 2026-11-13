/**
 * The Chief of Staff note's layout (docs/specs/chief-of-staff-topic.md §3; operator report 2026-11-12:
 * "too chaotic and too hard to read with very little information"). Pure pieces only: word-boundary
 * cuts, short project titles, button labels, the grouped "looks finished" blocks, and links that open
 * on a phone (or no link at all). Also the machine name a message footer shows.
 */
import { describe, it, expect } from 'vitest';
import { composeNote, cutAtWord, shortProjectTitle, confirmButtonLabel, type NoteItem } from '../../src/core/ChiefOfStaffLoop.js';
import { publicMachineName } from '../../src/messaging/telegram-origin/OriginPresentation.js';

const confirm = (title: string, checksPassed: number, judgment: string[], url: string | null): NoteItem => ({
  kind: 'needs-you', text: `${title}: every automatic check passes; needs your OK.`,
  action: { label: confirmButtonLabel(title), id: `cos:confirm-done:${title}` }, confirm: { title, checksPassed, judgment, url },
});

describe('cutAtWord', () => {
  it('leaves short text alone and collapses whitespace', () => {
    expect(cutAtWord('  Ship   the thing ', 40)).toBe('Ship the thing');
  });
  it('cuts at a word boundary, never mid-word, and marks the cut', () => {
    const out = cutAtWord('Get Monroe AI ready for public launch with DNS', 30);
    expect(out).toBe('Get Monroe AI ready for…');
    expect(cutAtWord('Get Monroe AI ready for public launch', 31)).toBe('Get Monroe AI ready for public…');
    expect(out.length).toBeLessThanOrEqual(30);
  });
  it('drops trailing punctuation before the ellipsis', () => {
    expect(cutAtWord('Alpha beta, gamma delta epsilon', 13)).toBe('Alpha beta…');
  });
  it('a single word longer than the limit is the only mid-word cut', () => {
    expect(cutAtWord('Supercalifragilisticexpialidocious', 10)).toBe('Supercali…');
  });
});

describe('shortProjectTitle', () => {
  it('takes the lead of a "Name: details" goal', () => {
    expect(shortProjectTitle("Emily Ghosh's affiliate intelligence project: confirm the weekly report")).toBe("Emily Ghosh's affiliate intelligence project");
    expect(shortProjectTitle('Get Monroe AI ready for public launch: DNS, chat rate limits')).toBe('Get Monroe AI ready for public launch');
  });
  it('takes the lead of a dash or a first sentence', () => {
    expect(shortProjectTitle('Billing cleanup — every invoice matched')).toBe('Billing cleanup');
    expect(shortProjectTitle('Ship the iOS app. Then tell the beta group.')).toBe('Ship the iOS app');
  });
  it('a URL scheme is not a "Name:" split', () => {
    expect(shortProjectTitle('https://example.com goes live')).toBe('https://example.com goes live');
  });
  it('a long goal with no lead is cut at a word boundary', () => {
    const t = shortProjectTitle('Keep every one of the customer onboarding flows working smoothly across all of the regions we serve', 60);
    expect(t.endsWith('…')).toBe(true); expect(t.length).toBeLessThanOrEqual(60);
    expect(t).toBe('Keep every one of the customer onboarding flows working…');
  });
  it('a lead longer than the limit falls back to cutting the whole goal', () => {
    const lead = 'A'.repeat(5) + ' ' + 'word '.repeat(20);
    expect(shortProjectTitle(`${lead}: details`, 40).length).toBeLessThanOrEqual(40);
  });
  it('an empty goal still has a name', () => {
    expect(shortProjectTitle('   ')).toBe('Untitled project');
  });
});

describe('confirmButtonLabel', () => {
  it('names the project and stays short', () => {
    expect(confirmButtonLabel('Monroe launch')).toBe('Done: Monroe launch');
    const long = confirmButtonLabel("Keep Paul's requests and AI policy decisions moving");
    expect(long).toBe("Done: Keep Paul's requests and AI…");
    expect(long.length).toBeLessThanOrEqual(36);
  });
});

describe('composeNote — grouped "looks finished" blocks', () => {
  it('one headline with the count, one block per project, no repeated boilerplate', () => {
    const t = composeNote([
      confirm('Monroe launch', 5, ['The launch checklist reads complete to you'], 'https://cos.example/p/1'),
      confirm('AI spend', 1, [], null),
    ], 5, 'https://cos.example/cos', null)!;
    expect(t.split('\n')[0]).toBe('2 projects look finished and need your OK');
    expect(t).toContain('Monroe launch\nAll 5 automatic checks pass.\nYour call:\n  "The launch checklist reads complete to you"\nDetails: https://cos.example/p/1');
    expect(t).toContain('AI spend\nIts one automatic check passes.');
    expect(t).not.toContain('Needs you');
    expect(t).toContain('Tap the matching "Done" button below');
  });
  it('singular headline; several judgment items are quoted and the overflow is counted', () => {
    const t = composeNote([confirm('X', 2, ['a', 'b', 'c'], null)], 5, null, null)!;
    expect(t.startsWith('1 project looks finished and needs your OK')).toBe(true);
    expect(t).toContain('Your calls:\n  "a"\n  "b"\n  +1 more on its page');
  });
  it('other Needs-you items follow under "Also needs you"', () => {
    const t = composeNote([confirm('X', 2, [], null), { kind: 'needs-you', text: 'Y is parked. Unpark?' }], 5, null, null)!;
    expect(t).toContain('Also needs you\n• Y is parked. Unpark?');
  });
  it('without confirm blocks the old sections are unchanged', () => {
    const t = composeNote([{ kind: 'needs-you', text: 'Y is parked. Unpark?' }, { kind: 'result', text: 'Finished and verified: Z.' }], 5, null, null)!;
    expect(t).toBe('Needs you\n• Y is parked. Unpark?\n\nResults\n• Finished and verified: Z.');
  });
  it('overflow past the cap names the page with a link when one exists, and without one when not', () => {
    const many = Array.from({ length: 4 }, (_, i) => confirm(`P${i}`, 1, [], null));
    expect(composeNote(many, 2, 'https://cos.example/cos', null)).toContain('+2 more: https://cos.example/cos');
    const noLink = composeNote(many, 2, null, null)!;
    expect(noLink).toContain('+2 more on the Chief of Staff page'); expect(noLink).not.toMatch(/https?:/);
  });
});

describe('publicMachineName (message footer)', () => {
  it('nickname first', () => {
    expect(publicMachineName({ machineId: 'm_b7f06b11aa', nickname: 'Studio', registryName: 'host', identityName: 'host' })).toBe('Studio');
  });
  it('no nickname ⇒ the machine name from pairing, then from its identity', () => {
    expect(publicMachineName({ machineId: 'm_b7f06b11aa', registryName: 'inspec-mac-mini', identityName: 'x' })).toBe('inspec-mac-mini');
    expect(publicMachineName({ machineId: 'm_b7f06b11aa', identityName: 'inspec-mac-mini' })).toBe('inspec-mac-mini');
  });
  it('id-shaped or unprintable names are skipped; the raw id is the last resort', () => {
    expect(publicMachineName({ machineId: 'm_b7f06b11aa', nickname: 'Machine m_b7f06b', identityName: 'line\nbreak' })).toBe('Machine m_b7f06b');
    expect(publicMachineName({ machineId: 'm_b7f06b11aa' })).toBe('Machine m_b7f06b');
  });
});
