// Files (docs/specs/console-features/people-settings.md, "Files", legacy tab id `files`).
// Find a file by name, Recent and Pinned, then Browse folders; a full-screen viewer with
// rendered markdown (Rendered / Source), code with line numbers and a wrap toggle, and a
// simple editor with Save and Cancel in a sticky header. A refusal from the server (key
// material, a blocked file name, a folder that is not allowed) is shown in words, never
// hidden. Every route is adapter (a): the bearer token is enough (save and settings also
// send `X-Instar-Request: 1`), so no PIN is ever asked.
//
// SAFETY: every value from a file or the server goes through textContent, except rendered
// markdown, which only ever reaches the page as a DOM fragment DOMPurify produced. When
// the formatter or the sanitizer is not loaded, the file is shown as plain source.

import {
  RECENT_KEY, STASH_KEY, NEVER_EDITABLE, NEVER_SHOWN_WORDS,
  normPath, baseName, parentOf, crumbs, folderWords, fileHash, pathFromHash, sizeWords,
  buildListing, buildFile, saveBody, saveResult, conflictWords, stashFor, readStash,
  parseRecent, pushRecent, recentRows, pinnedFrom, searchLoaded, buildConfig, folderInput,
  configPatch, configResultWords, filesHeadline, refusalWords,
  searchUrl, buildSearch, previewPlan, previewResult,
} from './files-model.js';
import { el, setKids, pageHead, sheet, closeSheet, sheetIsOpen, note } from './ui.js';

// The same pinned builds the legacy dashboard loads (dashboard/index.html), with integrity.
const LIBS = {
  marked: { global: 'marked', src: 'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js', integrity: 'sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR' },
  purify: { global: 'DOMPurify', src: 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js', integrity: 'sha384-eEu5CTj3qGvu9PdJuS+YlkNi7d2XxQROAFYOr59zgObtlcux1ae1Il3u7jvdCSWu' },
  hljs: { global: 'hljs', src: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js', integrity: 'sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU' },
};
const LIB_WAIT_MS = 4000;
const loading = {};
/** Load one library once; resolves to it, or null when it can't load (the page then shows source). */
function lib(name) {
  const def = LIBS[name];
  if (window[def.global]) return Promise.resolve(window[def.global]);
  if (!loading[name]) {
    loading[name] = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = def.src; s.integrity = def.integrity; s.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(window[def.global] || null), LIB_WAIT_MS);
      s.onload = () => { clearTimeout(t); resolve(window[def.global] || null); };
      s.onerror = () => { clearTimeout(t); delete loading[name]; resolve(null); };
      document.head.append(s);
    });
  }
  return loading[name];
}

// ── state kept across re-renders (refresh, Back, hash changes) ─────────────
const S = {
  listings: {},          // dir → listing model
  expanded: new Set(),   // folders open in Browse
  file: null,            // the opened file's model
  openedAt: null,        // when it was opened (for the conflict sentence)
  view: 'rendered',      // markdown: rendered | source
  wrap: true,            // code: wrap long lines
  edit: null,            // { path, text, base, baseModified, kept }
  query: '',
  config: null,
  machine: null,
  status: '',
  serverSearch: null,    // true / false once known: does this server have GET /api/files/search?
  found: null,           // the last server search result model
};

const SEARCH_DEBOUNCE_MS = 250;
let searchTimer = null;
let searchSeq = 0;
// The image preview's object URL, revoked when another file opens.
let preview = { path: null, url: null };
function dropPreview() { if (preview.url) URL.revokeObjectURL(preview.url); preview = { path: null, url: null }; }

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }
/** Any file route: keeps the status and the body; never signs out on a refusal. */
async function call(method, path, body) {
  try {
    const headers = { Authorization: `Bearer ${bearer()}` };
    if (body) { headers['Content-Type'] = 'application/json'; headers['X-Instar-Request'] = '1'; }
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: {} }; }
}
const listOf = async (dir) => buildListing(await call('GET', `/api/files/list?path=${encodeURIComponent(dir)}`), dir);

