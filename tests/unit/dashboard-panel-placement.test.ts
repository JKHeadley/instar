/**
 * Dashboard panel-placement floor (Structure > Willpower).
 *
 * Every tab panel declared after `</main>` in dashboard/index.html is a direct
 * `.app` grid child. `switchTab()` hides the sidebar too, so a panel WITHOUT
 * explicit grid placement auto-places into the 280px sidebar COLUMN — the
 * "squished to the side" bug the operator reported on 2026-07-08 (screenshots:
 * all content in a ~185px strip on a 1280px viewport).
 *
 * The fix existed as a CSS comment on .ph-root since the Process Health tab —
 * and every panel added after it (Tokens, LLM Activity, Routing Map, Spend, …
 * 14 in total) repeated the bug, because a comment is a wish. This test is the
 * guarantee: a NEW after-main panel that lacks a placement-carrying class
 * fails the build with instructions, instead of shipping squished.
 *
 * Matcher notes (kept deliberately simple, guarded by a population floor):
 * top-level panels in the after-main markup region are written at exactly
 * 4-space indentation (all 27 current ones). Nested content sits deeper and
 * fixed-position overlays sit at 2-space body level — neither participates in
 * the .app grid flow the way a top-level panel does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = path.resolve(__dirname, '..', '..', 'dashboard', 'index.html');

/** Classes whose CSS carries explicit grid placement (grid-column) — verified below. */
const PLACEMENT_CLASSES = [
  'tab-panel',
  'ph-root',
  'files-container',
  'jobs-container',
  'systems-container',
  'features-container',
  'dropzone-container',
];

/**
 * 4-space-indented after-main elements that legitimately carry NO grid
 * placement because they are out of normal flow (position: fixed / empty
 * mount points). Adding here requires the same justification — verify the
 * element's CSS is out-of-flow before exempting it.
 */
const OUT_OF_FLOW_EXEMPT: string[] = [
  // Empty mount point (renders nothing itself); its injected content
  // (.wa-qr-panel) is position: fixed — never a grid-flow participant.
  'waQrContainer',
];

function readDashboard(): string {
  return fs.readFileSync(DASHBOARD_HTML, 'utf-8');
}

/**
 * The after-</main> MARKUP region: from the real closing tag of the <main>
 * element (not the literal "</main>" appearing in CSS/JS comments — anchor on
 * the <main opener first) to the first <script> that follows it (where the
 * page's JS begins; template literals in JS must not be scanned as markup).
 */
function afterMainMarkup(html: string): string {
  const mainOpen = html.indexOf('<main ');
  expect(mainOpen, 'dashboard/index.html must contain a <main> element').toBeGreaterThan(-1);
  const mainClose = html.indexOf('</main>', mainOpen);
  expect(mainClose, '<main> must have a closing tag').toBeGreaterThan(mainOpen);
  const scriptStart = html.indexOf('<script', mainClose);
  expect(scriptStart, 'a <script> block must follow the markup region').toBeGreaterThan(mainClose);
  return html.slice(mainClose, scriptStart);
}

/** Top-level (4-space-indented) element openers with an id, in the markup region. */
function topLevelOpeners(slice: string): Array<{ id: string; tag: string }> {
  const openers: Array<{ id: string; tag: string }> = [];
  const re = /^ {4}<div\b[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    openers.push({ id: m[1], tag: m[0] });
  }
  return openers;
}

describe('dashboard panel placement floor', () => {
  it('the shared .tab-panel rule exists and spans the grid', () => {
    const html = readDashboard();
    // The rule the panels rely on must keep its placement — deleting or
    // weakening it silently re-squishes every tab at once.
    const ruleMatch = html.match(/\.tab-panel\s*\{[^}]*\}/);
    expect(ruleMatch, 'the .tab-panel CSS rule must exist').toBeTruthy();
    expect(ruleMatch![0]).toContain('grid-column: 1 / -1');
    expect(ruleMatch![0]).toContain('min-width: 0');
  });

  it('every placement class actually declares grid-column in CSS', () => {
    const html = readDashboard();
    for (const cls of PLACEMENT_CLASSES) {
      const rule = html.match(new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`));
      expect(rule, `.${cls} CSS rule must exist`).toBeTruthy();
      expect(
        rule![0].includes('grid-column'),
        `.${cls} must declare grid-column (it is relied on for after-main panel placement)`
      ).toBe(true);
    }
  });

  it('every after-main top-level panel carries a placement class (no silent squish)', () => {
    const html = readDashboard();
    const slice = afterMainMarkup(html);
    const openers = topLevelOpeners(slice);

    // Population floor: the sweep must actually see the known panel
    // population (27 at the time of writing). If this drops far below that,
    // the matcher regressed — fail loudly rather than silently passing.
    expect(
      openers.length,
      'expected the after-main top-level panel population to be visible to the floor'
    ).toBeGreaterThanOrEqual(20);

    const bare: string[] = [];
    for (const { id, tag } of openers) {
      if (OUT_OF_FLOW_EXEMPT.includes(id)) continue;
      const classMatch = tag.match(/class="([^"]*)"/);
      const classes = classMatch ? classMatch[1].split(/\s+/) : [];
      if (!classes.some(c => PLACEMENT_CLASSES.includes(c))) bare.push(id);
    }

    expect(
      bare,
      `After-main panels without grid placement (the "squished to the side" bug): ${bare.join(', ')}. ` +
        `Fix: add class="tab-panel" to the panel's opening <div> (or, for a genuinely fixed-position ` +
        `overlay, add its id to OUT_OF_FLOW_EXEMPT in this test with a justification comment).`
    ).toEqual([]);
  });

  it('the markup-region anchor skips CSS/JS mentions of </main>', () => {
    // Guard the floor itself: the slice must start at the REAL main close in
    // markup — not at a "</main>" inside a <style> comment (which would scan
    // style/JS text as markup and both miss panels and flag phantoms).
    const html = readDashboard();
    const slice = afterMainMarkup(html);
    // The <style> block (which contains the .tab-panel comment naming
    // "</main>") must not be part of the slice, and neither may the <main>
    // element itself.
    expect(slice.includes('<main ')).toBe(false);
    expect(slice.includes('.tab-panel {')).toBe(false);
  });
});
