/**
 * The locked-Mac password box must not cover the Stop button.
 *
 * Found live on 2026-11-05 (locked-screen proof, case 12.5a): with the password
 * box showing, a click on Stop landed on the box ("<form id="lockedPassword">
 * intercepts pointer events"), so a person could only end the session by
 * closing the tab. Stop lives in .desktop-bar at the top of the screen; the
 * password box and its reason line sit above it in z-order, so they must start
 * below the bar.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '../../dashboard/desktop.css'), 'utf8');

function rule(selector: string): string {
  const m = css.match(new RegExp(`(?:^|\\})\\s*${selector.replace('#', '\\#')}\\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

/** The fixed rem offset added to the safe-area top, e.g. "calc(max(.35rem,env(...)) + 2.9rem)" -> 2.9. */
function topOffsetRem(body: string): number {
  const top = body.match(/(?:^|;)top:([^;]+)/)?.[1] ?? '';
  const added = top.match(/\+\s*([\d.]+)rem\)\s*$/);
  return added ? Number(added[1]) : 0;
}

describe('locked-Mac password box and the Stop button', () => {
  it('the bar that holds Stop is pinned to the top', () => {
    expect(rule('.desktop-bar')).toMatch(/(?:^|;)top:0(?:;|$)/);
    expect(fs.readFileSync(path.join(__dirname, '../../dashboard/desktop.html'), 'utf8'))
      .toMatch(/class="desktop-bar"[^]*?id="stopButton"/);
  });

  for (const sel of ['#lockedPassword', '#lockedPasswordReason']) {
    it(`${sel} starts below the bar, so Stop stays clickable`, () => {
      // The bar is about 2.3rem tall (button .45rem padding x2 + one line, plus .35rem padding each side).
      expect(topOffsetRem(rule(sel))).toBeGreaterThanOrEqual(2.5);
    });
  }
});
