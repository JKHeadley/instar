/**
 * Console "Files" page (docs/specs/console-features/people-settings.md, "Files", legacy
 * tab `files`): every decision in the model on both sides (paths, a folder cut at 500 with
 * or without the server's flag, what an opened file is, editable or not and why, the save
 * body and answer, the kept edit, recent and pinned, the name search, the folder-access
 * body), a drift guard tying the page's never-editable list to the server's own predicate,
 * and the shipped console in jsdom: browse, a refused key file said in words, rendered
 * markdown only through the sanitizer (source when it is missing), an edit through a 409
 * conflict and an overwrite, and a folder added on the bearer token with no PIN anywhere.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import {
  normPath, joinPath, parentOf, baseName, crumbs, folderWords, fileHash, pathFromHash, sizeWords, fileKind,
  refusalWords, buildListing, buildFile, readOnly, saveBody, saveResult, conflictWords, stashFor, readStash,
  parseRecent, pushRecent, pinnedFrom, searchLoaded, buildConfig, folderInput, configPatch, configResultWords,
  filesHeadline, NEVER_EDITABLE, RECENT_MAX,
} from '../../dashboard/console/files-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';
import { isNeverEditable, isNeverServed } from '../../src/server/fileRoutes.js';

const ok = (data: unknown) => ({ status: 200, data });
const no = (status: number, error: string, extra: Record<string, unknown> = {}) => ({ status, data: { error, ...extra } });

describe('paths and words', () => {
  it('paths are normalised the way the server knows them', () => {
    expect(normPath('./docs//specs/')).toBe('docs/specs');
    expect(normPath('')).toBe('');
    expect(normPath(undefined as unknown as string)).toBe('');
    expect(joinPath('', 'CLAUDE.md')).toBe('CLAUDE.md');
    expect(joinPath('docs', 'a.md')).toBe('docs/a.md');
    expect(parentOf('docs/specs/a.md')).toBe('docs/specs');
    expect(parentOf('a.md')).toBe('');
    expect(baseName('docs/a.md')).toBe('a.md');
    expect(crumbs('docs/specs/a.md')).toEqual([{ name: 'docs', path: 'docs' }, { name: 'specs', path: 'docs/specs' }]);
    expect(folderWords('a.md')).toBe('top folder');
    expect(folderWords('.claude/CLAUDE.md')).toBe('.claude/');
  });
  it('the deep link round-trips, and a legacy ?tab=files&path= query reads the same', () => {
    expect(fileHash('docs/a b.md')).toBe('#/settings/files?path=docs%2Fa%20b.md');
    expect(pathFromHash(fileHash('docs/a b.md'))).toBe('docs/a b.md');
    expect(pathFromHash('?tab=files&path=.claude/CLAUDE.md')).toBe('.claude/CLAUDE.md');
    expect(pathFromHash('#/settings/files')).toBe('');
  });
  it('sizes and kinds', () => {
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(2048)).toBe('2.0 KB');
    expect(sizeWords(3 * 1_048_576)).toBe('3.0 MB');
    expect(sizeWords(Number.NaN)).toBe('');
    expect(fileKind('README.md')).toEqual({ kind: 'markdown', language: 'markdown' });
    expect(fileKind('a.ts')).toEqual({ kind: 'code', language: 'typescript' });
    expect(fileKind('Makefile')).toEqual({ kind: 'code', language: null });
    expect(fileKind('logo.png')).toEqual({ kind: 'image', mime: 'image/png' });
  });
});

describe('refusals are said, never hidden', () => {
  it('each server refusal has its own plain words', () => {
    expect(refusalWords(403, { error: 'Access to this path is not permitted' })).toMatchObject({ kind: 'never-shown', text: expect.stringMatching(/^This file is never shown, by design/) });
    expect(refusalWords(403, { error: 'Access to this file is blocked for security reasons' })).toMatchObject({ kind: 'never-shown' });
    expect(refusalWords(403, { error: 'Path not in allowed directories' }).kind).toBe('not-allowed');
    expect(refusalWords(403, { error: 'Path traversal not allowed' }).kind).toBe('not-allowed');
    expect(refusalWords(404, { error: 'Path not found' }).kind).toBe('missing');
    expect(refusalWords(404, { error: 'file viewer is disabled' }).kind).toBe('off');
    expect(refusalWords(413, { size: 3 * 1_048_576, maxSize: 1_048_576 }).text).toBe('This file is 3.0 MB, more than the 1.0 MB this page can open or download.');
    expect(refusalWords(401, {}).kind).toBe('signin');
    expect(refusalWords(0, {}).kind).toBe('unreachable');
    expect(refusalWords(500, { error: 'Failed to read file' }).text).toBe('The server answered 500: Failed to read file.');
  });
});

describe('folders', () => {
  it('a listing keeps files and folders only, with paths; an empty folder says why', () => {
    const l = buildListing(ok({ path: 'docs', entries: [{ name: 'specs', type: 'directory' }, { name: 'a.md', type: 'file', size: 2048 }, { name: 'x', type: 'socket' }] }), 'docs');
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.entries.map((e) => [e.path, e.type, e.sub])).toEqual([['docs/specs', 'directory', ''], ['docs/a.md', 'file', '2.0 KB']]);
    expect(l.cut).toBeNull();
    const e = buildListing(ok({ path: 'docs', entries: [] }), 'docs');
    expect(e.ok && e.empty).toMatch(/hidden by design/);
  });
  it('cut short: the server’s flag says how many; a full 500 at the top (no flag) says there may be more; 499 says nothing', () => {
    const flagged = buildListing(ok({ path: 'big', entries: [{ name: 'a', type: 'file' }], truncated: true, totalEntries: 812 }), 'big');
    expect(flagged.ok && flagged.cut).toBe('Showing the first 500 of 812. Find a file by name to reach the rest.');
    const top = (n: number) => buildListing(ok({ path: '', entries: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: 'file' })) }), '');
    const full = top(500);
    expect(full.ok && full.cut).toBe('Showing the first 500; there may be more. Find a file by name to reach the rest.');
    const under = top(499);
    expect(under.ok && under.cut).toBeNull();
  });
  it('a failed listing is the refusal in words, not an empty folder', () => {
    expect(buildListing(no(403, 'Path not in allowed directories'), 'src')).toMatchObject({ ok: false, kind: 'not-allowed' });
    expect(buildListing(ok({ nope: 1 }), '')).toMatchObject({ ok: false });
  });
});

describe('an opened file', () => {
  it('markdown, code, binary and refused', () => {
    expect(buildFile(ok({ content: '# Hi\n', size: 5, modified: 'm', editable: true }), 'CLAUDE.md')).toMatchObject({ kind: 'markdown', editable: true, lines: 2, highlight: true });
    expect(buildFile(ok({ content: 'let a', size: 5, editable: false }), 'src/a.ts')).toMatchObject({ kind: 'code', language: 'typescript', editable: false, readOnlyWhy: 'This file is outside the folders you have allowed editing.' });
    expect(buildFile(ok({ binary: true, size: 2048 }), 'logo.png')).toMatchObject({ kind: 'binary', image: 'image/png', sizeLine: '2.0 KB · PNG image' });
    expect(buildFile(ok({ binary: true, size: 10 }), 'a.bin')).toMatchObject({ kind: 'binary', image: null, sizeLine: '10 B · not text' });
    expect(buildFile(no(403, 'Access to this path is not permitted'), '.instar/identity.json')).toMatchObject({ kind: 'refused', refusal: 'never-shown', title: 'Never shown, by design' });
    expect(buildFile(no(413, 'File too large', { size: 2_000_000, maxSize: 1_048_576 }), 'big.log')).toMatchObject({ kind: 'refused', refusal: 'too-large' });
  });
  it('a long file opens as plain source without colours, and says so', () => {
    const long = Array.from({ length: 2001 }, () => 'x').join('\n');
    const f = buildFile(ok({ content: long, size: long.length, editable: true }), 'notes.md');
    expect(f).toMatchObject({ kind: 'code', highlight: false });
    expect(f.bigNote).toMatch(/2,001 lines/);
    expect(buildFile(ok({ content: 'x\n'.repeat(1999), size: 1, editable: true }), 'notes.md').kind).toBe('markdown');
  });
  it('never-editable paths are read-only with their reason even if the server said editable; size over the edit limit too', () => {
    expect(readOnly('.claude/hooks/x.js', true, 1)).toEqual({ editable: false, why: 'Hooks and scripts are never editable here.' });
    expect(readOnly('.CLAUDE/Scripts/x.sh', true, 1).editable).toBe(false);
    expect(readOnly('.instar/config.json', true, 1).why).toMatch(/settings file/);
    expect(readOnly('docs/a.md', true, 300_000, { maxEditableFileSize: 204_800 })).toEqual({ editable: false, why: 'This file is 293.0 KB; files over 200.0 KB can be read here but not edited.' });
    expect(readOnly('docs/a.md', true, 100, { maxEditableFileSize: 204_800 })).toEqual({ editable: true, why: null });
  });
  it('the never-editable list matches the server’s own predicate, and key material is never served', () => {
    for (const n of NEVER_EDITABLE) expect(isNeverEditable(n.prefix.endsWith('/') ? `${n.prefix}x` : n.prefix)).toBe(true);
    expect(isNeverEditable('docs/a.md')).toBe(false);
    expect(isNeverServed('.instar/identity.json')).toBe(true);
  });
});

describe('saving and the kept edit', () => {
  it('the save body carries expectedModified unless overwriting', () => {
    expect(saveBody('./docs/a.md', 'x', 'm1')).toEqual({ path: 'docs/a.md', content: 'x', expectedModified: 'm1' });
    expect(saveBody('docs/a.md', 'x', 'm1', { force: true })).toEqual({ path: 'docs/a.md', content: 'x' });
    expect(saveBody('docs/a.md', 'x', '')).toEqual({ path: 'docs/a.md', content: 'x' });
  });
  it('answers in words, per status', () => {
    expect(saveResult(200, { success: true, modified: 'm2' })).toEqual({ ok: true, modified: 'm2', text: 'Saved.' });
    expect(saveResult(409, { currentModified: 'm3' })).toMatchObject({ ok: false, conflict: true, currentModified: 'm3' });
    expect(saveResult(401, {})).toMatchObject({ ok: false, signin: true, text: expect.stringMatching(/kept/) });
    expect(saveResult(403, { error: 'This path is never editable for security reasons' }).text).toBe('This file is never editable here, by design.');
    expect(saveResult(413, { size: 300_000, maxSize: 204_800 }).text).toMatch(/^Too large to save here/);
  });
  it('the conflict sentence names both times', () => {
    expect(conflictWords('2026-10-26T17:42:00Z', '2026-10-26T17:31:00Z')).toMatch(/^This file changed since you opened it \(changed .+; you opened it at .+\)\.$/);
    expect(conflictWords(undefined as unknown as string, undefined as unknown as string)).toBe('This file changed since you opened it.');
  });
  it('a kept edit comes back for the same path within 10 minutes only', () => {
    const now = 1_000_000_000;
    const raw = stashFor('docs/a.md', 'mine', now);
    expect(readStash(raw, 'docs/a.md', now + 60_000)).toEqual({ path: 'docs/a.md', content: 'mine', at: now });
    expect(readStash(raw, 'docs/b.md', now)).toBeNull();
    expect(readStash(raw, 'docs/a.md', now + 11 * 60_000)).toBeNull();
    expect(readStash('{bad', 'docs/a.md', now)).toBeNull();
  });
});

describe('recent, pinned and find', () => {
  it('recent: newest first, de-duplicated, at most 8', () => {
    let r: string[] = [];
    for (let i = 0; i < 10; i++) r = pushRecent(r, `f${i}.md`);
    r = pushRecent(r, 'f5.md');
    expect(r[0]).toBe('f5.md');
    expect(r).toHaveLength(RECENT_MAX);
    expect(new Set(r).size).toBe(r.length);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent(JSON.stringify(['a.md', 3, '', './b.md']))).toEqual(['a.md', 'b.md']);
  });
  it('pinned shows only the key files that exist', () => {
    const listings = {
      '': buildListing(ok({ path: '', entries: [{ name: 'CLAUDE.md', type: 'file' }] }), ''),
      '.instar': buildListing(ok({ path: '.instar', entries: [{ name: 'AGENT.md', type: 'file' }] }), '.instar'),
    };
    expect(pinnedFrom(listings).map((p) => p.path)).toEqual(['CLAUDE.md', '.instar/AGENT.md']);
    expect(pinnedFrom({})).toEqual([]);
  });
  it('find matches names in opened folders, files first, and says what it searched', () => {
    const listings = {
      '': buildListing(ok({ path: '', entries: [{ name: 'docs', type: 'directory' }, { name: 'CLAUDE.md', type: 'file' }] }), ''),
      docs: buildListing(ok({ path: 'docs', entries: [{ name: 'claude-notes.md', type: 'file' }] }), 'docs'),
    };
    const s = searchLoaded(listings, 'CLAUDE');
    expect(s.rows.map((r) => r.path)).toEqual(['CLAUDE.md', 'docs/claude-notes.md']);
    expect(s.note).toBe('Searched the 2 folders opened so far. Open a folder to search inside it too.');
    expect(searchLoaded(listings, '  ').rows).toEqual([]);
  });
});

describe('folder access', () => {
  it('reads the lists in words; a failure is can’t tell', () => {
    const c = buildConfig(ok({ enabled: true, allowedPaths: ['./', 'docs/'], editablePaths: ['docs/'], maxFileSize: 1_048_576, maxEditableFileSize: 204_800 }));
    expect(c.ok && c.allowedRows).toEqual([{ value: './', label: 'The whole project' }, { value: 'docs/', label: 'docs/' }]);
    expect(c.ok && c.limitsLine).toBe('Files up to 1.0 MB open here; up to 200.0 KB can be edited.');
    expect(buildConfig(no(500, 'x'))).toMatchObject({ ok: false });
  });
  it('a typed folder is checked before it is sent; add and remove build the full list', () => {
    expect(folderInput('docs')).toEqual({ ok: true, value: 'docs/' });
    expect(folderInput('.')).toEqual({ ok: true, value: './' });
    expect(folderInput('/etc').ok).toBe(false);
    expect(folderInput('docs/../..').ok).toBe(false);
    expect(folderInput('').ok).toBe(false);
    const c = { allowed: ['./'], editable: ['docs/'] };
    expect(configPatch(c, 'allowed', 'add', 'src/')).toEqual({ allowedPaths: ['./', 'src/'] });
    expect(configPatch(c, 'allowed', 'add', './')).toEqual({ allowedPaths: ['./'] });
    expect(configPatch(c, 'editable', 'remove', 'docs')).toEqual({ editablePaths: [] });
    expect(configResultWords(200, { updated: true }).ok).toBe(true);
    expect(configResultWords(501, {}).text).toMatch(/cannot be changed from here/);
    expect(configResultWords(400, { error: 'Path .claude/hooks/ is never editable for security reasons' }).text).toMatch(/never editable/);
  });
  it('the headline only speaks up when something is wrong', () => {
    expect(filesHeadline({ root: buildListing(ok({ path: '', entries: [] }), ''), machine: '' })).toMatchObject({ tone: 'ok', sub: null });
    expect(filesHeadline({ root: buildListing(no(500, 'x'), ''), machine: '' })).toMatchObject({ text: 'Can’t read the file list.', tone: 'bad' });
    expect(filesHeadline({ root: undefined, machine: 'the mini' }).sub).toBe('Files on the mini. Each machine has its own.');
  });
  it('the tile flips to the native page; the legacy id stays', () => {
    expect(NATIVE_PAGES.files).toBe('#/settings/files');
    expect(tabHref('files')).toBe('#/settings/files');
    expect(GROUPS.find((g) => g.id === 'settings')!.tabs.find((t) => t.id === 'files')!.label).toBe('Files');
  });
});

describe('files in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => { dom?.window.close(); });
  const tick = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };

  it('boots the shipped console: browse, a refused key file in words, sanitized markdown, an edit through a conflict, and a folder added with no PIN', async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/settings/files' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    // The page's sanitizer: real marked, and a sanitizer that drops scripts and handlers.
    const sanitize = vi.fn((html: string, opts: { RETURN_DOM_FRAGMENT?: boolean }) => {
      const t = dom.window.document.createElement('template');
      t.innerHTML = html;
      for (const s of t.content.querySelectorAll('script')) s.remove();
      for (const n of t.content.querySelectorAll('*')) for (const a of [...n.attributes]) if (a.name.startsWith('on')) n.removeAttribute(a.name);
      return opts && opts.RETURN_DOM_FRAGMENT ? t.content : t.innerHTML;
    });
    Object.assign(dom.window, { marked, DOMPurify: { sanitize }, hljs: { highlightElement: vi.fn() } });

    const files: Record<string, { content?: string; modified: string; editable?: boolean; binary?: boolean; size?: number }> = {
      'CLAUDE.md': { content: '# Hello\n\n<script>window.pwned=1</script><img src=x onerror="window.pwned=2">\n\n[a link](https://example.com)', modified: 'm1', editable: true },
      'docs/a.ts': { content: 'const a = 1;\n', modified: 'm1', editable: true },
      '.claude/hooks/h.js': { content: 'x', modified: 'm1', editable: false },
    };
    let config = { enabled: true, allowedPaths: ['./'], editablePaths: ['./'], maxFileSize: 1_048_576, maxEditableFileSize: 204_800 };
    let conflictOnce = true;
    const writes: Array<{ method: string; url: string; body: unknown; csrf?: string }> = [];
    g.fetch = async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = (opts && opts.method) || 'GET';
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
      if (method !== 'GET') {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        writes.push({ method, url, body, csrf: opts && opts.headers && opts.headers['X-Instar-Request'] });
        if (url === '/api/files/save') {
          if (body.expectedModified && conflictOnce) { conflictOnce = false; return json(409, { error: 'File was modified since you loaded it', currentModified: '2026-10-26T17:42:00Z', expectedModified: body.expectedModified }); }
          files[body.path] = { ...files[body.path], content: body.content, modified: 'm9' };
          return json(200, { path: body.path, success: true, modified: 'm9', size: body.content.length });
        }
        if (url === '/api/files/config') { config = { ...config, ...body }; return json(200, { enabled: true, allowedPaths: config.allowedPaths, editablePaths: config.editablePaths, updated: true }); }
      }
      if (url === '/sessions') return json(200, { sessions: [] });
      if (url === '/pool') return json(200, { enabled: false, machines: [] });
      if (url === '/health') return json(200, {});
      if (url === '/api/files/config') return json(200, config);
      const u = new URL(url, 'http://localhost:4040');
      const p = u.searchParams.get('path') || '';
      if (u.pathname === '/api/files/list') {
        if (p === '') return json(200, { path: '', entries: [{ name: '.claude', type: 'directory' }, { name: 'docs', type: 'directory' }, { name: 'CLAUDE.md', type: 'file', size: 90 }] });
        if (p === '.claude') return json(200, { path: '.claude', entries: [{ name: 'hooks', type: 'directory' }] });
        if (p === 'docs') return json(200, { path: 'docs', entries: [{ name: 'a.ts', type: 'file', size: 13 }] });
        if (p === '.instar') return json(403, { error: 'Access to this path is not permitted' });
        return json(404, { error: 'Path not found' });
      }
      if (u.pathname === '/api/files/read') {
        if (p === '.instar/identity.json') return json(403, { error: 'Access to this path is not permitted' });
        const f = files[p];
        if (!f) return json(404, { error: 'Path not found' });
        return json(200, { path: p, content: f.content, size: (f.content || '').length, modified: f.modified, editable: f.editable });
      }
      return json(404, { error: 'no such route in the test' });
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await tick();
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('Open a file, or find one by name.');
    const sectionTitles = [...doc.querySelectorAll('.files-browse .list-section .eyebrow')].map((n) => n.textContent);
    expect(sectionTitles).toEqual(['Pinned', 'Browse']); // no Recent yet
    expect([...doc.querySelectorAll('.files-tree .file-row .row-title')].map((n) => n.textContent)).toEqual(['.claude', 'docs', 'CLAUDE.md']);

    // Expand a folder (lazy), then find by name across opened folders.
    (doc.querySelector('.files-tree [data-path="docs"]') as HTMLButtonElement).click();
    await tick(5);
    expect(doc.querySelector('.files-tree [data-path="docs/a.ts"]')).not.toBeNull();
    const find = doc.querySelector('.files-find') as HTMLInputElement;
    find.value = 'a.ts';
    find.dispatchEvent(new dom.window.Event('input'));
    expect([...doc.querySelectorAll('.files-results .row-title')].map((n) => n.textContent)).toEqual(['a.ts']);

    // A key file is refused by the server: said in words, never hidden.
    dom.window.location.hash = '#/settings/files?path=.instar%2Fidentity.json';
    await tick();
    expect(doc.querySelector('.files-refused .card-title')!.textContent).toBe('Never shown, by design');
    expect(doc.querySelector('.files-refused .card-line')!.textContent).toMatch(/^This file is never shown, by design/);
    expect(doc.querySelector('[data-edit]')).toBeNull();

    // Markdown renders only through the sanitizer: no script, no handler survives.
    dom.window.location.hash = '#/settings/files?path=CLAUDE.md';
    await tick();
    expect(sanitize).toHaveBeenCalled();
    const md = doc.querySelector('.markdown-content')!;
    expect(md.querySelector('h1')!.textContent).toBe('Hello');
    expect(md.querySelector('script')).toBeNull();
    expect(md.querySelector('[onerror]')).toBeNull();
    expect(md.querySelector('a')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect((dom.window as unknown as Record<string, unknown>).pwned).toBeUndefined();
    // Source view shows the raw text through textContent.
    ([...doc.querySelectorAll('.files-toggle .chip')].find((b) => b.textContent === 'Source') as HTMLButtonElement).click();
    expect(doc.querySelector('.files-code code')!.textContent).toContain('<script>');
    expect(doc.querySelector('.files-code script')).toBeNull();

    // Without a working sanitizer the page shows source, never unsanitized HTML.
    (dom.window as unknown as Record<string, unknown>).DOMPurify = {};
    ([...doc.querySelectorAll('.files-toggle .chip')].find((b) => b.textContent === 'Rendered') as HTMLButtonElement).click();
    await tick(3);
    expect(doc.querySelector('.markdown-content')!.textContent).toContain('The formatter did not load, so this is the source.');
    expect(doc.querySelector('.markdown-content h1')).toBeNull();

    // A never-editable file reads with a lock and why; no Edit button.
    dom.window.location.hash = '#/settings/files?path=.claude%2Fhooks%2Fh.js';
    await tick();
    expect(doc.querySelector('[data-readonly]')!.textContent).toContain('Hooks and scripts are never editable here.');
    expect(doc.querySelector('[data-edit]')).toBeNull();

    // Edit → Save hits a conflict: the edit is kept, then Overwrite with mine sends it without expectedModified.
    dom.window.location.hash = '#/settings/files?path=docs%2Fa.ts';
    await tick();
    (doc.querySelector('[data-edit]') as HTMLButtonElement).click();
    const ta = doc.querySelector('.files-editor') as HTMLTextAreaElement;
    ta.value = 'const a = 2;\n';
    ta.dispatchEvent(new dom.window.Event('input'));
    expect(doc.querySelector('.files-folder')!.textContent).toBe('Unsaved · docs/');
    (doc.querySelector('[data-save]') as HTMLButtonElement).click();
    await tick(5);
    expect(writes[0]).toEqual({ method: 'POST', url: '/api/files/save', body: { path: 'docs/a.ts', content: 'const a = 2;\n', expectedModified: 'm1' }, csrf: '1' });
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('This file changed');
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toMatch(/^This file changed since you opened it \(changed /);
    expect(JSON.parse(dom.window.sessionStorage.getItem('instar_edit_stash')!).content).toBe('const a = 2;\n');
    (doc.querySelector('.sheet [data-overwrite]') as HTMLButtonElement).click();
    await tick(5);
    expect(writes[1]).toEqual({ method: 'POST', url: '/api/files/save', body: { path: 'docs/a.ts', content: 'const a = 2;\n' }, csrf: '1' });
    expect(doc.querySelector('.files-status')!.textContent).toBe('Saved.');
    expect(doc.querySelector('.files-editor')).toBeNull();
    expect(dom.window.sessionStorage.getItem('instar_edit_stash')).toBeNull();
    expect(files['docs/a.ts'].content).toBe('const a = 2;\n');

    // Back to the list: Recent now holds what was opened (refused files are not kept).
    dom.window.location.hash = '#/settings/files';
    await tick();
    const recent = [...doc.querySelectorAll('.files-browse .list-section')].find((s) => s.querySelector('.eyebrow')!.textContent === 'Recent')!;
    expect([...recent.querySelectorAll('.row-title')].map((n) => n.textContent)).toEqual(['a.ts', 'h.js', 'CLAUDE.md']);

    // Folder access: add a folder on the bearer token alone, with the safety header; no PIN.
    (doc.querySelector('[data-access]') as HTMLButtonElement).click();
    await tick(5);
    expect(doc.querySelector('.sheet .sheet-title')!.textContent).toBe('Which folders can be browsed and edited');
    expect(doc.querySelector('.sheet .files-fixed')!.textContent).toContain('.claude/hooks/, .claude/scripts/');
    const add = doc.querySelector('.sheet [data-list="allowed"] input') as HTMLInputElement;
    add.value = '../etc';
    (doc.querySelector('.sheet [data-add="allowed"]') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('A folder cannot step outside the project.');
    expect(writes).toHaveLength(2);
    add.value = 'docs';
    (doc.querySelector('.sheet [data-add="allowed"]') as HTMLButtonElement).click();
    await tick(5);
    expect(writes[2]).toEqual({ method: 'PATCH', url: '/api/files/config', body: { allowedPaths: ['./', 'docs/'] }, csrf: '1' });
    expect([...doc.querySelectorAll('.sheet [data-list="allowed"] li > span')].map((n) => n.textContent)).toEqual(['The whole project', 'docs/']);
    expect(doc.querySelector('.pin-input')).toBeNull();
  });
});
