/**
 * Dashboard control-labeling floor — F5 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; Structure > Willpower).
 *
 * F5: every interactive control (button) has a discernible label — visible
 * text, a `title`, or an `aria-label`. The audit (2026-07-08) found a handful
 * of icon-only buttons (a bare "←" / "×" / "+") whose function a user had to
 * guess. This floor fails, naming the offender, if any button ships with only
 * an icon glyph and no accessible label — so a NEW icon-only control cannot
 * regress silently.
 *
 * A button counts as LABELED when its opening tag carries `title=` or
 * `aria-label=`, OR its inner content contains alphanumeric text (a real word),
 * OR its content is dynamically interpolated (`${...}` / `' + ...`) — those are
 * labeled at runtime and cannot be judged statically. It counts as UNLABELED
 * when its only content is icon glyphs / HTML entities with no accessible name.
 *
 * Guarded by a population floor so a regressed matcher fails loudly, not silently.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

/** Match each `<button ...> ... </button>` span (content may include entities). */
const BUTTON_RE = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;

function isLabeled(openTag: string, inner: string): boolean {
  // Explicit accessible label on the tag.
  if (/\b(?:aria-label|title)\s*=/.test(openTag)) return true;
  // Dynamic content — labeled at runtime, not statically judgeable.
  if (/\$\{|'\s*\+|"\s*\+|\+\s*'|\+\s*"/.test(inner)) return true;
  // Strip nested tags + HTML entities, then require a real alphanumeric word.
  const text = inner
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, '')
    .trim();
  return /[A-Za-z0-9]/.test(text);
}

describe('dashboard control-labeling floor (F5)', () => {
  it('every button has a discernible label (text, title, or aria-label)', () => {
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');

    const unlabeled: string[] = [];
    let seen = 0;
    let m: RegExpExecArray | null;
    while ((m = BUTTON_RE.exec(html)) !== null) {
      seen++;
      const [, openTag, inner] = m;
      if (!isLabeled(openTag, inner)) {
        // Report a short, findable snippet of the offending button.
        unlabeled.push(`<button${openTag}>${inner.trim().slice(0, 24)}</button>`);
      }
    }

    // Population floor: the sweep must see the known button population.
    expect(seen, 'buttons visible to the F5 floor').toBeGreaterThanOrEqual(30);

    expect(
      unlabeled,
      `Icon-only / unlabeled buttons (the F5 bug): ${unlabeled.join(' | ')}. ` +
        `Add a title="…" and aria-label="…" naming what the button does.`
    ).toEqual([]);
  });
});
