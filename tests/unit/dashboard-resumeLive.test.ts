/**
 * Regression tests for the "Resume live output" button and auto-follow paths.
 *
 * Bug: `term.write(data)` is asynchronous — calling `term.scrollToBottom()`
 * immediately (or via requestAnimationFrame) scrolls against a stale buffer
 * and lands mid-history instead of at the new bottom. The fix uses xterm's
 * write-completion callback: `term.write(data, () => term.scrollToBottom())`.
 *
 * These tests inspect the HTML at rest to lock in the callback form on all
 * three resume paths: button click, scroll-to-bottom detection, and wheel-down.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: Resume live output — scroll-after-write', () => {
  it('does not schedule scrollToBottom in a requestAnimationFrame after term.write (stale-buffer antipattern)', () => {
    // The old bug: term.write(data); requestAnimationFrame(() => term.scrollToBottom()).
    // Regardless of interleaving, this pattern is banned — scroll must ride the write callback.
    const racyPattern = /term\.write\([^)]*\);\s*(?:\/\/[^\n]*\n\s*)*requestAnimationFrame\(\s*\(\s*\)\s*=>\s*\{[^}]*term\.scrollToBottom/s;
    expect(HTML).not.toMatch(racyPattern);
  });

  it('uses the term.write completion callback to schedule scrollToBottom on every resume path', () => {
    // Each `term.clear(); term.write(data)` block in a resume path must pass a callback
    // that eventually calls scrollToBottom — not a bare `term.write(data)` followed by
    // a separate scrollToBottom call.
    const callbackCount = (HTML.match(/term\.write\(\s*data\s*,\s*(?:\(\s*\)\s*=>|snapToBottom)/g) || []).length;
    expect(callbackCount).toBeGreaterThanOrEqual(3);
  });

  it('button click handler uses term.write callback for the pending-data path', () => {
    const btnStart = HTML.indexOf("btn.textContent = '▼ Resume live output'");
    expect(btnStart).toBeGreaterThan(-1);
    // Take a generous slice — button definition through the end of the onclick handler.
    const slice = HTML.slice(btnStart, btnStart + 2000);
    expect(slice).toMatch(/term\.write\(\s*data\s*,\s*snapToBottom\s*\)/);
    // And the fallback (no pending data) still snaps to bottom.
    expect(slice).toContain('snapToBottom()');
  });

  it('button click handler scrolls the outer container into view (mobile/narrow viewport safety)', () => {
    const btnStart = HTML.indexOf("btn.textContent = '▼ Resume live output'");
    const slice = HTML.slice(btnStart, btnStart + 2000);
    expect(slice).toMatch(/scrollIntoView\(\s*\{\s*block:\s*'end'/);
  });

  it('onScroll-triggered resume path uses the write callback', () => {
    // Locate the term.onScroll handler body.
    const start = HTML.indexOf('term.onScroll(');
    expect(start).toBeGreaterThan(-1);
    const slice = HTML.slice(start, start + 1500);
    expect(slice).toMatch(/term\.write\(\s*data\s*,\s*\(\s*\)\s*=>\s*\{\s*term\.scrollToBottom/);
  });

  it('wheel-triggered resume path uses the write callback', () => {
    // Locate the xtermViewport wheel listener.
    const start = HTML.indexOf("xtermViewport.addEventListener('wheel'");
    expect(start).toBeGreaterThan(-1);
    const slice = HTML.slice(start, start + 1500);
    expect(slice).toMatch(/term\.write\(\s*data\s*,\s*\(\s*\)\s*=>\s*\{\s*term\.scrollToBottom/);
  });
});

describe('dashboard: Resume live output — button visibility mirrors follow state', () => {
  // The button is the always-available "take me back to live" control. It must
  // appear whenever the viewport is NOT following (user scrolled up), not only
  // when new output happens to arrive while the user is scrolled up.

  it('scroll-up transition in term.onScroll shows the button', () => {
    const start = HTML.indexOf('term.onScroll(');
    expect(start).toBeGreaterThan(-1);
    const slice = HTML.slice(start, start + 1500);
    // The !atBottom branch flips userIsFollowing=false AND shows the button.
    expect(slice).toMatch(/!atBottom\s*&&\s*userIsFollowing[\s\S]{0,500}userIsFollowing\s*=\s*false[\s\S]{0,200}showResumeButton\(\s*\)/);
  });

  it('scroll-to-bottom transition in term.onScroll hides the button', () => {
    const start = HTML.indexOf('term.onScroll(');
    const slice = HTML.slice(start, start + 1500);
    // The atBottom resume branch flips userIsFollowing=true AND hides the button.
    expect(slice).toMatch(/atBottom\s*&&\s*!userIsFollowing[\s\S]{0,200}userIsFollowing\s*=\s*true[\s\S]{0,200}hideResumeButton\(\s*\)/);
  });

  it('wheel-down resume branch hides the button', () => {
    const start = HTML.indexOf("xtermViewport.addEventListener('wheel'");
    const slice = HTML.slice(start, start + 1500);
    expect(slice).toMatch(/userIsFollowing\s*=\s*true[\s\S]{0,200}hideResumeButton\(\s*\)/);
  });

  it('session switch clears any carry-over resume button', () => {
    // Reset-on-session-switch must not leave a visible resume button from a
    // prior session's scroll-up state.
    expect(HTML).toMatch(/userIsFollowing\s*=\s*true;\s*\/\/\s*Reset scroll tracking[\s\S]{0,200}hideResumeButton\(\s*\)/);
  });
});
