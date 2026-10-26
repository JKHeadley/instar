// Files — pure view-model
// (docs/specs/console-features/people-settings.md, "Files", legacy tab id `files`).
//
// Every decision lives here so it can be tested: folder and file paths, the folder list
// (and when it was cut short), what an opened file is (text, markdown, binary, image,
// too large, refused), whether it can be edited and why not, the save body and the
// server's answer (a 409 conflict, a 401 that keeps the edit), the recent list, the
// pinned files, the name search over folders already opened, and the folder-access
// settings body. Every route here is adapter (a): the bearer token is enough (plus the
// `X-Instar-Request: 1` header the save and settings routes ask for), so no PIN is
// ever asked. A refusal from the server (key material, a blocked file name, a folder
// that is not allowed) is shown in words, never hidden.

export const RECENT_KEY = 'instar_console_files_recent';
export const STASH_KEY = 'instar_edit_stash';           // shared with the legacy dashboard
export const RECENT_MAX = 8;
export const STASH_MAX_AGE_MS = 10 * 60_000;
export const LIST_LIMIT = 500;                           // the server stops a folder at 500
export const HIGHLIGHT_MAX_CHARS = 200_000;              // the legacy guard, kept
export const HIGHLIGHT_MAX_LINES = 2_000;

/** The agent's key files, offered as Pinned when they exist. */
export const PINNED_CANDIDATES = ['CLAUDE.md', '.claude/CLAUDE.md', '.instar/AGENT.md', '.instar/MEMORY.md', 'AGENT.md', 'MEMORY.md'];

/**
 * What the server never lets this page change or show, whatever the settings say.
 * Kept in step with NEVER_EDITABLE_PREFIXES in src/server/fileRoutes.ts by a unit test.
 */
export const NEVER_EDITABLE = [
  { prefix: '.claude/hooks/', why: 'Hooks and scripts are never editable here.' },
  { prefix: '.claude/scripts/', why: 'Hooks and scripts are never editable here.' },
  { prefix: 'node_modules/', why: 'Installed packages are never editable here.' },
  { prefix: '.instar/jobs/instar/', why: 'Built-in jobs are replaced on every update, so they are never editable here.' },
  { prefix: '.instar/config.json', why: 'The agent’s settings file is never editable here; ask the agent to change a setting.' },
];
export const NEVER_SHOWN_WORDS = 'Key material (the agent’s identity and machine keys, the key vault, signed-in account records) and files named like secrets (.env, *.key, *.pem, credentials, tokens) are never listed, shown or downloaded.';

const LANG = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', css: 'css',
  html: 'html', xml: 'xml', sql: 'sql', md: 'markdown',
  toml: 'toml', ini: 'ini', dockerfile: 'dockerfile',
};
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// ── paths ─────────────────────────────────────────────────────────────────

/** A path as the server knows it: relative, forward slashes, no "./", no trailing slash. "" = the top. */
export function normPath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');
}
export function joinPath(dir, name) { const d = normPath(dir); return d ? `${d}/${name}` : normPath(name); }
export function parentOf(p) { const n = normPath(p); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); }
export function baseName(p) { const n = normPath(p); return n.slice(n.lastIndexOf('/') + 1); }
/** Folder crumbs above a path: "docs/specs/x.md" → [{name:'docs',path:'docs'},{name:'specs',path:'docs/specs'}]. */
export function crumbs(p) {
  const parts = normPath(p).split('/').filter(Boolean);
  return parts.slice(0, -1).map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}
/** The folder line under a file name: "docs/specs/" or "top folder". */
export function folderWords(p) { const d = parentOf(p); return d ? `${d}/` : 'top folder'; }

/** The console address of a file: #/settings/files?path=… */
export function fileHash(p) { return `#/settings/files?path=${encodeURIComponent(normPath(p))}`; }
/** The path asked for in a console hash (or a legacy `?tab=files&path=` query), else "". */
export function pathFromHash(hash) {
  const q = String(hash || '').split('?')[1] || '';
  try { return normPath(new URLSearchParams(q).get('path') || ''); } catch { return ''; }
}

