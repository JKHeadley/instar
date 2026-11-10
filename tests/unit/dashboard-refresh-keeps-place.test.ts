/**
 * Dashboard UX Standard F12 floor: a refresh keeps the operator's place.
 *
 * Operator, topic 136706 (2026-11-03): "the screen (and many other on the dashboard)
 * regularly 'blips', seemingly due to some periodic data fetching, and jumps back to
 * the top of the page". Measured: #/work/development?s=shipping went 1048 -> 479.
 *
 * Runs the SHIPPED page renderers in jsdom, twice, the way console.js route() does:
 * every registered page is found by parsing NATIVE, so a new page is covered without
 * touching this file. The population floor proves the sweep still sees them all, and
 * the negative control proves the same predicate catches a page that breaks the floor.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const read = (f: string) => fs.readFileSync(path.join(CONSOLE, f), 'utf8');

let dom: JSDOM;
let ui: any;
const realFetch = globalThis.fetch;

function installDom() {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/home', pretendToBeVisual: true });
  const w: any = dom.window;
  for (const k of ['window', 'document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame', 'URLSearchParams']) {
    if (k in w) (globalThis as any)[k] = w[k];
  }
  (globalThis as any).window = w;
  (globalThis as any).localStorage = w.localStorage;
  (globalThis as any).sessionStorage = w.sessionStorage;
  (globalThis as any).WebSocket = class { close() {} addEventListener() {} send() {} };
  (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }));
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
}

function mainNode() {
  const main = document.createElement('main');
  main.id = 'main';
  document.body.replaceChildren(main);
  return main;
}

beforeAll(async () => {
  installDom();
  ui = await import('../../dashboard/console/ui.js');
});
afterAll(() => { (globalThis as any).fetch = realFetch; });
beforeEach(() => { installDom(); ui.newArrival(); vi.clearAllMocks(); });

const fold = (label: string, open = false) => {
  const d = document.createElement('details');
  d.open = open;
  const s = document.createElement('summary');
  s.textContent = label;
  d.append(s);
  return d;
};
const toggle = (label: string, onClick?: () => void) => {
  const b = document.createElement('button');
  b.className = 'list-head';
  b.setAttribute('aria-expanded', 'false');
  b.textContent = label;
  b.addEventListener('click', () => { b.setAttribute('aria-expanded', b.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'); if (onClick) onClick(); });
  return b;
};

describe('setKids keeps the place across a repaint', () => {
  it('a fold the operator opened stays open, even when its count changed', () => {
    const main = mainNode();
    ui.setKids(main, fold('3 more details'));
    main.querySelector('details').open = true;
    ui.setKids(main, fold('4 more details'));
    expect(main.querySelector('details').open).toBe(true);
  });

  it('a fold the operator closed stays closed, when the page would open it by default', () => {
    const main = mainNode();
    ui.setKids(main, fold('Keys', true));
    main.querySelector('details').open = false;
    ui.setKids(main, fold('Keys', true));
    expect(main.querySelector('details').open).toBe(false);
  });

  it('a button fold is re-opened through its own handler, so the page state agrees', () => {
    const main = mainNode();
    const clicked = vi.fn();
    ui.setKids(main, toggle('Jobs 3'));
    main.querySelector('button').click();
    ui.setKids(main, toggle('Jobs 4', clicked));
    expect(main.querySelector('button').getAttribute('aria-expanded')).toBe('true');
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('a page that repaints BECAUSE its own fold state changed is not fought', () => {
    // Development: tapping a section head sets view.open and repaints. The tap must win.
    const main = mainNode();
    let open = 'feedback';
    const head = (id: string) => {
      const b = document.createElement('button');
      b.textContent = id;
      b.setAttribute('aria-expanded', open === id ? 'true' : 'false');
      b.addEventListener('click', () => { open = id; paint(); });
      return b;
    };
    const paint = () => ui.setKids(main, head('feedback'), head('shipping'));
    paint();
    [...main.querySelectorAll('button')][1].click();
    const [f, s] = [...main.querySelectorAll('button')];
    expect(open).toBe('shipping');
    expect(f.getAttribute('aria-expanded')).toBe('false');
    expect(s.getAttribute('aria-expanded')).toBe('true');
  });

  it('a fold the operator opened survives several repaints in a row', () => {
    const main = mainNode();
    ui.setKids(main, fold('Keys'));
    main.querySelector('details').open = true;
    ui.setKids(main, fold('Keys'));
    ui.setKids(main, fold('Keys'));
    ui.setKids(main, fold('Keys'));
    expect(main.querySelector('details').open).toBe(true);
    main.querySelector('details').open = false;
    ui.setKids(main, fold('Keys'));
    expect(main.querySelector('details').open).toBe(false);
  });

  it('a fold left closed is not touched', () => {
    const main = mainNode();
    const clicked = vi.fn();
    ui.setKids(main, toggle('Jobs'));
    ui.setKids(main, toggle('Jobs', clicked));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('puts the window back when the repaint moved it, and leaves it alone when it did not', () => {
    const main = mainNode();
    ui.setKids(main, fold('a'));
    (window as any).scrollY = 900; // captured before the repaint
    let during = 900;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => during });
    const orig = main.replaceChildren.bind(main);
    main.replaceChildren = (...k: any[]) => { orig(...k); during = 100; }; // the browser clamped
    ui.setKids(main, fold('a'));
    expect((window as any).scrollTo).toHaveBeenCalledWith(expect.anything(), 900);
    main.replaceChildren = orig;
    (window as any).scrollTo.mockClear();
    during = 900;
    ui.setKids(main, fold('a'));
    expect((window as any).scrollTo).not.toHaveBeenCalled();
  });

  it('gives focus back to the same control', () => {
    const main = mainNode();
    const btn = () => { const b = document.createElement('button'); b.textContent = 'Check again'; return b; };
    ui.setKids(main, btn());
    main.querySelector('button').focus();
    ui.setKids(main, btn());
    expect(document.activeElement).toBe(main.querySelector('button'));
  });

  it('a nested node is a plain replace: only <main> carries the place', () => {
    const main = mainNode();
    const inner = document.createElement('div');
    main.append(inner);
    ui.setKids(inner, fold('a'));
    inner.querySelector('details').open = true;
    ui.setKids(inner, fold('a'));
    expect(inner.querySelector('details').open).toBe(false);
  });
});

describe('firstPaint: a placeholder never replaces real content', () => {
  it('shows before the first real paint, and is a no-op after', () => {
    const main = mainNode();
    const skel = () => { const p = document.createElement('p'); p.className = 'skeleton'; return p; };
    ui.firstPaint(main, skel());
    expect(main.querySelector('.skeleton')).not.toBeNull();
    ui.setKids(main, fold('real'));
    ui.firstPaint(main, skel());
    expect(main.querySelector('.skeleton')).toBeNull();
    expect(main.querySelector('details')).not.toBeNull();
  });
  it('a read that failed still counts as painted: the error is not blanked every 30 s', () => {
    const main = mainNode();
    ui.setKids(main, document.createTextNode(''), document.createElement('p'));
    ui.firstPaint(main, document.createElement('h1'));
    expect(main.querySelector('h1')).toBeNull();
  });
});

describe('arrivalScroll: once per arrival', () => {
  it('scrolls once, however many renders follow, and again only for a new arrival', () => {
    const n = document.createElement('section');
    const spy = n.scrollIntoView as any;
    expect(ui.arrivalScroll(n)).toBe(true);
    expect(ui.arrivalScroll(n)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    ui.newArrival();
    expect(ui.arrivalScroll(n)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('a section that is not there yet does not use up the arrival', () => {
    expect(ui.arrivalScroll(null)).toBe(false);
    expect(ui.arrivalScroll(document.createElement('section'))).toBe(true);
  });
  it('a different key is a different scroll (a row the operator just opened)', () => {
    const n = document.createElement('div');
    expect(ui.arrivalScroll(n, { key: 'row:a' })).toBe(true);
    expect(ui.arrivalScroll(n, { key: 'row:b' })).toBe(true);
    expect(ui.arrivalScroll(n, { key: 'row:a' })).toBe(false);
  });
  it('opens a closed section on the way', () => {
    const sec = document.createElement('section');
    const head = toggle('Waiting');
    sec.append(head);
    document.body.append(sec);
    ui.arrivalScroll(sec, { open: true });
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('refreshHeld: F9 at the shell', () => {
  const input = (type = 'text') => { const i = document.createElement('input'); i.type = type; return i; };
  it('a clean page is not held', () => {
    const main = mainNode();
    main.append(document.createElement('button'));
    expect(ui.refreshHeld(main)).toBe(false);
    expect(ui.refreshHeld(null)).toBe(false);
  });
  it('a focused text field holds; a focused checkbox or button does not', () => {
    const main = mainNode();
    const text = input(); const box = input('checkbox'); const b = document.createElement('button');
    main.append(text, box, b);
    box.focus(); expect(ui.refreshHeld(main)).toBe(false);
    b.focus(); expect(ui.refreshHeld(main)).toBe(false);
    text.focus(); expect(ui.refreshHeld(main)).toBe(true);
  });
  it('a typed field holds after focus has left; a pre-filled one does not', () => {
    const main = mainNode();
    const filled = input(); filled.setAttribute('value', 'saved filter');
    main.append(filled);
    expect(ui.refreshHeld(main)).toBe(false);
    filled.value = 'saved filter and more';
    expect(ui.refreshHeld(main)).toBe(true);
  });
  it('an open-interaction marker holds', () => {
    const main = mainNode();
    const c = document.createElement('div'); c.setAttribute('data-interaction-open', 'pin-entry');
    main.append(c);
    expect(ui.refreshHeld(main)).toBe(true);
  });
  it('text the operator is selecting holds', () => {
    const main = mainNode();
    const p = document.createElement('p'); p.textContent = 'copy this';
    main.append(p);
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    expect(ui.refreshHeld(main)).toBe(true);
    sel.removeAllRanges();
  });
});

// ── every registered page, rendered twice ──────────────────────────────────
function nativePages(src: string) {
  const body = /const NATIVE = \{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
  const out: { route: string; fn: string }[] = [];
  for (const m of body.matchAll(/'([^']+)':\s*(render\w+)/g)) out.push({ route: m[1], fn: m[2] });
  return out;
}
function importsByName(src: string) {
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/import \{([^}]*)\} from '\.\/([\w-]+\.js)'/g)) for (const n of m[1].split(',')) map[n.trim()] = m[2];
  return map;
}

/** What one page does across a first render and a refresh. Returns what broke the floor. */
async function refreshViolations(render: (main: any) => any) {
  const problems: string[] = [];
  const main = mainNode();
  ui.newArrival();
  await render(main);
  // Everything that scrolls goes through HTMLElement.prototype.scrollIntoView here.
  const spy = (window as any).HTMLElement.prototype.scrollIntoView;
  const scrollsAfterFirst = spy.mock.calls.length;
  const before = main.textContent;
  const running = render(main);
  // The repaint has started and its reads are not back: this is what the operator would see.
  if (before && !main.textContent) problems.push('blank while refreshing');
  if (main.querySelector('.skeleton')) problems.push('placeholder over real content');
  await running;
  if (spy.mock.calls.length > scrollsAfterFirst) problems.push('scrolled on refresh');
  return problems;
}

