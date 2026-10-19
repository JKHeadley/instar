/**
 * Silent-gate instance #7 (2026-10-19, Mac Studio). Two blocking menus sat unanswered on an
 * autonomous session for many minutes while the PermissionPromptAutoResolver (on, healthy,
 * ticking) said nothing: no key, no attention item, no audit row. Reproduced live with a
 * throwaway session: Claude Code drew its model-switch menu, 17 blank rows, then one status
 * line ("✻ Waiting for API response · will retry in 2m 40s") at the pane bottom. Three links
 * failed in a row, each tested here against the captured pane (tests/fixtures/
 * claude-code-model-switch-menu-pane.txt, verbatim rows):
 *   1. the monitor loop's pre-gate read the last 5 RAW rows (blanks + status line): no menu shape;
 *   2. the 16-row evaluate capture was 15 blanks + that line: nothing for either layer to see;
 *   3. even with the menu in view, Layer 3 declined: the status line was the last line (not menu
 *      structure) and the ❯ row sat 8 lines above the bottom, outside the 6-line window.
 * Layer 2 (the only layer that presses a key) must stay exactly as strict as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { meaningfulNonBlankTail, meaningfulTail } from '../../src/core/paneText.js';
import {
  LAYER3_PERSIST_TICKS,
  PermissionPromptAutoResolver,
  RESOLVER_PREGATE_RE,
  detectApprovalPrompt,
  detectPersistingMenu,
  stripTransientTrailer,
  toPaneTailLines,
  type PermissionPromptResolverDeps,
  type ResolverAuditRow,
  type ResolverDefect,
} from '../../src/monitoring/PermissionPromptAutoResolver.js';
import { looksGeneratingNow } from '../../src/monitoring/sentinelWiring.js';

const PANE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-code-model-switch-menu-pane.txt'), 'utf8');

function harness() {
  const audits: ResolverAuditRow[] = [];
  const defects: ResolverDefect[] = [];
  const keys: string[] = [];
  let now = 1_000_000;
  const deps: PermissionPromptResolverDeps = {
    sendKey: (_s, k) => { keys.push(k); return true; },
    reCaptureTail: async () => null,
    isGenerating: (text) => looksGeneratingNow(text, 'claude-code'),
    raiseDefect: (d) => defects.push(d),
    appendAudit: (r) => audits.push(r),
    now: () => now,
    emergencyDisabled: () => false,
  };
  return { resolver: new PermissionPromptAutoResolver(deps), audits, defects, keys, tick: () => { now += 5_000; } };
}

describe('the captured pane: blank padding and a status line under a live menu', () => {
  it('counts blank rows the way the live pane had them (the shape under test is real)', () => {
    const rows = PANE.split('\n');
    const menuEnd = rows.findIndex((r) => /Esc to cancel/.test(r));
    const status = rows.findIndex((r) => /Waiting for API response/.test(r));
    expect(menuEnd).toBeGreaterThan(0);
    expect(status - menuEnd - 1).toBe(17);
  });

  it('link 1: the old raw-row 5-line tail hides the menu; the non-blank tail shows it', () => {
    expect(RESOLVER_PREGATE_RE.test(meaningfulTail(PANE, 5))).toBe(false);
    expect(RESOLVER_PREGATE_RE.test(meaningfulNonBlankTail(PANE, 5))).toBe(true);
  });

  it('link 2: the old 16-row capture is one status line; the non-blank one carries the whole menu', () => {
    expect(toPaneTailLines(meaningfulTail(PANE, 16))).toHaveLength(1);
    const lines = toPaneTailLines(meaningfulNonBlankTail(PANE, 16));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(lines.some((l) => /Switch automatically/.test(l.text) && l.leadGlyphs.includes('❯'))).toBe(true);
  });

  it('link 3: Layer 3 now sees the menu (status line ignored, wider window); Layer 2 still declines', () => {
    const lines = toPaneTailLines(meaningfulNonBlankTail(PANE, 16));
    const generating = looksGeneratingNow(meaningfulNonBlankTail(PANE, 16), 'claude-code');
    expect(generating).toBe(false); // a retry-wait line is not activity
    expect(detectApprovalPrompt(lines, 'claude-code', generating)).toBeNull(); // never auto-switch a model
    const menu = detectPersistingMenu(lines, generating);
    expect(menu).not.toBeNull();
    expect(menu!.optionLabels).toEqual(['1. Switch automatically', '2. Stay on Fable 5.1', '3. Type something.', '4. Chat about this']);
  });

  it('a REAL spinner under the menu still declines (the session is working, not parked)', () => {
    const working = PANE.replace(/✻ Waiting for API response.*$/m, '✽ Blanching… (esc to interrupt)');
    const text = meaningfulNonBlankTail(working, 16);
    const generating = looksGeneratingNow(text, 'claude-code');
    expect(generating).toBe(true);
    expect(detectPersistingMenu(toPaneTailLines(text), generating)).toBeNull();
  });

  it('the whole chain: pre-gate hit → evaluate → ONE Terminal defect at the threshold, audited from the first tick, no key pressed', async () => {
    const h = harness();
    const tail = toPaneTailLines(meaningfulNonBlankTail(PANE, 16));
    for (let i = 0; i < LAYER3_PERSIST_TICKS + 2; i++) { await h.resolver.evaluate('sess', tail); h.tick(); }
    expect(h.keys).toEqual([]);
    expect(h.defects.map((d) => d.layer)).toEqual(['layer3']);
    expect(h.audits.map((a) => a.outcome)).toEqual(['menu-observed', 'menu-unanswered-terminal']);
    expect(h.audits[0].matchedPatternNames).toEqual(['layer3-menu']);
    // The audit carries no pane bytes: only the structure digest.
    expect(JSON.stringify(h.audits)).not.toMatch(/Switch automatically|Opus|Fable/);
  });
});

describe('stripTransientTrailer', () => {
  const menu = ['Some prompt', '❯ 1. Yes', '  2. No', '  Esc to cancel'];
  it('drops a trailing retry-wait line and the permission-mode status bar; keeps everything else', () => {
    const t = toPaneTailLines([...menu, '✻ Waiting for API response · will retry in 9s', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'));
    expect(stripTransientTrailer(t).map((l) => l.text)).toEqual(['Some prompt', '1. Yes', '2. No', 'Esc to cancel']);
  });
  it('never strips an interior line, never empties the tail', () => {
    const t = toPaneTailLines(['will retry in 3s', ...menu].join('\n'));
    expect(stripTransientTrailer(t)).toHaveLength(5);
    const only = toPaneTailLines('✻ Waiting for API response · will retry in 2s');
    expect(stripTransientTrailer(only)).toHaveLength(1);
  });
  it('second-pass probe A/B: a numbered list in a tool result above a trailer is NOT a menu', () => {
    // `⎿` is a lead glyph; three numbered lines; the retry-wait line is the pane bottom.
    const toolResult = toPaneTailLines(['⏺ Here is the plan:', '  ⎿  1. Install deps', '     2. Run the build', '     3. Push', '✻ Waiting for API response · will retry in 2m 40s · check your network'].join('\n'));
    expect(detectPersistingMenu(toolResult, false)).toBeNull();
    const quoted = toPaneTailLines(['│ 1. first', '│ 2. second', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'));
    expect(detectPersistingMenu(quoted, false)).toBeNull();
    // The same list with a real affordance line IS a menu (unchanged behaviour).
    const realMenu = toPaneTailLines(['Pick one:', '❯ 1. first', '  2. second', '  Esc to cancel', '✻ Waiting for API response · will retry in 9s'].join('\n'));
    expect(detectPersistingMenu(realMenu, false)).not.toBeNull();
  });

  it('a bare status bar under an idle prompt is NOT a menu (no false Layer-3 episode)', () => {
    const idle = toPaneTailLines(['⏺ Done.', '❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'));
    expect(detectPersistingMenu(idle, false)).toBeNull();
  });
});

describe('meaningfulNonBlankTail', () => {
  it('returns the last n non-blank rows, skipping interior and trailing blanks', () => {
    expect(meaningfulNonBlankTail('a\n\n\nb\n \nc\n\n', 2)).toBe('b\nc');
    expect(meaningfulNonBlankTail('\n \n', 3)).toBe('');
  });
});