export function sizeWords(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
export function timeWords(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** What kind of file a name is: markdown, an image, or text/code (language or null). */
export function fileKind(name) {
  const n = baseName(name).toLowerCase();
  const ext = n.includes('.') ? n.split('.').pop() : n;
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', language: 'markdown' };
  if (IMAGE[ext]) return { kind: 'image', mime: IMAGE[ext] };
  return { kind: 'code', language: LANG[ext] || null };
}

// ── the server's refusals, in words ───────────────────────────────────────

/** Any non-200 from a file route → { kind, text }. A refusal is said, never hidden. */
export function refusalWords(status, data) {
  const err = data && typeof data.error === 'string' ? data.error : '';
  if (status === 401) return { kind: 'signin', text: 'You are signed out. Sign in again to open this.' };
  if (status === 404 && /disabled/i.test(err)) return { kind: 'off', text: 'The file viewer is switched off on this agent.' };
  if (status === 404) return { kind: 'missing', text: 'There is no file or folder at this path.' };
  if (status === 413) return { kind: 'too-large', text: `This file is ${sizeWords(data && data.size) || 'too large'}, more than the ${sizeWords(data && data.maxSize) || 'size'} this page can open or download.` };
  if (status === 403) {
    if (/not permitted/i.test(err)) return { kind: 'never-shown', text: 'This file is never shown, by design. It holds key material the agent keeps to itself.' };
    if (/blocked for security/i.test(err)) return { kind: 'never-shown', text: 'This file is never shown, by design. Its name marks it as a secret (.env, a key, credentials or a token).' };
    if (/not in allowed|resolved path not in allowed/i.test(err)) return { kind: 'not-allowed', text: 'This folder is not one you have allowed this page to browse. You can change that under “Which folders can be browsed and edited”.' };
    if (/outside project root|traversal|absolute/i.test(err)) return { kind: 'not-allowed', text: 'That path is outside the project, so it is never shown.' };
    if (/never editable/i.test(err)) return { kind: 'never-editable', text: 'This file is never editable here, by design.' };
    if (/not in an editable path/i.test(err)) return { kind: 'not-editable', text: 'This file is outside the folders you have allowed editing.' };
    if (/CSRF/i.test(err)) return { kind: 'other', text: 'The request was refused (the safety header was missing).' };
    return { kind: 'other', text: err ? `Refused: ${err}.` : 'The server refused this.' };
  }
  if (status === 0) return { kind: 'unreachable', text: 'The server could not be reached.' };
  if (status === 503) return { kind: 'off', text: 'The file viewer is switched off on this agent.' };
  return { kind: 'other', text: err ? `The server answered ${status}: ${err}.` : `The server answered ${status}.` };
}

// ── folders ───────────────────────────────────────────────────────────────

/** GET /api/files/list → { ok, path, entries, truncated, total, cut } or { ok:false, ...refusal }. */
export function buildListing(res, dir = '') {
  if (!res || res.status !== 200 || !res.data || !Array.isArray(res.data.entries)) {
    return { ok: false, path: normPath(dir), ...refusalWords(res ? res.status : 0, res && res.data) };
  }
  const base = normPath(res.data.path != null ? res.data.path : dir);
  const entries = res.data.entries
    .filter((e) => e && typeof e.name === 'string' && (e.type === 'file' || e.type === 'directory'))
    .map((e) => ({ name: e.name, type: e.type, path: joinPath(base, e.name), size: e.size, modified: e.modified, sub: e.type === 'file' ? [sizeWords(e.size)].filter(Boolean).join('') : '' }));
  const truncated = res.data.truncated === true;
  const total = Number.isFinite(res.data.totalEntries) ? res.data.totalEntries : null;
  // The top folder is cut at 500 with no flag; a full 500 there may be a cut list.
  const maybeCut = !truncated && entries.length >= LIST_LIMIT;
  let cut = null;
  if (truncated) cut = `Showing the first ${LIST_LIMIT}${total ? ` of ${total}` : ''}. Find a file by name to reach the rest.`;
  else if (maybeCut) cut = `Showing the first ${LIST_LIMIT}; there may be more. Find a file by name to reach the rest.`;
  return { ok: true, path: base, entries, truncated: truncated || maybeCut, total, cut, empty: entries.length === 0 ? (base ? 'This folder is empty, or everything in it is hidden by design.' : 'No folders are set up for browsing. Add one under “Which folders can be browsed and edited”.') : null };
}

// ── an opened file ────────────────────────────────────────────────────────

/**
 * GET /api/files/read → what the viewer shows.
 * kind: 'markdown' | 'code' | 'binary' | 'refused'. Refused carries the server's reason in words.
 */
export function buildFile(res, p, config = {}) {
  const path = normPath(p);
  const name = baseName(path);
  const head = { path, name, folder: folderWords(path), crumbs: crumbs(path) };
  if (!res || res.status !== 200 || !res.data) return refused(head, refusalWords(res ? res.status : 0, res && res.data));
  const d = res.data;
  const k = fileKind(name);
  if (d.binary === true) {
    return { ...head, kind: 'binary', size: d.size, modified: d.modified, sizeLine: `${sizeWords(d.size)}${k.kind === 'image' ? ` · ${k.mime.replace('image/', '').toUpperCase()} image` : ' · not text'}`, image: k.kind === 'image' ? k.mime : null, canDownload: true };
  }
  if (typeof d.content !== 'string') return refused(head, { kind: 'other', text: 'The server answered without the file’s text.' });
  const content = d.content;
  const lines = content === '' ? 0 : content.split('\n').length;
  const big = content.length > HIGHLIGHT_MAX_CHARS || lines > HIGHLIGHT_MAX_LINES;
  const ro = readOnly(path, d.editable === true, d.size, config);
  return {
    ...head,
    kind: k.kind === 'markdown' && !big ? 'markdown' : 'code',
    language: k.kind === 'markdown' ? 'markdown' : k.language,
    content, lines, size: d.size, modified: d.modified,
    highlight: !big,
    bigNote: big ? `This file is long (${lines.toLocaleString()} lines), so it opens as plain source without colours or formatting.` : null,
    editable: ro.editable, readOnlyWhy: ro.why,
  };
}

const REFUSAL_TITLE = {
  'never-shown': 'Never shown, by design', 'not-allowed': 'Not in a folder you allow', missing: 'Not found',
  'too-large': 'Too large to open here', signin: 'Signed out', off: 'The file viewer is off', unreachable: 'No answer',
};
/** A file the server would not give: kind 'refused', which refusal, a title and the reason. */
function refused(head, r) { return { ...head, kind: 'refused', refusal: r.kind, title: REFUSAL_TITLE[r.kind] || 'Can’t open this file', text: r.text }; }

/** Can this file be edited here, and if not, why (in words). */
export function readOnly(p, serverEditable, size, config = {}) {
  const path = normPath(p);
  const lower = path.toLowerCase();
  const hit = NEVER_EDITABLE.find((n) => lower === n.prefix.replace(/\/$/, '').toLowerCase() || lower.startsWith(n.prefix.toLowerCase()));
  if (hit) return { editable: false, why: hit.why };
  if (!serverEditable) return { editable: false, why: 'This file is outside the folders you have allowed editing.' };
  const max = Number.isFinite(config.maxEditableFileSize) ? config.maxEditableFileSize : null;
  if (max != null && Number.isFinite(size) && size > max) return { editable: false, why: `This file is ${sizeWords(size)}; files over ${sizeWords(max)} can be read here but not edited.` };
  return { editable: true, why: null };
}

// ── saving ────────────────────────────────────────────────────────────────

/** POST /api/files/save body. `force` drops expectedModified (Overwrite with mine). */
export function saveBody(p, content, expectedModified, { force = false } = {}) {
  const body = { path: normPath(p), content: String(content) };
  if (!force && typeof expectedModified === 'string' && expectedModified) body.expectedModified = expectedModified;
  return body;
}

/** The server's answer to a save, in words. */
export function saveResult(status, data) {
  if (status === 200 && data && data.success) return { ok: true, modified: data.modified, text: 'Saved.' };
  if (status === 409) return { ok: false, conflict: true, currentModified: data && data.currentModified, text: 'This file changed since you opened it.' };
  if (status === 401) return { ok: false, signin: true, text: 'You were signed out. Your unsaved edit was kept — sign in to save it.' };
  if (status === 413) return { ok: false, text: `Too large to save here: ${sizeWords(data && data.size)} is over the ${sizeWords(data && data.maxSize)} limit for editing.` };
  return { ok: false, text: refusalWords(status, data).text };
}

/** The conflict sentence: when the file changed, and when you opened it. */
export function conflictWords(currentModified, openedAt) {
  const changed = timeWords(currentModified);
  const opened = timeWords(openedAt);
  return `This file changed since you opened it${changed ? ` (changed ${changed}` : ''}${changed && opened ? `; you opened it at ${opened})` : changed ? ')' : ''}.`;
}

// ── the kept edit (same key and shape as the legacy dashboard) ────────────

export function stashFor(p, content, now = Date.now()) { return JSON.stringify({ path: normPath(p), content: String(content), timestamp: now }); }
/** A kept edit for this path, if it is under 10 minutes old; else null. */
export function readStash(raw, p, now = Date.now()) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s.content !== 'string' || typeof s.path !== 'string') return null;
    if (!Number.isFinite(s.timestamp) || now - s.timestamp > STASH_MAX_AGE_MS) return null;
    if (p != null && normPath(s.path) !== normPath(p)) return null;
    return { path: normPath(s.path), content: s.content, at: s.timestamp };
  } catch { return null; }
}

