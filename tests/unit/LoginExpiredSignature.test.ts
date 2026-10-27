import { describe, it, expect } from 'vitest';
import { classifyLoginExpired } from '../../src/core/LoginExpiredSignature.js';

describe('classifyLoginExpired', () => {
  it('matches the real Claude Code frame captured on 2026-10-18', () => {
    const pane = [
      '    piece 3: b5364807',
      '',
      '⏺ Login expired · Please run /login',
      '',
      '✻ Worked for 0s · done 9:35 AM',
      '────────────────',
      '❯ ',
    ].join('\n');
    const v = classifyLoginExpired(pane);
    expect(v.loginExpired).toBe(true);
    expect(v.matchedLine).toBe('Login expired · Please run /login');
  });

  it.each([
    '⏺ OAuth token has expired. Please obtain a new token or refresh your existing token.',
    '⏺ Invalid API key · Please run /login',
    '⎿ Please run /login',
    '⏺ Not logged in · Run /login', // newer Claude Code wording (CMT-1008)
    '● Not logged in · Run /login',
  ])('matches other CLI sign-in failure frames: %s', (line) => {
    expect(classifyLoginExpired(`${line}\n❯ \n`).loginExpired).toBe(true);
  });

  it('ignores prose that mentions the phrase mid-line', () => {
    expect(classifyLoginExpired('⏺ The job hit "Login expired · Please run /login" and idled.\n❯ \n').loginExpired).toBe(false);
  });

  it('messageLed: the CLI\'s own ⏺ line is message-led; a ⎿ tool-result line is not', () => {
    expect(classifyLoginExpired('⏺ Login expired · Please run /login\n❯ \n').messageLed).toBe(true);
    expect(classifyLoginExpired('⎿ Please run /login\n❯ \n')).toMatchObject({ loginExpired: true, messageLed: false });
  });

  it('a ⎿-led "Not logged in" (output of `claude auth status`) is not a login frame at all', () => {
    expect(classifyLoginExpired('⏺ Bash(claude auth status)\n  ⎿  Not logged in · Run /login\n❯ \n').loginExpired).toBe(false);
  });

  it('ignores "not logged in" prose that never names /login', () => {
    expect(classifyLoginExpired('⏺ Not logged in to the dashboard yet, will retry.\n❯ \n').loginExpired).toBe(false);
  });

  it('ignores a non-glyph-led line (quoted log / prompt text)', () => {
    expect(classifyLoginExpired('Login expired · Please run /login\n❯ \n').loginExpired).toBe(false);
  });

  it('ignores a stale frame scrolled out of the live tail', () => {
    const pane = ['⏺ Login expired · Please run /login', ...Array.from({ length: 20 }, (_, i) => `⏺ step ${i} done`)].join('\n');
    expect(classifyLoginExpired(pane).loginExpired).toBe(false);
  });

  it('empty / blank capture → no match', () => {
    expect(classifyLoginExpired('').loginExpired).toBe(false);
    expect(classifyLoginExpired('   \n  ').loginExpired).toBe(false);
  });
});