function loadRecent() { try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; } }
function saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage blocked */ } }
function getStash(p) { try { return readStash(sessionStorage.getItem(STASH_KEY), p); } catch { return null; } }
function keep(p, text) { try { sessionStorage.setItem(STASH_KEY, stashFor(p, text)); } catch { /* storage blocked */ } }
function dropStash() { try { sessionStorage.removeItem(STASH_KEY); } catch { /* storage blocked */ } }

const dirty = () => Boolean(S.edit && S.edit.text !== S.edit.base);
window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

function go(p) { location.hash = p ? fileHash(p) : '#/settings/files'; }

async function copyText(text, status) {
  try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; }
  catch { status.textContent = 'Copying is blocked here; select the text and copy it by hand.'; }
}

async function download(p, status) {
  status.textContent = 'Downloading…';
  try {
    const r = await fetch(`/api/files/download?path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${bearer()}` }, cache: 'no-store' });
    if (!r.ok) { status.textContent = refusalWords(r.status, await r.json().catch(() => ({}))).text; return; }
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', { href: url, download: baseName(p) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status.textContent = 'Downloaded.';
  } catch { status.textContent = 'The server could not be reached.'; }
}

// ── entry ─────────────────────────────────────────────────────────────────
let page = null;
export async function renderFiles(main, ctx) {
  const want = pathFromHash(location.hash);
  // The 30 s refresh calls back in: a file page has nothing to poll, and an open
  // editor or a typed search must never be discarded.
  if (page && main.contains(page) && page.getAttribute('data-for') === want) return;
  if (!S.config) call('GET', '/api/files/config').then((r) => { S.config = buildConfig(r); });
  if (S.machine === null) {
    ctx.get('/pool').then((r) => {
      const ms = r.ok && r.data && Array.isArray(r.data.machines) ? r.data.machines : [];
      const self = ms.find((m) => m && (m.isSelf || m.machineId === r.data.selfMachineId));
      S.machine = ms.length > 1 ? String((self && (self.nickname || self.name)) || 'this machine') : '';
      if (S.machine && page) { const t = page.querySelector('[data-machine]'); if (t) t.textContent = `Files on ${S.machine}. Each machine has its own.`; }
    });
  }
  page = el('div', { class: 'files-page', 'data-for': want });
  setKids(main, page);
  if (want) await openFile(want); else S.file = null;
  if (!S.listings['']) {
    setKids(page, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Settings · Files' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
    const [root, c, i] = await Promise.all([listOf(''), listOf('.claude'), listOf('.instar')]);
    S.listings[''] = root;
    if (c.ok) S.listings['.claude'] = c;
    if (i.ok) S.listings['.instar'] = i;
  }
  paint();
}

async function openFile(p) {
  const path = normPath(p);
  if (S.edit && S.edit.path !== path && !dirty()) S.edit = null;
  if (S.file && S.file.path === path && S.file.kind !== 'refused') return;
  if (preview.path && preview.path !== path) dropPreview();
  const r = await call('GET', `/api/files/read?path=${encodeURIComponent(path)}`);
  S.file = buildFile(r, path, S.config && S.config.ok ? S.config : {});
  S.openedAt = new Date().toISOString();
  S.view = 'rendered';
  if (S.file.kind !== 'refused') saveRecent(pushRecent(loadRecent(), path));
  const kept = getStash(path);
  if (kept && S.file.editable && !(S.edit && S.edit.path === path)) {
    S.edit = { path, text: kept.content, base: S.file.content, baseModified: S.file.modified, kept: true };
  }
}

function paint() {
  if (!page) return;
  const showing = Boolean(S.file);
  page.classList.toggle('viewing', showing);
  setKids(page, el('div', { class: 'files-browse' }, browse()), showing ? el('div', { class: 'files-viewer' }, viewer()) : null);
}

// ── browse side ───────────────────────────────────────────────────────────
function rowBtn(r, onClick, depth = 0) {
  const b = el('button', { class: `row file-row${r.type === 'directory' ? ' is-dir' : ''}`, type: 'button', 'data-path': r.path, 'data-focus-key': r.key || r.path },
    el('span', { class: 'f-icon', 'aria-hidden': 'true', text: r.type === 'directory' ? (S.expanded.has(r.path) ? '▾' : '▸') : '·' }),
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), r.sub ? el('span', { class: 'row-sub', text: r.sub }) : null),
    r.type === 'directory' ? null : el('span', { class: 'row-end' }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  if (depth) b.style.paddingLeft = `${12 + depth * 16}px`;
  if (S.file && S.file.path === r.path) b.setAttribute('aria-current', 'true');
  b.addEventListener('click', onClick);
  return b;
}

function browse() {
  const root = S.listings[''];
  const h = filesHeadline({ root, machine: S.machine });
  const head = pageHead({ eyebrow: 'Settings · Files', headline: h.text, tone: h.tone });
  head.append(el('p', { 'data-machine': '1', text: h.sub || '' }));

  const input = el('input', { class: 'files-find', type: 'search', placeholder: 'Find a file', 'aria-label': 'Find a file', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  input.value = S.query;
  const results = el('div', { class: 'files-results' });
  const pick = (r) => (r.type === 'directory' ? reveal(r.path) : go(r.path));
  // Opened folders only: an older server without the search route, or while the whole-project answer is on its way.
  const showLoaded = () => {
    const s = searchLoaded(S.listings, input.value);
    if (!s.query) { setKids(results); return; }
    setKids(results,
      el('div', { class: 'rows' }, s.rows.length ? s.rows.map((r) => rowBtn(r, () => pick(r))) : el('p', { class: 'empty-line', text: 'No name matches in the folders opened so far.' })),
      s.more ? note(`and ${s.more} more; type more of the name.`) : null,
      note(s.note));
  };
  const showFound = (f) => {
    if (!f.ok) { setKids(results, el('p', { class: 'card-note files-refusal', 'data-search-failed': '1', text: `Can’t search right now: ${f.text}` })); return; }
    setKids(results,
      el('div', { class: 'rows', 'data-search': 'project' }, f.rows.length ? f.rows.map((r) => rowBtn(r, () => pick(r))) : el('p', { class: 'empty-line', text: f.empty })),
      f.note ? note(f.note) : null);
  };
  const runSearch = async (q) => {
    const seq = ++searchSeq;
    const found = buildSearch(await call('GET', searchUrl(q)), q);
    if (seq !== searchSeq || input.value.trim() !== q) return; // a newer query is in flight
    if (found.unsupported) { S.serverSearch = false; S.found = null; showLoaded(); return; }
    S.serverSearch = true; S.found = found;
    showFound(found);
  };
  const showResults = () => {
    S.query = input.value;
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (!q) { S.found = null; setKids(results); return; }
    if (S.serverSearch === false) { showLoaded(); return; }
    if (S.found && S.found.query === q.toLowerCase()) showFound(S.found); else showLoaded();
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  };
  input.addEventListener('input', showResults);
  if (S.found && S.found.query === input.value.trim().toLowerCase()) showFound(S.found); else showResults();

  const parts = [head, el('div', { class: 'files-search' }, input, results)];
  const recent = recentRows(loadRecent());
  if (recent.length) parts.push(group('Recent', recent.map((r) => rowBtn(r, () => go(r.path)))));
  const pinned = pinnedFrom(S.listings);
  if (pinned.length) parts.push(group('Pinned', pinned.map((r) => rowBtn(r, () => go(r.path)))));

  const tree = el('div', { class: 'rows files-tree' });
  if (!root) tree.append(el('p', { class: 'empty-line', text: 'Loading…' }));
  else if (!root.ok) {
    tree.append(el('section', { class: 'card', 'data-state': 'unknown' }, el('p', { class: 'card-line', text: `Can’t tell: ${root.text}` }),
      el('button', { class: 'btn-quiet', type: 'button', text: 'Try again', onclick: async () => { S.listings[''] = await listOf(''); paint(); } })));
  } else addLevel(tree, root, 0);
  parts.push(group('Browse', [tree]));
  parts.push(el('button', { class: 'row files-access', type: 'button', 'data-access': '1', onclick: accessSheet },
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: 'Which folders can be browsed and edited' })),
    el('span', { class: 'row-end' }, el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }))));
  if (S.edit && dirty() && (!S.file || S.file.path !== S.edit.path)) {
    parts.splice(1, 0, el('section', { class: 'incident files-unsaved', role: 'status' },
      el('span', { class: 'incident-title', text: `Unsaved edit to ${baseName(S.edit.path)}` }),
      el('div', { class: 'sheet-actions' },
        el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Return to it', onclick: () => go(S.edit.path) }),
        el('button', { class: 'btn-quiet', type: 'button', text: 'Discard it', 'data-discard': '1', onclick: () => { S.edit = null; dropStash(); paint(); } }))));
  }
  return parts;
}