// ── recent and pinned ─────────────────────────────────────────────────────

export function parseRecent(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && normPath(x)).map(normPath).slice(0, RECENT_MAX) : []; } catch { return []; }
}
/** Put a path at the front of the recent list, de-duplicated, at most 8. */
export function pushRecent(list, p) {
  const n = normPath(p);
  if (!n) return list.slice(0, RECENT_MAX);
  return [n, ...list.filter((x) => x !== n)].slice(0, RECENT_MAX);
}
export function recentRows(list) { return list.map((p) => ({ key: `recent:${p}`, main: baseName(p), sub: folderWords(p), path: p })); }

/** Pinned: the candidates that exist in the folders already listed. listings: { dir → listing }. */
export function pinnedFrom(listings) {
  const seen = new Set();
  const out = [];
  for (const c of PINNED_CANDIDATES) {
    const l = listings[parentOf(c)];
    if (!l || !l.ok) continue;
    if (!l.entries.some((e) => e.type === 'file' && e.name === baseName(c))) continue;
    const name = baseName(c);
    if (seen.has(name) && name === 'CLAUDE.md') continue; // one CLAUDE.md is enough
    seen.add(name);
    out.push({ key: `pinned:${c}`, main: name, sub: folderWords(c), path: c });
  }
  return out;
}