describe('population floor + the sweep', () => {
  const src = read('console.js');
  const pages = nativePages(src);
  const imports = importsByName(src);

  it('sees every registered page (a regressed parser fails here, not silently)', () => {
    expect(pages.length).toBeGreaterThanOrEqual(19);
    for (const p of pages) expect(imports[p.fn], `${p.fn} import`).toBeTruthy();
  });

  it.each(nativePages(read('console.js')).map((p) => [p.route, p.fn]))('%s: a refresh shows no placeholder and no scroll', async (route: string, fn: string) => {
    const mod = await import(path.join(CONSOLE, importsByName(read('console.js'))[fn]));
    // A deep link that stays in the address while the page refreshes: the shape that jumped.
    location.hash = `#/${route}?s=shipping`;
    const failed = { ok: false, status: 500, reason: 'the server answered 500' };
    const ctx = { get: vi.fn(async () => failed), post: vi.fn(async () => failed), getCommitments: vi.fn(async () => failed) };
    expect(await refreshViolations((main) => mod[fn](main, ctx))).toEqual([]);
  }, 30000);
});

describe('NEGATIVE CONTROL: the same check catches a page that breaks the floor', () => {
  const skeleton = () => { const p = document.createElement('p'); p.className = 'skeleton'; p.textContent = 'Loading'; return p; };
  it('an always-skeleton page is caught', async () => {
    const page = async (main: any) => { ui.setKids(main, skeleton()); await Promise.resolve(); ui.setKids(main, fold('real')); };
    expect(await refreshViolations(page)).toContain('placeholder over real content');
  });
  it('a page that scrolls on every render is caught', async () => {
    const page = async (main: any) => { const s = document.createElement('section'); ui.setKids(main, s); s.scrollIntoView({ block: 'start' }); };
    expect(await refreshViolations(page)).toContain('scrolled on refresh');
  });
  it('a page that blanks first is caught', async () => {
    const page = async (main: any) => { main.replaceChildren(); await Promise.resolve(); const p = document.createElement('p'); p.textContent = 'real'; main.replaceChildren(p); };
    expect(await refreshViolations(page)).toContain('blank while refreshing');
  });
  it('a raw replace really does lose an open fold: the hazard is real', () => {
    const main = mainNode();
    ui.setKids(main, fold('a'));
    main.querySelector('details').open = true;
    main.replaceChildren(fold('a'));
    expect(main.querySelector('details').open).toBe(false);
  });
  it('the shipped pages pass because they use the helpers, and the scanner sees a raw call', () => {
    expect(rawViolations('main.replaceChildren(x);\n')).toHaveLength(1);
    expect(rawViolations('sec.scrollIntoView({ block: "start" });\n')).toHaveLength(1);
    expect(rawViolations('window.scrollTo(0, 0);\n')).toHaveLength(1);
    expect(rawViolations('arrivalScroll(sec);\nsetKids(main, x);\n')).toHaveLength(0);
  });
});