function group(title, kids) {
  return el('section', { class: 'list-section' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: title })), el('div', { class: 'rows' }, kids));
}

function addLevel(container, listing, depth) {
  if (listing.empty) container.append(el('p', { class: 'empty-line', text: listing.empty }));
  for (const e of listing.entries) {
    container.append(rowBtn({ key: `tree:${e.path}`, main: e.name, sub: e.sub, path: e.path, type: e.type }, () => (e.type === 'directory' ? toggle(e.path) : go(e.path)), depth));
    if (e.type === 'directory' && S.expanded.has(e.path)) {
      const child = S.listings[e.path];
      if (!child) container.append(el('p', { class: 'empty-line', text: 'Loading…' }));
      else if (!child.ok) container.append(el('p', { class: 'card-note files-refusal', 'data-refused': child.kind, text: child.text }));
      else addLevel(container, child, depth + 1);
    }
  }
  if (listing.cut) container.append(note(listing.cut));
}

async function toggle(dir) {
  if (S.expanded.has(dir)) { S.expanded.delete(dir); paint(); return; }
  S.expanded.add(dir);
  paint();
  if (!S.listings[dir] || !S.listings[dir].ok) { S.listings[dir] = await listOf(dir); paint(); }
}

/** Tap a folder in a file's path: back to Browse with that folder open. */
async function reveal(dir) {
  const parts = normPath(dir).split('/');
  for (let i = 1; i <= parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    S.expanded.add(d);
    if (!S.listings[d]) S.listings[d] = await listOf(d);
  }
  if (S.file) go(''); else paint();
  setTimeout(() => { const n = page && page.querySelector(`.files-tree [data-path="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(dir) : dir.replace(/["\\]/g, '\\$&')}"]`); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'center' }); }, 50);
}