// ── finding a file by name ────────────────────────────────────────────────

/** Name match over the folders already opened (the server has no search route yet): files first, shallow first. */
export function searchLoaded(listings, q, limit = 50) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { query: '', rows: [], searched: 0, more: 0 };
  const rows = [];
  let searched = 0;
  for (const l of Object.values(listings)) {
    if (!l || !l.ok) continue;
    searched++;
    for (const e of l.entries) if (e.name.toLowerCase().includes(needle)) rows.push({ key: `find:${e.path}`, main: e.name, sub: e.type === 'directory' ? `folder · ${folderWords(e.path)}` : folderWords(e.path), path: e.path, type: e.type });
  }
  const depth = (p) => p.split('/').length;
  rows.sort((a, b) => (a.type === b.type ? 0 : a.type === 'file' ? -1 : 1) || depth(a.path) - depth(b.path) || a.main.localeCompare(b.main) || a.path.localeCompare(b.path));
  return { query: needle, rows: rows.slice(0, limit), searched, more: Math.max(0, rows.length - limit), note: `Searched the ${searched} ${searched === 1 ? 'folder' : 'folders'} opened so far. Open a folder to search inside it too.` };
}

// ── folder access settings ────────────────────────────────────────────────

/** GET /api/files/config → the folders allowed for browsing and editing. */
export function buildConfig(res) {
  if (!res || res.status !== 200 || !res.data) return { ok: false, ...refusalWords(res ? res.status : 0, res && res.data) };
  const d = res.data;
  const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  const words = (p) => (normPath(p) === '' ? 'The whole project' : `${normPath(p)}/`);
  const allowed = list(d.allowedPaths);
  const editable = list(d.editablePaths);
  return {
    ok: true, enabled: d.enabled !== false, allowed, editable,
    allowedRows: allowed.map((p) => ({ value: p, label: words(p) })),
    editableRows: editable.map((p) => ({ value: p, label: words(p) })),
    maxFileSize: d.maxFileSize, maxEditableFileSize: d.maxEditableFileSize,
    limitsLine: Number.isFinite(d.maxFileSize) ? `Files up to ${sizeWords(d.maxFileSize)} open here; up to ${sizeWords(d.maxEditableFileSize)} can be edited.` : null,
  };
}

