/**
 * Every warning on the console has a path to act on (operator, 2026-11-05: "all notifications that imply that
 * something is wrong or something needs the user should have an immediately actionable button or link").
 *
 * A line that gives something the tone or state `attn` or `bad` must say, on that line or the one above, how the
 * person acts on it. The claim is checked against the code, so it cannot be a bare assertion:
 *
 *   // warning-path: #/work/plans   a console route, which must be registered
 *   // warning-path: inline         this line or the next 3 carry an href or action
 *   // warning-path: pageHead       the page passes it to pageHead, which adds "Ask the agent about this"
 *   // warning-path: row            the page opens rows (onRow, click or href)
 *   // warning-path: askLink        the page renders askLink
 *   // warning-exempt: <reason>     why there is nothing to act on
 *
 * A new warning without one fails here.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const WARNING = /(\btone['"]?\s*:[^,}]*'(attn|bad)'|\bstate['"]?\s*:[^,}]*'(attn|bad)')/;
const files = fs.readdirSync(CONSOLE).filter((f) => f.endsWith('.js'));
const read = (f: string) => fs.readFileSync(path.join(CONSOLE, f), 'utf8');
const PAGE_OF: Record<string, string> = { 'home-model.js': 'console.js', 'needs-model.js': 'console.js', 'costs-model.js': 'costs.js' };
const pageOf = (f: string) => PAGE_OF[f] ?? f.replace(/-model\.js$/, '.js');
const routes = () => read('console.js');

/** What is wrong with one source text; an empty list means every warning in it has a checked path. */
function violations(file: string, src: string, pageSrc: string, routeSrc: string): string[] {
  const out: string[] = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (line.trim().startsWith('//') || !WARNING.test(line)) return;
    const where = `${file}:${i + 1}`;
    const tag = /\/\/ warning-(path: ?\S+|exempt: ?.*)$/.exec(line) ?? /^\s*\/\/ warning-(path: ?\S+|exempt: ?.*)$/.exec(lines[i - 1] ?? '');
    if (!tag) { out.push(`${where}: a warning with no path: ${line.trim().slice(0, 80)}`); return; }
    const [kind, ...rest] = tag[1].split(':');
    const value = rest.join(':').trim();
    if (kind === 'exempt') { if (value.length < 15) out.push(`${where}: an exemption needs a real reason`); return; }
    if (value.startsWith('#/')) { if (!routeSrc.includes(`'${value.slice(2).split('?')[0]}'`)) out.push(`${where}: ${value} is not a registered route`); return; }
    const checks: Record<string, () => boolean> = {
      inline: () => /href|action|onclick/.test(lines.slice(i, i + 4).join('\n')),
      pageHead: () => /pageHead\(/.test(pageSrc),
      row: () => /onRow|addEventListener\('click'|href/.test(pageSrc),
      askLink: () => /askLink\(/.test(pageSrc),
    };
    if (!checks[value]) out.push(`${where}: unknown path kind "${value}"`);
    else if (!checks[value]()) out.push(`${where}: says ${value}, but the page does not have it`);
  });
  return out;
}

describe('every warning in the console has a path', () => {
  it.each(files)('%s', (f: string) => {
    const page = fs.existsSync(path.join(CONSOLE, pageOf(f))) ? read(pageOf(f)) : read(f);
    expect(violations(f, read(f), page, routes())).toEqual([]);
  });
  it('scans the real thing', () => {
    const n = files.flatMap((f) => read(f).split('\n').filter((l) => !l.trim().startsWith('//') && WARNING.test(l))).length;
    expect(n).toBeGreaterThanOrEqual(100);
  });
});

describe('NEGATIVE CONTROLS: the check catches each fault', () => {
  const v = (src: string, page = '', route = "'work/plans'") => violations('x.js', src, page, route);
  it('a new warning with no path fails', () => { expect(v("  return { tone: 'bad', text: 'x' };").join()).toContain('no path'); });
  it('a state warning fails too', () => { expect(v("return { state: 'attn' };").join()).toContain('no path'); });
  it('a ternary warning fails too', () => { expect(v("  tone: a ? 'bad' : null,").join()).toContain('no path'); });
  it('a route that does not exist fails', () => { expect(v("// warning-path: #/nowhere\nreturn { tone: 'bad' };").join()).toContain('not a registered'); });
  it('a registered route passes', () => { expect(v("// warning-path: #/work/plans?s=x\nreturn { tone: 'bad' };")).toEqual([]); });
  it('a claim the page does not back fails', () => {
    expect(v("// warning-path: askLink\nreturn { tone: 'bad' };", 'nothing here').join()).toContain('does not have it');
    expect(v("// warning-path: pageHead\nreturn { tone: 'bad' };", 'nothing here').join()).toContain('does not have it');
    expect(v("// warning-path: row\nreturn { tone: 'bad' };", 'nothing here').join()).toContain('does not have it');
    expect(v("// warning-path: inline\nreturn { tone: 'bad' };").join()).toContain('does not have it');
  });
  it('an unknown kind fails', () => { expect(v("// warning-path: somehow\nreturn { tone: 'bad' };").join()).toContain('unknown path kind'); });
  it('a thin exemption fails, a real one passes', () => {
    expect(v("// warning-exempt: no\nreturn { tone: 'bad' };").join()).toContain('real reason');
    expect(v("// warning-exempt: shown nowhere on any page today\nreturn { tone: 'bad' };")).toEqual([]);
  });
  it('a calm tone needs nothing', () => { expect(v("return { tone: 'ok', state: 'unknown' };")).toEqual([]); });
});

describe('pageHead gives every warning a way to ask', () => {
  const dom = () => {
    const d = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/x' });
    globalThis.document = d.window.document; globalThis.window = d.window;
    globalThis.localStorage = d.window.localStorage; globalThis.sessionStorage = d.window.sessionStorage;
  };
  it('a warning headline and a warning fact get the link; a calm page and noAsk do not', async () => {
    dom();
    const { pageHead } = await import(path.join(CONSOLE, 'ui.js'));
    const link = (o: unknown) => pageHead(o).querySelector('a.ask-link');
    expect(decodeURIComponent(link({ eyebrow: 'e', headline: 'It broke', tone: 'bad' }).getAttribute('href'))).toContain('It broke');
    expect(decodeURIComponent(link({ eyebrow: 'e', headline: 'Fine', tone: 'ok', facts: [{ n: 2, label: 'failing', tone: 'bad' }] }).getAttribute('href'))).toContain('2 failing');
    expect(link({ eyebrow: 'e', headline: 'Fine', tone: 'ok' })).toBeNull();
    expect(link({ eyebrow: 'e', headline: 'It broke', tone: 'bad', noAsk: true })).toBeNull();
  });
});