// ── viewer side ───────────────────────────────────────────────────────────
function viewer() {
  const f = S.file;
  const editing = Boolean(S.edit && S.edit.path === f.path && f.editable);
  const status = el('p', { class: 'action-status files-status', role: 'status', text: S.status });
  S.status = '';
  const back = el('button', { class: 'chip icon-btn files-back', type: 'button', 'aria-label': 'Back to files', text: '‹', onclick: () => go('') });
  const folder = el('button', { class: 'files-folder link-btn', type: 'button', text: editing && dirty() ? `Unsaved · ${f.folder}` : f.folder, onclick: () => reveal(parentOf(f.path)) });
  const title = el('div', { class: 'files-title' }, el('h1', { class: 'files-name', text: f.name }), folder);
  const headKids = [back, title];
  if (editing) {
    headKids.push(el('div', { class: 'files-edit-actions' },
      el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', 'data-cancel-edit': '1', onclick: () => cancelEdit(status) }),
      el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Save', 'data-save': '1', onclick: () => save(status) })));
  } else if (f.kind !== 'refused') {
    headKids.push(el('button', { class: 'chip icon-btn files-more', type: 'button', 'aria-label': 'More', text: '…', 'data-more': '1', onclick: () => moreSheet(f) }));
  }
  const header = el('header', { class: 'files-head' }, headKids);
  const body = el('div', { class: 'files-body' });

  if (f.kind === 'refused') {
    body.append(el('section', { class: 'card files-refused', 'data-state': 'unknown', 'data-refused': f.refusal },
      el('div', { class: 'card-head' }, el('span', { class: 'dot unknown' }), el('h2', { class: 'card-title', text: f.title })),
      el('p', { class: 'card-line', text: f.text }),
      f.refusal === 'signin' ? el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Sign in again', onclick: signInAgain }) : null));
  } else if (f.kind === 'binary') {
    const plan = previewPlan(f, S.config && S.config.ok ? S.config : {});
    const card = el('section', { class: 'card' });
    if (plan.preview) card.append(imagePreview(f));
    card.append(el('p', { class: 'card-line', text: f.sizeLine }),
      f.image ? (plan.why ? el('p', { class: 'card-note', 'data-no-preview': '1', text: plan.why }) : null) : el('p', { class: 'card-note', text: 'This is not a text file, so it can’t be shown here.' }),
      el('div', { class: 'sheet-actions' }, el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Download', 'data-download': '1', onclick: () => download(f.path, status) })));
    body.append(card);
  } else if (editing) {
    body.append(editor(f, status));
  } else {
    if (!f.editable && f.readOnlyWhy) body.append(el('p', { class: 'files-lock', 'data-readonly': '1' }, el('span', { 'aria-hidden': 'true', text: '🔒 ' }), document.createTextNode(f.readOnlyWhy)));
    if (f.bigNote) body.append(note(f.bigNote));
    body.append(f.kind === 'markdown' ? markdownView(f) : codeView(f));
    if (f.editable) body.append(el('button', { class: 'btn-primary files-edit-fab', type: 'button', text: 'Edit', 'data-edit': '1', onclick: () => { S.edit = { path: f.path, text: f.content, base: f.content, baseModified: f.modified, kept: false }; paint(); focusEditor(); } }));
  }
  return [header, status, body];
}

/**
 * An image file, previewed: the bytes come from the download route with the bearer
 * token (an <img src> cannot carry it), the real type is read from the first bytes
 * (a file only named like an image is never shown), and the page shows it through an
 * object URL — the console's CSP allows `img-src blob:` for exactly this.
 */
function imagePreview(f) {
  const box = el('div', { class: 'files-image', 'data-image-preview': '1' });
  if (preview.path === f.path && preview.url) {
    box.append(el('img', { src: preview.url, alt: f.name }));
    return box;
  }
  dropPreview();
  preview.path = f.path;
  const line = el('p', { class: 'card-note', text: 'Loading the preview…' });
  box.append(line);
  (async () => {
    let status = 0;
    let bytes = null;
    try {
      const r = await fetch(`/api/files/download?path=${encodeURIComponent(f.path)}`, { headers: { Authorization: `Bearer ${bearer()}` }, cache: 'no-store' });
      status = r.status;
      if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
    } catch { status = 0; }
    if (preview.path !== f.path) return; // another file opened meanwhile
    const out = previewResult(status, bytes);
    if (!out.ok) { line.textContent = out.text; line.setAttribute('data-no-preview', '1'); return; }
    preview.url = URL.createObjectURL(new Blob([bytes], { type: out.mime }));
    setKids(box, el('img', { src: preview.url, alt: f.name }));
  })();
  return box;
}

function signInAgain() { try { localStorage.removeItem('instar_token'); } catch { /* storage blocked */ } location.reload(); }

function markdownView(f) {
  const wrap = el('div', { class: 'files-content' });
  const toggleRow = el('div', { class: 'files-toggle', role: 'group', 'aria-label': 'How to show it' },
    el('button', { class: `chip${S.view === 'rendered' ? ' on' : ''}`, type: 'button', 'aria-pressed': S.view === 'rendered' ? 'true' : 'false', text: 'Rendered', onclick: () => { S.view = 'rendered'; paint(); } }),
    el('button', { class: `chip${S.view === 'source' ? ' on' : ''}`, type: 'button', 'aria-pressed': S.view === 'source' ? 'true' : 'false', text: 'Source', onclick: () => { S.view = 'source'; paint(); } }));
  wrap.append(toggleRow);
  if (S.view === 'source') { wrap.append(codeView(f)); return wrap; }
  const md = el('div', { class: 'markdown-content' });
  const fallback = el('p', { class: 'card-note', text: 'Formatting…' });
  md.append(fallback);
  wrap.append(md);
  Promise.all([lib('marked'), lib('purify')]).then(([marked, purify]) => {
    if (!marked || !purify || typeof purify.sanitize !== 'function') {
      setKids(md, note('The formatter did not load, so this is the source.'), codeView(f));
      return;
    }
    // Only a sanitized DOM fragment ever reaches the page; never a raw HTML string.
    const frag = purify.sanitize(marked.parse(f.content), { RETURN_DOM_FRAGMENT: true });
    for (const a of frag.querySelectorAll('a[href]')) { a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('target', '_blank'); }
    setKids(md, frag);
    if (f.highlight) lib('hljs').then((h) => { if (h) for (const b of md.querySelectorAll('pre code')) h.highlightElement(b); });
  });
  return wrap;
}

function codeView(f) {
  const n = Math.max(1, f.lines);
  const gutter = el('pre', { class: 'files-gutter', 'aria-hidden': 'true', text: Array.from({ length: n }, (_, i) => String(i + 1)).join('\n') });
  const code = el('code', { class: f.language && f.highlight ? `language-${f.language}` : null, text: f.content });
  const pre = el('pre', { class: 'files-code' }, code);
  const box = el('div', { class: `files-codebox${S.wrap ? ' wrap' : ''}` }, S.wrap ? null : gutter, pre);
  const bar = el('div', { class: 'files-toggle' },
    el('button', { class: `chip${S.wrap ? ' on' : ''}`, type: 'button', 'aria-pressed': S.wrap ? 'true' : 'false', text: 'Wrap lines', 'data-wrap': '1', onclick: () => { S.wrap = !S.wrap; paint(); } }),
    el('span', { class: 'files-meta', text: `${f.lines.toLocaleString()} ${f.lines === 1 ? 'line' : 'lines'} · ${sizeWords(f.size)}` }));
  if (f.highlight && f.language) lib('hljs').then((h) => { if (h) h.highlightElement(code); });
  return el('div', { class: 'files-code-wrap' }, bar, box);
}

// ── editing ───────────────────────────────────────────────────────────────
function editor(f, status) {
  const ta = el('textarea', { class: 'files-editor', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', 'aria-label': `Edit ${f.name}` });
  ta.value = S.edit.text;
  ta.addEventListener('input', () => {
    S.edit.text = ta.value;
    const folder = page.querySelector('.files-folder');
    if (folder) folder.textContent = dirty() ? `Unsaved · ${f.folder}` : f.folder;
  });
  const kids = [];
  if (S.edit.kept) kids.push(el('p', { class: 'card-note files-kept', text: 'Your unsaved edit from before you were signed out was kept. Save it when you are ready.' }));
  kids.push(ta);
  return el('div', { class: 'files-edit' }, kids);
}
function focusEditor() { setTimeout(() => { const t = page && page.querySelector('.files-editor'); if (t) t.focus({ preventScroll: true }); }, 0); }

function cancelEdit(status) {
  if (!dirty()) { S.edit = null; dropStash(); paint(); return; }
  sheet({ title: 'Throw away your changes?' },
    el('p', { class: 'confirm-text', text: 'Your edit to this file is not saved.' }),
    el('div', { class: 'confirm-row' },
      el('button', { class: 'btn-quiet', type: 'button', text: 'Keep editing', onclick: () => closeSheet() }),
      el('button', { class: 'btn-danger', type: 'button', text: 'Throw them away', 'data-discard-confirm': '1', onclick: () => { closeSheet(); S.edit = null; dropStash(); paint(); } })));
  void status;
}

async function save(status, { force = false } = {}) {
  if (!S.edit) return;
  const { path, text } = S.edit;
  status.textContent = 'Saving…';
  const btn = page.querySelector('[data-save]');
  if (btn) btn.disabled = true;
  const r = await call('POST', '/api/files/save', saveBody(path, text, S.edit.baseModified, { force }));
  const res = saveResult(r.status, r.data);
  if (btn) btn.disabled = false;
  if (res.ok) {
    dropStash();
    S.file = { ...S.file, content: text, modified: res.modified, lines: text === '' ? 0 : text.split('\n').length, size: new TextEncoder().encode(text).length };
    S.edit = null;
    S.status = 'Saved.';
    paint();
    return;
  }
  // Every failure keeps the text: in the page, and (for a sign-out or a conflict) in the
  // same session stash the legacy dashboard uses.
  if (res.signin || res.conflict) keep(path, text);
  status.textContent = res.text;
  if (res.conflict) conflictSheet(res.currentModified, status);
}

function conflictSheet(currentModified, status) {
  const copyStatus = el('p', { class: 'action-status', role: 'status' });
  const mine = S.edit.text;
  sheet({ title: 'This file changed' },
    el('p', { class: 'confirm-text', text: conflictWords(currentModified, S.openedAt) }),
    el('p', { class: 'card-note', text: 'Your version is kept until you choose. Copy it first if you want both.' }),
    el('div', { class: 'sheet-actions files-conflict' },
      el('button', { class: 'btn-quiet', type: 'button', text: 'Copy my version', 'data-copy-mine': '1', onclick: () => copyText(mine, copyStatus) }),
      el('button', { class: 'btn-quiet', type: 'button', text: 'Reload theirs', 'data-reload': '1', onclick: async () => {
        closeSheet();
        const p = S.edit.path;
        S.edit = null; S.file = null;
        await openFile(p);
        S.edit = { path: p, text: S.file.content, base: S.file.content, baseModified: S.file.modified, kept: false };
        dropStash(); paint();
      } }),
      el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Overwrite with mine', 'data-overwrite': '1', onclick: () => { closeSheet(); save(page.querySelector('.files-status') || status, { force: true }); } })),
    copyStatus);
}

document.addEventListener('keydown', (e) => {
  if (!page || !document.body.contains(page) || !S.edit || sheetIsOpen()) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); const s = page.querySelector('.files-status'); if (s) save(s); }
  else if (e.key === 'Escape') { e.preventDefault(); const s = page.querySelector('.files-status'); cancelEdit(s); }
});

// ── the "…" menu ──────────────────────────────────────────────────────────
function moreSheet(f) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const link = `${location.origin}/dashboard/console/${fileHash(f.path)}`;
  const text = typeof f.content === 'string' ? f.content : null;
  sheet({ title: f.name },
    el('p', { class: 'card-line', text: f.path }),
    el('div', { class: 'sheet-actions files-menu' },
      text != null ? el('button', { class: 'btn-quiet', type: 'button', text: 'Copy text', 'data-copy-text': '1', onclick: () => copyText(text, status) }) : null,
      el('button', { class: 'btn-quiet', type: 'button', text: 'Copy link', 'data-copy-link': '1', onclick: () => copyText(link, status) }),
      el('button', { class: 'btn-quiet', type: 'button', text: 'Download', 'data-download': '1', onclick: () => download(f.path, status) }),
      el('a', { class: 'btn-quiet', href: fileHash(f.path), target: '_blank', rel: 'noopener noreferrer', text: 'Open in new tab' })),
    status,
    el('p', { class: 'card-note', text: 'The link opens this file in the console; whoever opens it still needs your PIN.' }));
}

// ── folder access ─────────────────────────────────────────────────────────
async function accessSheet() {
  const body = el('div', { class: 'files-access-body' }, el('p', { class: 'empty-line', text: 'Loading…' }));
  sheet({ title: 'Which folders can be browsed and edited' }, body);
  S.config = buildConfig(await call('GET', '/api/files/config'));
  fillAccess(body);
}

function fillAccess(body) {
  const c = S.config;
  if (!c.ok) { setKids(body, el('p', { class: 'card-line', text: `Can’t tell: ${c.text}` })); return; }
  const status = el('p', { class: 'action-status', role: 'status' });
  const apply = async (which, op, value) => {
    status.textContent = 'Saving…';
    const r = await call('PATCH', '/api/files/config', configPatch(c, which, op, value));
    const w = configResultWords(r.status, r.data);
    if (w.ok) {
      S.config = buildConfig({ status: 200, data: { ...r.data, maxFileSize: c.maxFileSize, maxEditableFileSize: c.maxEditableFileSize } });
      S.listings = {}; S.file = null; // what can be seen may have changed
      fillAccess(body);
      body.querySelector('.action-status').textContent = 'Saved.';
      const [root, cl, ins] = await Promise.all([listOf(''), listOf('.claude'), listOf('.instar')]);
      S.listings[''] = root; if (cl.ok) S.listings['.claude'] = cl; if (ins.ok) S.listings['.instar'] = ins;
      paint();
    } else status.textContent = w.text;
  };
  const listBlock = (which, title, rows, emptyWords) => {
    const input = el('input', { class: 'reason-input mono', type: 'text', placeholder: 'docs/', 'aria-label': `Add a folder to ${title.toLowerCase()}`, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    return el('section', { class: 'files-access-list', 'data-list': which },
      el('h3', { class: 'eyebrow', text: title }),
      rows.length ? el('ul', { class: 'key-names files-paths' }, rows.map((r) => el('li', {}, el('span', { text: r.label }),
        el('button', { class: 'link-btn', type: 'button', text: 'Remove', 'data-remove': r.value, 'aria-label': `Remove ${r.label}`, onclick: () => confirmRemove(which, r, apply) })))) : el('p', { class: 'empty-line', text: emptyWords }),
      el('div', { class: 'files-add' }, input, el('button', { class: 'btn-quiet', type: 'button', text: 'Add', 'data-add': which, onclick: () => {
        const v = folderInput(input.value);
        if (!v.ok) { status.textContent = v.text; input.focus(); return; }
        apply(which, 'add', v.value);
      } })));
  };
  setKids(body,
    c.enabled ? null : el('p', { class: 'vault-bad', text: 'The file viewer is switched off on this agent.' }),
    listBlock('allowed', 'Can be browsed', c.allowedRows, 'No folder can be browsed.'),
    listBlock('editable', 'Can be edited', c.editableRows, 'No folder can be edited.'),
    status,
    el('section', { class: 'files-access-list files-fixed' },
      el('h3', { class: 'eyebrow', text: 'Fixed, whatever is set above' }),
      el('ul', { class: 'files-fixed-list' },
        [...new Map(NEVER_EDITABLE.map((n) => [n.why, n])).values()].map((n) => el('li', {}, el('span', { class: 'mono', text: NEVER_EDITABLE.filter((m) => m.why === n.why).map((m) => m.prefix).join(', ') }), document.createTextNode(` — ${n.why}`))),
        el('li', { text: NEVER_SHOWN_WORDS }))),
    c.limitsLine ? note(c.limitsLine) : null);
}

function confirmRemove(which, row, apply) {
  const box = el('div', { class: 'confirm' },
    el('p', { class: 'confirm-text', text: which === 'allowed' ? `${row.label} will no longer be browsable here.` : `${row.label} will no longer be editable here.` }),
    el('div', { class: 'confirm-row' },
      el('button', { class: 'btn-quiet', type: 'button', text: 'Keep it', onclick: () => box.remove() }),
      el('button', { class: 'btn-danger', type: 'button', text: 'Remove', 'data-remove-confirm': row.value, onclick: () => apply(which, 'remove', row.value) })));
  const list = document.querySelector(`.files-access-list[data-list="${which}"]`);
  if (list) list.append(box);
}