/** A folder typed into the settings sheet → the value the server accepts, or why not. */
export function folderInput(v) {
  const raw = String(v || '').trim();
  if (!raw) return { ok: false, text: 'Type a folder, for example docs/.' };
  if (raw.startsWith('/') || raw.startsWith('~')) return { ok: false, text: 'Use a folder inside the project, not a full path.' };
  if (raw.split(/[\\/]/).includes('..')) return { ok: false, text: 'A folder cannot step outside the project.' };
  const n = normPath(raw);
  return { ok: true, value: n ? `${n}/` : './' };
}

/** PATCH /api/files/config body: add or remove one folder from one list. */
export function configPatch(cfg, which, op, value) {
  const key = which === 'editable' ? 'editablePaths' : 'allowedPaths';
  const cur = which === 'editable' ? cfg.editable : cfg.allowed;
  const same = (a) => normPath(a) === normPath(value);
  const next = op === 'remove' ? cur.filter((p) => !same(p)) : cur.some(same) ? cur.slice() : [...cur, value];
  return { [key]: next };
}

export function configResultWords(status, data) {
  if (status === 200 && data && data.updated) return { ok: true, text: 'Saved.' };
  if (status === 501) return { ok: false, text: 'Folder settings cannot be changed from here on this agent. Ask the agent to change them.' };
  if (status === 400) return { ok: false, text: data && data.error ? String(data.error) : 'The server refused that folder.' };
  return { ok: false, text: refusalWords(status, data).text };
}

// ── page head ─────────────────────────────────────────────────────────────

/** The headline: plain on arrival; said only when something is wrong. */
export function filesHeadline({ root, machine }) {
  if (root && !root.ok) return { text: root.kind === 'off' ? 'The file viewer is switched off.' : 'Can’t read the file list.', tone: root.kind === 'off' ? 'unknown' : 'bad', sub: root.text };
  return { text: 'Open a file, or find one by name.', tone: 'ok', sub: machine ? `Files on ${machine}.` : null };
}

