/**
 * The Spend tab's ON SWITCH is actually WIRED INTO THE PAGE.
 *
 * The failure this guards is exactly the one that shipped in Phase 1: a complete,
 * well-tested surface with no way for a human to reach it. A module full of passing unit
 * tests that no page ever imports is the same defect wearing a green tick, so these
 * assertions are about the PAGE, not the module.
 *
 * The load-order assertion is the load-bearing one. Every other call on this tab is gated
 * on the money layer being ON; if the switch rendered after them it would disappear inside
 * the very 503 it exists to fix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf-8');
const MODULE = fs.readFileSync(path.join(ROOT, 'dashboard', 'money-layer-enable.js'), 'utf-8');

describe('the switch is reachable from the page', () => {
  it('THE POINT: the Spend tab carries a mount point for the enable panel', () => {
    expect(HTML).toContain('id="moneyLayerEnable"');
  });

  it('the page imports the module — a module nothing imports is the Phase 1 defect again', () => {
    expect(HTML).toContain("import('/dashboard/money-layer-enable.js')");
  });

  it('the module ships: dashboard/ is a published package directory', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('dashboard');
  });

  it('LOAD ORDER: the switch renders BEFORE the gated spend fetches', () => {
    const fnAt = HTML.indexOf('async function loadRoutingSpend()');
    expect(fnAt).toBeGreaterThan(-1);
    const body = HTML.slice(fnAt, fnAt + 2000);
    const callAt = body.indexOf('loadMoneyLayerEnable()');
    const summaryAt = body.indexOf("/routing-spend/summary");
    expect(callAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(-1);
    // If this ever inverts, a 503 on the gated routes takes the switch down with it.
    expect(callAt).toBeLessThan(summaryAt);
  });

  it('MARKUP ORDER: the switch sits above the read-only view and the arming controls', () => {
    const switchAt = HTML.indexOf('id="moneyLayerEnable"');
    const glanceAt = HTML.indexOf('id="spendGlance"');
    const armAt = HTML.indexOf('id="spendArming"');
    expect(switchAt).toBeLessThan(glanceAt);
    expect(switchAt).toBeLessThan(armAt);
  });
});

describe('every class the module writes has CSS on the page', () => {
  // A renderer that emits class names the stylesheet never defines produces an unstyled
  // panel that looks broken — the kind of thing unit tests on the module cannot see.
  const classNames = Array.from(new Set(
    Array.from(MODULE.matchAll(/'(mle-[a-z-]+|spend-arm-[a-z-]+)'/g)).map((m) => m[1]),
  ));

  it('finds classes to check (guards the regex itself)', () => {
    expect(classNames.length).toBeGreaterThan(5);
  });

  for (const cls of classNames) {
    it(`.${cls} is defined in the dashboard stylesheet`, () => {
      expect(HTML).toMatch(new RegExp(`\\.${cls}[\\s,{:]`));
    });
  }
});

describe('the page never paraphrases what the operator approves', () => {
  it('the plan text and the restart confirmation are rendered from the SERVER response', () => {
    // The commit sends back only the plan identity, so the words on screen must come from
    // the server's own fields — a client-authored summary could describe a different action.
    expect(MODULE).toContain('plan.renderedText');
    expect(MODULE).toContain('mint.confirmationText');
  });

  it('the PIN is never part of a plan request', () => {
    // The DECLARATION and body only — the doc comment on the next export mentions the PIN
    // deliberately, and matching it would make this test pass or fail on prose.
    const from = MODULE.indexOf('export function planRequest');
    const body = MODULE.slice(from, MODULE.indexOf('\n}', from) + 2);
    expect(body).toContain('return { action };');
    expect(body).not.toMatch(/pin/i);
  });
});
