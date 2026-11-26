import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudePasteFixture } from '../helpers/claudePasteSubmit.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('submits a paste committed 750 ms after paste-end on its first Enter', () => {
  const f = claudePasteFixture({ commitMs: 750 });
  try {
    const text = 'first message in a private fixture\nsecond line';
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    expect(f.submitted).toEqual([text]);
    expect(f.keys).toEqual(['Enter']);
  } finally { f.cleanup(); }
});

it('leaves an answered first message in history without pressing recovery keys or reporting a failure', async () => {
  const f = claudePasteFixture();
  try {
    const text = 'The first message is already answered before the first check.\nDetails';
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.submitted).toEqual([text]);
    expect(f.keys).toEqual(['Enter']);
    expect(f.report).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it.each([
  'First line\nThe rest identifies this particular draft.',
  'First line\n\nSecond paragraph after an empty row.',
  'First line\n⏺ A quoted role glyph in the actual paste.',
])('recovers one dropped Enter for a multiline draft %j', async (text) => {
  const f = claudePasteFixture({ dropFirstEnter: true });
  try {
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    expect(f.submitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.submitted).toEqual([text]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.keys).toEqual(['Enter', 'Enter']);
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'SessionManager.verifyInjection' }));
  } finally { f.cleanup(); }
});

it.each([
  ['a completed answer before the next composer is drawn', (text: string) => '❯ ' + text + '\n⏺ Already answered.'],
  ['an indented prompt glyph quoted by a different draft', (text: string) =>
    '────────────────────────\n❯ Another draft\n  ❯ ' + text + '\n────────────────────────'],
  ['a different two-line draft quoting the old marker', (text: string) =>
    '❯ ' + text + '\n⏺ Answered.\n────────────────────────\n❯ Another draft\n  ' + text + '\n────────────────────────'],
] as const)('sends no recovery key for %s', async (_case, frame) => {
  const f = claudePasteFixture();
  try {
    const text = 'Please check the answer to the original question.';
    vi.spyOn(f.manager, 'captureOutput').mockReturnValue(frame(text));
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.keys).toEqual(['Enter']);
    expect(f.report).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it.each([
  ['claude-code', 'literal single line', [], ['Enter']],
  ['claude-code', 'a tab\tinside a paste', [1000], ['Enter']],
  ['unknown', 'legacy\nfallback', [500], ['Enter']],
  ['codex-cli', 'other\nframework', [1500, 300], ['Enter', 'Enter']],
] as const)('preserves the submit sequence for %s with %j', (framework, text, sleeps, keys) => {
  const f = claudePasteFixture({ framework });
  try {
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    expect(f.sleeps).toEqual(sleeps);
    expect(f.keys).toEqual(keys);
  } finally { f.cleanup(); }
});

it('leaves a busy draft alone and abandons recovery if the session rotates before the next rung', async () => {
  const f = claudePasteFixture({ dropFirstEnter: true });
  try {
    const text = 'private busy draft awaiting its turn';
    expect(f.manager.injectMessage(f.session.name, text)).toBe(true);
    const capture = vi.spyOn(f.manager, 'captureOutput').mockReturnValue('❯ ' + text + '\n  esc to interrupt');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.keys).toEqual(['Enter']);
    capture.mockRestore();
    f.project.state.saveSession({ ...f.session, claudeSessionId: 'replacement-incarnation' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.submitted).toEqual([]);
    expect(f.keys).toEqual(['Enter']);
    expect(f.report).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