/** Repository machinery (dot-folders, dependencies, build output) that Browse keeps behind "Show system files". */
export function isSystemEntry(e) {
  const name = String(e && e.name || '');
  return name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', '__pycache__'].includes(name);
}
export function splitSystem(listing) {
  const entries = listing && Array.isArray(listing.entries) ? listing.entries : [];
  return { plain: entries.filter((e) => !isSystemEntry(e)), system: entries.filter(isSystemEntry) };
}

// ── finding a file across the whole project (GET /api/files/search) ──────

export const SEARCH_LIMIT = 50;
/** The search route's address for a query. */
export function searchUrl(q, limit = SEARCH_LIMIT) {
  return `/api/files/search?q=${encodeURIComponent(String(q || '').trim())}&limit=${limit}`;
}

/**
 * GET /api/files/search → rows like searchLoaded's, or `{ unsupported: true }` when this
 * server is older and has no search route (a 404 that is not "the file viewer is off"),
 * so the page falls back to searching the folders it already opened.
 */
export function buildSearch(res, q) {
  const query = String(q || '').trim().toLowerCase();
  if (!res || res.status !== 200 || !res.data || !Array.isArray(res.data.results)) {
    const status = res ? res.status : 0;
    const err = res && res.data && typeof res.data.error === 'string' ? res.data.error : '';
    if (status === 404 && !/disabled/i.test(err)) return { ok: false, unsupported: true, query };
    return { ok: false, unsupported: false, query, ...refusalWords(status, res && res.data) };
  }
  const rows = res.data.results
    .filter((e) => e && typeof e.path === 'string' && typeof e.name === 'string' && (e.type === 'file' || e.type === 'directory'))
    .map((e) => {
      const p = normPath(e.path);
      return { key: `find:${p}`, main: e.name, sub: e.type === 'directory' ? `folder · ${folderWords(p)}` : folderWords(p), path: p, type: e.type };
    });
  const truncated = res.data.truncated === true;
  return {
    ok: true, query, rows, truncated, more: 0,
    note: truncated ? `Showing the first ${rows.length} matches; type more of the name to narrow it.` : rows.length ? 'Searched every folder you allow this page to browse.' : null,
    empty: rows.length ? null : 'No file or folder by that name in the folders you allow.',
  };
}

// ── image preview ─────────────────────────────────────────────────────────

/** Largest image this page previews (the server's own read limit may be lower). */
export const IMAGE_PREVIEW_MAX = 5 * 1_048_576;

/**
 * Should an opened binary file be previewed? Only the raster types the page knows
 * (PNG, JPEG, GIF, WebP — never SVG), and only up to 5 MB and the server's own limit.
 */
export function previewPlan(f, config = {}) {
  if (!f || f.kind !== 'binary' || !f.image) return { preview: false, why: null };
  const serverMax = Number.isFinite(config.maxFileSize) ? config.maxFileSize : Infinity;
  const max = Math.min(IMAGE_PREVIEW_MAX, serverMax);
  if (!Number.isFinite(f.size) || f.size <= 0) return { preview: false, why: 'This image is empty, so there is nothing to preview.' };
  if (f.size > max) return { preview: false, why: `This image is ${sizeWords(f.size)}; images over ${sizeWords(max)} are not previewed here. Download it to look at it.` };
  return { preview: true, why: null };
}

/** The real image type from the file's first bytes, or null (a renamed non-image is never shown). */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** The downloaded bytes → what to show: an image of the sniffed type, or why not. */
export function previewResult(status, bytes) {
  if (status !== 200) return { ok: false, text: refusalWords(status, {}).text };
  const len = bytes ? bytes.byteLength : 0;
  if (len > IMAGE_PREVIEW_MAX) return { ok: false, text: `This image is ${sizeWords(len)}; images over ${sizeWords(IMAGE_PREVIEW_MAX)} are not previewed here.` };
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, text: 'This file is named like an image but is not one, so it is not shown.' };
  return { ok: true, mime };
}