// A page must not bypass the helpers. files.js scrolls the file tree it owns after an
// operator's click, and chats.js jumps to a pinned message when the operator taps the
// pinned bar (conversation-pinned-messages); neither is a refresh path.
const RAW = /\bmain\.replaceChildren\(|\.scrollIntoView\(|\bwindow\.scrollTo\(/;
function rawViolations(src: string) { return src.split('\n').filter((l) => RAW.test(l)); }
const OWN_SCROLLS: Record<string, number> = { 'ui.js': 3, 'console.js': 3, 'files.js': 1, 'chats.js': 1 };

describe('static floor: no page bypasses the helpers', () => {
  const files = fs.readdirSync(CONSOLE).filter((f) => f.endsWith('.js') && !f.endsWith('-model.js'));
  it('scans the whole console', () => { expect(files.length).toBeGreaterThanOrEqual(20); });
  it.each(files)('%s', (f: string) => {
    expect(rawViolations(read(f)).length).toBeLessThanOrEqual(OWN_SCROLLS[f] ?? 0);
  });
  it('route() opens a new arrival, and the refresh tick holds for an open interaction', () => {
    const src = read('console.js');
    expect(src).toMatch(/closeSheet\(\);\s*newArrival\(\);/);
    expect(src).toMatch(/refreshHeld\(main\)/);
  });
});

describe('legacy dashboard: measured clean except where fixed; no refresh-driven scroll appears', () => {
  const html = fs.readFileSync(path.resolve(CONSOLE, '../index.html'), 'utf8');
  it('its only scrolls are the two operator clicks (Resume live output, a headline action)', () => {
    const lines = html.split('\n').filter((l) => /\.scrollIntoView\(/.test(l));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes("block: 'end'"))).toBe(true);
    expect(lines.some((l) => l.includes("behavior: 'smooth'"))).toBe(true);
  });
  it('a missed Integrated-Being read does not blank rows it already has', () => {
    expect(html).toMatch(/if \(!tbody\.dataset\.ibRows\) tbody\.innerHTML/);
    expect(html).toMatch(/tbody\.dataset\.ibRows = '1'/);
  });
});
